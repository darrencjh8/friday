"""Parity replay for the cutover gate (issue #796).

Each INBOX email the old watcher booked is replayed through expense-tracker's
signed dry run (POST /process/transaction, dry_run: true), and the booking it
would make is compared with the row already in Actual. Nothing is written:
mail is read with BODY.PEEK, dedup.db and Actual are only read, and a dry run
is not journaled.

The summary carries UIDs, sender domains, statuses and field names only, never
amounts, payees or account names.

Run inside the hermes container:
    python3 -m intake.parity --days 30
"""

import argparse
import base64
import hashlib
import hmac
import imaplib
import json
import os
import sqlite3
import sys
import urllib.request
from collections import Counter
from datetime import date, datetime, timedelta, timezone

FIELDS = ("account", "date", "amount", "payee", "category")
DEDUP_DB = "/opt/data/expense-tracker-data/dedup.db"
TRACKER_URL = "http://expense-tracker:8080"


def sign(body, secret):
    """The expense-tracker dry-run signature (src/processing.js signProcessRequest)."""
    evidence = body.get("evidence", {}).get("raw_email_b64", "")
    digest = hashlib.sha256(evidence.encode()).hexdigest()
    message = f"transaction:dry_run:{body['request_id']}:{digest}".encode()
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def booked(db_path, since):
    """UIDVALIDITY and the INBOX UIDs the old watcher booked on or after `since`."""
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        row = db.execute("SELECT value FROM mailbox_state WHERE key = 'uidvalidity'").fetchone()
        uids = [r[0] for r in db.execute(
            "SELECT uid FROM booked_messages WHERE booked_at >= ? ORDER BY uid", (since,))]
    finally:
        db.close()
    return (row[0] if row else None), [int(u) for u in uids]


def _day(value):
    return date.fromisoformat(str(value)[:10])


def _pick(rows, plan):
    """The Actual row this booking corresponds to, and whether it was unique."""
    amount = plan.get("amount_cents")
    try:
        when = _day(plan.get("date"))
    except ValueError:
        return None, False
    near = [r for r in rows if r.get("amount") == amount and abs((_day(r.get("date")) - when).days) <= 1]
    for pool in (
        [r for r in near if r.get("account") == plan.get("account_id") and _day(r.get("date")) == when],
        [r for r in near if r.get("account") == plan.get("account_id")],
        near,
    ):
        if len(pool) == 1:
            return pool[0], True
        if len(pool) > 1:
            return None, True
    return None, False


def compare(writes, rows, payees):
    """Compare a dry run's planned insert with the rows in Actual."""
    duplicate = any(c.get("would_be_duplicate") for c in writes if c.get("tool") == "check_duplicate")
    plan = next((c["args"] for c in writes if c.get("tool") == "insert_transaction"), None)
    if plan is None:
        return {"status": "no_booking_planned", "would_be_duplicate": duplicate}
    row, found = _pick(rows, plan)
    if row is None:
        return {"status": "ambiguous" if found else "no_actual_row", "would_be_duplicate": duplicate}
    payee_name = str(payees.get(row.get("payee"), "")).strip().lower()
    fields = {
        "account": row.get("account") == plan.get("account_id"),
        "date": str(row.get("date"))[:10] == str(plan.get("date"))[:10],
        "amount": row.get("amount") == plan.get("amount_cents"),
        "payee": bool(
            (plan.get("payee_id") and plan.get("payee_id") == row.get("payee"))
            or (payee_name and payee_name == str(plan.get("imported_description", "")).strip().lower())
        ),
        "category": (row.get("category") or None) == (plan.get("category_id") or None),
    }
    # Actual keeps the description a row was booked with; it tells a payee the
    # owner changed later apart from one the pipeline would get wrong.
    original = str(row.get("imported_payee") or "").strip().lower()
    return {
        "status": "matched" if all(fields.values()) else "mismatch",
        "fields": fields,
        "payee_original_match": bool(original) and original == str(plan.get("imported_description", "")).strip().lower(),
        "would_be_duplicate": duplicate,
    }


TO_EXPENSE_TRACKER = ("actual_budget", "both")
JOURNAL_DB = "/opt/data/email-intake/journal.db"


def journal_router(db_path, uidvalidity):
    """Jev's routing for an INBOX UID from the intake shadow journal, or None.

    Live intake asks Jev first; only mail routed to the expense tracker ever
    reaches it, so the replay must not judge mail Jev sends elsewhere.
    """
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)

    def route(uid):
        row = db.execute(
            "SELECT decision FROM messages WHERE folder = 'INBOX' AND uidvalidity = ? AND uid = ? "
            "ORDER BY updated_at DESC LIMIT 1",
            (int(uidvalidity), int(uid)),
        ).fetchone()
        if not row or not row[0]:
            return None
        decision = json.loads(row[0])
        return {"destination": decision.get("destination"), "kind": decision.get("kind")}

    return route


