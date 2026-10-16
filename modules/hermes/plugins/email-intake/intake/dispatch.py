"""Hand classified email to the trackers (issue #783 live dispatch, #796 rehearsal).

One email (one evidence hash) becomes one signed request per booking leg:

    actual_budget/transaction -> expense-tracker  POST /process/transaction
    actual_budget/statement   -> expense-tracker  POST /process/statement
    portfolio                 -> portfolio-tracker POST /process/portfolio
    both                      -> the transaction leg and the portfolio leg

The request_id is derived from the evidence hash and the leg, so copies of
one email in several folders, and every retry, reuse one request_id: the
trackers book a request at most once and replay its stored result.

Two modes share this code:

- "rehearsal" (shadow mode): each new expense transaction leg is sent as a
  signed dry run. Nothing is booked, the mailbox is never written, and the
  planned booking is recorded for the cutover comparison.
- "live": the request books. INBOX mail the old watcher already booked (UID
  at or below the handoff boundary read from its dedup journal) is never
  sent. After every leg of an email ends without failing, its INBOX copies
  are marked read, as the old watcher did. A failed email stays unread.

Live mode only starts when the handoff boundary is known; otherwise nothing is
dispatched (fail closed). Results are stored in the intake journal, never the
email body.
"""

import base64
import hashlib
import hmac
import json
import logging
import sqlite3
import time
import urllib.request

logger = logging.getLogger(__name__)

EXPENSE = "expense"
PORTFOLIO = "portfolio"
ROUTED_STATUSES = ("shadow_actual_budget", "shadow_portfolio", "shadow_both")
MAX_ATTEMPTS = 3
TERMINAL_OK = ("processed", "duplicate", "needs_confirmation", "skipped", "handed_off")
INBOX = "INBOX"


def legs(decision):
    """The (kind, service) requests one classified email needs."""
    destination = (decision or {}).get("destination")
    subtype = (decision or {}).get("subtype") or "transaction"
    if destination == "actual_budget":
        return [("statement" if subtype == "statement" else "transaction", EXPENSE)]
    if destination == "portfolio":
        return [("portfolio", PORTFOLIO)]
    if destination == "both":
        return [("transaction", EXPENSE), ("portfolio", PORTFOLIO)]
    return []


def request_id(mode, kind, evidence_hash):
    prefix = "rehearse" if mode == "rehearsal" else "intake"
    return f"{prefix}:{kind}:{evidence_hash[:64]}"


def sign(kind, body, secret):
    """The trackers' X-Process-Signature (expense/portfolio src/processing.js)."""
    evidence = body.get("evidence", {}).get("raw_email_b64", "")
    digest = hashlib.sha256(evidence.encode()).hexdigest()
    signed_kind = f"{kind}:dry_run" if body.get("dry_run") else kind
    message = f"{signed_kind}:{body['request_id']}:{digest}".encode()
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def http_post(url, body, headers, timeout=600):
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def read_handoff_boundary(dedup_db, inbox_uidvalidity):
    """The highest INBOX UID the old watcher booked, or None when it cannot be trusted."""
    try:
        db = sqlite3.connect(f"file:{dedup_db}?mode=ro", uri=True)
    except sqlite3.Error:
        return None
    try:
        row = db.execute("SELECT value FROM mailbox_state WHERE key = 'uidvalidity'").fetchone()
        if not row or str(row[0]).strip() != str(inbox_uidvalidity):
            return None
        top = db.execute("SELECT MAX(CAST(uid AS INTEGER)) FROM booked_messages").fetchone()
        return int(top[0] or 0)
    except (sqlite3.Error, TypeError, ValueError):
        return None
    finally:
        db.close()


def _quote(folder):
    return '"' + folder.replace("\\", "\\\\").replace('"', '\\"') + '"'


class ImapMailbox:
    """Fetches one email by location; marks INBOX mail read only when asked (live mode)."""

    def __init__(self, connect):
        self._connect = connect
        self._imap = None

    def _open(self, folder, uidvalidity, readonly):
        if self._imap is None:
            self._imap = self._connect()
        status, _ = self._imap.select(_quote(folder), readonly=readonly)
        if status != "OK":
            return False
        _, values = self._imap.response("UIDVALIDITY")
        try:
            return int((values or [b"0"])[0]) == int(uidvalidity)
        except (TypeError, ValueError):
            return False

    def fetch(self, folder, uidvalidity, uid):
        if not self._open(folder, uidvalidity, readonly=True):
            return None
        status, data = self._imap.uid("FETCH", str(uid), "(BODY.PEEK[])")
        if status != "OK":
            return None
        return next((item[1] for item in data or [] if isinstance(item, tuple)), None)

    def mark_seen(self, folder, uidvalidity, uid):
        if folder != INBOX or not self._open(folder, uidvalidity, readonly=False):
            return False
        status, _ = self._imap.uid("STORE", str(uid), "+FLAGS", "(\\Seen)")
        return status == "OK"

    def close(self):
        if self._imap is not None:
            try:
                self._imap.logout()
            except Exception:  # noqa: BLE001
                pass
            self._imap = None


def _rehearsal_record(response):
    writes = response.get("writes") or []
    plan = next((w.get("args") or {} for w in writes if w.get("tool") == "insert_transaction"), None)
    return {
        "status": response.get("status", ""),
        "action": response.get("action", ""),
        "reason": response.get("reason", ""),
        "would_be_duplicate": any(w.get("would_be_duplicate") for w in writes if w.get("tool") == "check_duplicate"),
        "plan": None if plan is None else {k: plan.get(k) for k in
                                           ("budget_id", "account_id", "date", "amount_cents", "payee_id",
                                            "category_id", "imported_description")},
    }


def _live_record(response):
    keep = ("status", "action", "reason", "details", "messages", "mapping_candidate", "transaction_id", "bookings")
    return {k: response[k] for k in keep if k in response}