def run(uids, *, uidvalidity, fetch_raw, post, fetch_rows, fetch_payees, route=None):
    """Replay each UID; one result per UID, never raising for a single email."""
    results = []
    payee_cache = {}
    row_cache = {}
    for uid in uids:
        jev = route(uid) if route else None
        if jev and jev.get("destination") not in TO_EXPENSE_TRACKER:
            results.append({"uid": uid, "sender_domain": "", "status": "jev_routes_elsewhere", "jev": jev})
            continue
        raw, domain = fetch_raw(uid)
        result = {"uid": uid, "sender_domain": domain}
        if route:
            result["jev"] = jev
        if not raw:
            results.append({**result, "status": "email_missing"})
            continue
        body = {
            "request_id": f"parity:{uidvalidity}:{uid}",
            "evidence": {"raw_email_b64": base64.b64encode(raw).decode()},
            "dry_run": True,
        }
        try:
            response = post(body)
        except Exception as error:  # noqa: BLE001 — one email must not stop the replay
            results.append({**result, "status": "dry_run_failed", "reason": type(error).__name__})
            continue
        if response.get("status") != "dry_run":
            results.append({**result, "status": "dry_run_failed", "reason": response.get("reason", "")})
            continue
        writes = response.get("writes") or []
        plan = next((c["args"] for c in writes if c.get("tool") == "insert_transaction"), None)
        result["action"] = response.get("action", "")
        if plan is None:
            results.append({**result, **compare(writes, [], {})})
            continue
        budget = plan.get("budget_id", "")
        if budget not in payee_cache:
            payee_cache[budget] = fetch_payees(budget)
            # Every account, so a booking on the wrong account shows as one.
            row_cache[budget] = fetch_rows(budget)
        results.append({**result, **compare(writes, row_cache[budget], payee_cache[budget])})
    return results


def summarize(results):
    """Counts and problem UIDs; field names only, no values."""
    compared = [r for r in results if "fields" in r]
    problems = [
        {
            "uid": r["uid"],
            "sender_domain": r.get("sender_domain", ""),
            "status": r["status"],
            "fields": [f for f in FIELDS if not r.get("fields", {}).get(f, True)],
            **({"notes": ["payee_original_matches"]}
               if r.get("payee_original_match") and not r.get("fields", {}).get("payee", True) else {}),
        }
        for r in results
        if r["status"] not in ("matched", "jev_routes_elsewhere")
    ]
    jev = [r.get("jev") for r in results if "jev" in r]
    return {
        **({"jev": {
            "routes_elsewhere": sum(1 for r in results if r["status"] == "jev_routes_elsewhere"),
            "no_decision": sum(1 for j in jev if j is None),
            "to_expense_tracker": sum(1 for j in jev if j and j.get("destination") in TO_EXPENSE_TRACKER),
        }} if jev else {}),
        "total": len(results),
        "status": dict(Counter(r["status"] for r in results)),
        "field_match": {
            f: f"{sum(1 for r in compared if r['fields'][f])}/{len(compared)}" for f in FIELDS
        },
        "would_be_duplicate": sum(1 for r in results if r.get("would_be_duplicate")),
        "problems": problems,
    }


# ── Production wiring (not unit-tested: IMAP, HTTP) ─────────────────────────

def _http(url, body=None, headers=None, timeout=300):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **(headers or {})},
                                 method="POST" if data is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def _settings_getter():
    """The intake adapter's own source (Hermes scoped secrets), else the environment."""
    try:
        from gateway.platforms._shared import get_scoped_secret
    except ImportError:
        return lambda key: (os.environ.get(key) or "").strip()
    return lambda key: (get_scoped_secret(key, "") or "").strip()


def main(argv=None):
    from email.parser import BytesHeaderParser
    from email.utils import parseaddr

    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--limit", type=int, default=0, help="replay at most this many emails (0 = all)")
    args = parser.parse_args(argv)
    get = _settings_getter()
    secret = get("HERMES_WEBHOOK_SECRET")
    since = (datetime.now(timezone.utc) - timedelta(days=args.days)).strftime("%Y-%m-%d")
    uidvalidity, uids = booked(get("EMAIL_INTAKE_PARITY_DEDUP_DB") or DEDUP_DB, since)
    if args.limit:
        uids = uids[: args.limit]

    imap = imaplib.IMAP4_SSL(get("IMAP_HOST"), int(get("IMAP_PORT") or 993))
    imap.login(get("IMAP_USERNAME"), get("IMAP_PASSWORD"))
    imap.select("INBOX", readonly=True)  # EXAMINE: flags never change
    live = imap.response("UIDVALIDITY")[1][0]
    if str(int(live)) != str(uidvalidity):
        print(json.dumps({"error": "uidvalidity_changed"}))
        return 2

    def fetch_raw(uid):
        status, data = imap.uid("FETCH", str(uid), "(BODY.PEEK[])")
        parts = [p for p in data or [] if isinstance(p, tuple)]
        if status != "OK" or not parts:
            return None, ""
        raw = parts[0][1]
        sender = parseaddr(BytesHeaderParser().parsebytes(raw).get("From", ""))[1]
        return raw, sender.rsplit("@", 1)[-1].lower() if "@" in sender else ""

    tracker = get("EMAIL_INTAKE_PARITY_TRACKER_URL") or TRACKER_URL

    def post(body):
        return _http(f"{tracker}/process/transaction", body, {"X-Process-Signature": sign(body, secret)})

    def fetch_rows(budget_id):
        rows = _http(f"{tracker}/tools/fetch-recent-transactions",
                     {"budget_id": budget_id, "days": args.days + 5})
        return rows if isinstance(rows, list) else []

    def fetch_payees(budget_id):
        rows = _http(f"{tracker}/tools/fetch-payees", {"budget_id": budget_id})
        return {p.get("id"): p.get("name", "") for p in rows} if isinstance(rows, list) else {}

    try:
        route = journal_router(get("EMAIL_INTAKE_PARITY_JOURNAL_DB") or JOURNAL_DB, uidvalidity)
        results = run(uids, uidvalidity=uidvalidity, fetch_raw=fetch_raw, post=post,
                      fetch_rows=fetch_rows, fetch_payees=fetch_payees, route=route)
    finally:
        imap.logout()
    print(json.dumps({"since": since, **summarize(results)}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