class Dispatcher:
    def __init__(self, journal, mailbox, post, secret, urls, account, mode,
                 boundary=None, clock=time.time):
        """`boundary()` returns the old watcher's handoff UID for INBOX, or None (live only)."""
        if mode not in ("rehearsal", "live"):
            raise ValueError(mode)
        self._journal = journal
        self._mailbox = mailbox
        self._post = post
        self._secret = secret
        self._urls = urls
        self._account = account
        self._mode = mode
        self._boundary = boundary
        self._clock = clock

    def _legs(self, decision):
        found = legs(decision)
        if self._mode == "rehearsal":
            # Dry runs exist for expense transactions only.
            return [leg for leg in found if leg == ("transaction", EXPENSE)]
        return found

    def _start(self):
        """When this mode began, and the INBOX boundary for live; None while it cannot start."""
        since = self._journal.get_state(f"{self._mode}_since")
        if self._mode == "rehearsal":
            if since is None:
                since = self._clock()
                self._journal.set_state("rehearsal_since", since)
            return float(since), None
        if since is None:
            inbox_validity, _ = self._journal.folder_state(self._account, INBOX)
            top = self._boundary(inbox_validity) if (self._boundary and inbox_validity is not None) else None
            if top is None:
                return None
            self._journal.set_state("live_inbox_boundary", json.dumps([inbox_validity, top]))
            since = self._clock()
            self._journal.set_state("live_since", since)
        validity, top = json.loads(self._journal.get_state("live_inbox_boundary"))
        return float(since), (int(validity), int(top))

    def prepare(self):
        """Record when this mode began (and, for live, the handoff boundary) if not yet known."""
        return self._start()

    def run(self):
        summary = {"mode": self._mode, "sent": 0, "ok": 0, "failed": 0, "retry": 0, "handed_off": 0}
        started = self._start()
        if started is None:
            summary["blocked"] = "no_handoff_boundary"
            logger.warning("email-intake live dispatch waits: no trusted handoff boundary")
            return summary
        since, boundary = started
        try:
            for evidence_hash, decision, locations in self._journal.routed(self._account, ROUTED_STATUSES):
                self._one(evidence_hash, decision, locations, since, boundary, summary)
        finally:
            self._mailbox.close()
        return summary

    def _eligible(self, locations, since, boundary):
        if any(updated >= since for _, _, _, updated in locations):
            return True
        if boundary is None:
            return False
        validity, top = boundary
        return any(f == INBOX and v == validity and u > top for f, v, u, _ in locations)

    def _handed_off(self, locations, boundary):
        if boundary is None:
            return False
        validity, top = boundary
        return any(f == INBOX and v == validity and u <= top for f, v, u, _ in locations)

    def _one(self, evidence_hash, decision, locations, since, boundary, summary):
        todo = []
        for kind, service in self._legs(decision):
            row = self._journal.dispatch_state(evidence_hash, kind, self._mode)
            if row is None or row["status"] == "retry":
                todo.append((kind, service, (row or {}).get("attempts", 0)))
        if not todo or not self._eligible(locations, since, boundary):
            return
        if self._mode == "live" and self._handed_off(locations, boundary):
            # The old watcher booked this email before the cutover.
            for kind, _, attempts in todo:
                self._journal.save_dispatch(evidence_hash, kind, self._mode, request_id(self._mode, kind, evidence_hash),
                                            "handed_off", attempts, {})
            summary["handed_off"] += 1
            return
        raw = None
        for folder, validity, uid, _ in locations:
            raw = self._mailbox.fetch(folder, validity, uid)
            if raw:
                break
        if not raw:
            for kind, _, attempts in todo:
                self._save_retry(evidence_hash, kind, attempts, {"reason": "email_missing"}, summary)
            return
        evidence = base64.b64encode(raw).decode()
        for kind, service, attempts in todo:
            self._send(evidence_hash, kind, service, attempts, evidence, summary)
        if self._mode == "live" and self._all_done(evidence_hash, decision):
            for folder, validity, uid, _ in locations:
                if folder == INBOX:
                    self._mailbox.mark_seen(folder, validity, uid)

    def _send(self, evidence_hash, kind, service, attempts, evidence, summary):
        rid = request_id(self._mode, kind, evidence_hash)
        body = {"request_id": rid, "evidence": {"raw_email_b64": evidence}}
        if self._mode == "rehearsal":
            body["dry_run"] = True
        url = f"{self._urls[service]}/process/{kind}"
        summary["sent"] += 1
        try:
            response = self._post(url, body, {"X-Process-Signature": sign(kind, body, self._secret)})
        except Exception as error:  # noqa: BLE001 - one email must not stop the run
            self._save_retry(evidence_hash, kind, attempts, {"reason": type(error).__name__}, summary)
            return
        if not isinstance(response, dict):
            response = {"status": "failed", "reason": "bad_response"}
        status = response.get("status", "failed")
        if self._mode == "rehearsal":
            # A dry run is evidence for the comparison, never retried.
            self._journal.save_dispatch(evidence_hash, kind, self._mode, rid, status, attempts + 1,
                                        _rehearsal_record(response))
            summary["ok" if status == "dry_run" else "failed"] += 1
            return
        if status == "failed" and response.get("reason") == "error":
            # The tracker released the request: the same request_id may be sent again.
            self._save_retry(evidence_hash, kind, attempts, _live_record(response), summary)
            return
        self._journal.save_dispatch(evidence_hash, kind, self._mode, rid, status, attempts + 1, _live_record(response))
        summary["ok" if status in TERMINAL_OK else "failed"] += 1

    def _save_retry(self, evidence_hash, kind, attempts, record, summary):
        attempts += 1
        status = "retry" if attempts < MAX_ATTEMPTS else "failed"
        self._journal.save_dispatch(evidence_hash, kind, self._mode, request_id(self._mode, kind, evidence_hash),
                                    status, attempts, record)
        summary[status] += 1

    def _all_done(self, evidence_hash, decision):
        for kind, _ in self._legs(decision):
            row = self._journal.dispatch_state(evidence_hash, kind, self._mode)
            if row is None or row["status"] not in TERMINAL_OK:
                return False
        return True
