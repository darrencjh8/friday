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
- "live": the request books. On its first run it takes a handoff snapshot
  of INBOX: the UIDs the old watcher booked (its dedup journal) plus every
  UID already read, and the newest UID. The old watcher only ever handled
  unread mail and left an email unread when it reached no verdict (an LLM
  outage, an error), so snapshot mail is never sent, and unread, unbooked
  INBOX mail recorded during shadow is caught up. After every leg of an email
  ends without failing, its INBOX copies are marked read, as the old watcher
  did; a mark that fails is retried on the next run. A failed email stays
  unread.

Live mode only starts when the old watcher's booked list can be trusted (same
INBOX UIDVALIDITY); otherwise nothing is dispatched (fail closed). Results are
stored in the intake journal, never the email body.
"""

import base64
import hashlib
import hmac
import json
import logging
import sqlite3
import time
import urllib.request

from . import mail, notify

logger = logging.getLogger(__name__)

EXPENSE = "expense"
PORTFOLIO = "portfolio"
ROUTED_STATUSES = ("shadow_actual_budget", "shadow_portfolio", "shadow_both")
NOTICE_STATUSES = ("shadow_uncertain", "blocked_encrypted", "shadow_notify")
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


def read_booked_uids(dedup_db, inbox_uidvalidity):
    """The INBOX UIDs the old watcher booked, or None when they cannot be trusted."""
    try:
        db = sqlite3.connect(f"file:{dedup_db}?mode=ro", uri=True)
    except sqlite3.Error:
        return None
    try:
        row = db.execute("SELECT value FROM mailbox_state WHERE key = 'uidvalidity'").fetchone()
        if not row or str(row[0]).strip() != str(inbox_uidvalidity):
            return None
        return {int(r[0]) for r in db.execute("SELECT uid FROM booked_messages")}
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

    def inbox_snapshot(self, uidvalidity):
        """(read UIDs, newest UID) in INBOX, or None when it cannot be read as this UIDVALIDITY."""
        if not self._open(INBOX, uidvalidity, readonly=True):
            return None
        found = []
        for criteria in ("SEEN", "ALL"):
            status, data = self._imap.uid("SEARCH", None, criteria)
            if status != "OK":
                return None
            found.append({int(t) for t in (data[0] or b"").split()} if data else set())
        return found[0], max(found[1], default=0)

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
                 booked=None, clock=time.time):
        """`booked(uidvalidity)` returns the INBOX UIDs the old watcher booked, or None (live only)."""
        if mode not in ("rehearsal", "live"):
            raise ValueError(mode)
        self._journal = journal
        self._mailbox = mailbox
        self._post = post
        self._secret = secret
        self._urls = urls
        self._account = account
        self._mode = mode
        self._booked = booked
        self._clock = clock

    def _legs(self, decision):
        found = legs(decision)
        if self._mode == "rehearsal":
            # Dry runs exist for expense transactions only.
            return [leg for leg in found if leg == ("transaction", EXPENSE)]
        return found

    def _start(self):
        """When this mode began, and the INBOX handoff for live; None while it cannot start."""
        since = self._journal.get_state(f"{self._mode}_since")
        if self._mode == "rehearsal":
            if since is None:
                since = self._clock()
                self._journal.set_state("rehearsal_since", since)
            return float(since), None
        if since is None:
            inbox_validity, _ = self._journal.folder_state(self._account, INBOX)
            if inbox_validity is None or self._booked is None:
                return None
            booked = self._booked(inbox_validity)
            snapshot = self._mailbox.inbox_snapshot(inbox_validity) if booked is not None else None
            self._mailbox.close()
            if snapshot is None:
                return None
            read, newest = snapshot
            handoff = {"uidvalidity": int(inbox_validity), "newest": int(newest),
                       "uids": sorted({u for u in booked | read if u <= newest})}
            self._journal.set_state("live_inbox_handoff", json.dumps(handoff))
            since = self._clock()
            self._journal.set_state("live_since", since)
        handoff = json.loads(self._journal.get_state("live_inbox_handoff"))
        return float(since), (handoff["uidvalidity"], handoff["newest"], set(handoff["uids"]))

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
        since, handoff = started
        try:
            if self._mode == "live":
                self._flush_marks()
            for evidence_hash, decision, locations in self._journal.routed(self._account, ROUTED_STATUSES):
                try:
                    self._one(evidence_hash, decision, locations, since, handoff, summary)
                except Exception as error:  # noqa: BLE001 - one email must not stop the others
                    logger.warning("email-intake dispatch error: %s", type(error).__name__)
                    summary["errors"] = summary.get("errors", 0) + 1
                    self._mailbox.close()  # a dropped connection is reopened for the next email
            if self._mode == "live":
                self._replays(since, handoff, summary)
                self._notices(since, summary)
        finally:
            self._mailbox.close()
        return summary

    def _flush_marks(self):
        for folder, validity, uid in self._journal.pending_marks():
            try:
                done = self._mailbox.mark_seen(folder, validity, uid)
            except Exception as error:  # noqa: BLE001
                logger.warning("email-intake mark-read error: %s", type(error).__name__)
                self._mailbox.close()
                continue
            if done:
                self._journal.clear_mark(folder, validity, uid)

    def _eligible(self, locations, since, handoff):
        if any(updated >= since for _, _, _, updated in locations):
            return True
        if handoff is None:
            return False
        # Shadow-era INBOX mail the old watcher left unread and unbooked: catch it up.
        validity, newest, done = handoff
        return any(f == INBOX and v == validity and (u > newest or u not in done) for f, v, u, _ in locations)

    def _handed_off(self, locations, handoff):
        if handoff is None:
            return False
        validity, newest, done = handoff
        return any(f == INBOX and v == validity and u <= newest and u in done for f, v, u, _ in locations)

    def _replays(self, since, handoff, summary):
        """Uncertain mail the owner chose a destination for with /replay."""
        for evidence_hash, destination, subtype in self._journal.pending_replays():
            decision = {"destination": destination, "subtype": subtype}
            locations = self._journal.locations(self._account, evidence_hash)
            try:
                self._one(evidence_hash, decision, locations, since, handoff, summary, owner_choice=True)
            except Exception as error:  # noqa: BLE001
                logger.warning("email-intake replay error: %s", type(error).__name__)
                self._mailbox.close()
                continue
            if self._final(evidence_hash, decision):
                self._journal.finish_replay(evidence_hash)

    def _notices(self, since, summary):
        """One message for new uncertain, blocked or notify-rule mail; nothing is booked."""
        for evidence_hash, decision, locations in self._journal.routed(self._account, NOTICE_STATUSES):
            key = f"{evidence_hash}:notice"
            if self._journal.has_notification(key) or not any(t >= since for _, _, _, t in locations):
                continue
            try:
                parsed = self._parse(locations)
            except Exception as error:  # noqa: BLE001
                logger.warning("email-intake notice error: %s", type(error).__name__)
                self._mailbox.close()
                continue
            if parsed is None:
                continue
            destination = (decision or {}).get("destination")
            if destination == "notify":
                text = (decision.get("message") or "")[:notify.TELEGRAM_LIMIT]
            elif destination == "uncertain":
                text = notify.review_text(parsed.sender_domain, parsed.subject, evidence_hash)
            else:
                text = notify.blocked_text(parsed.sender_domain, parsed.subject)
            if text:
                self._journal.queue_notification(key, text)
                summary["notices"] = summary.get("notices", 0) + 1

    def _parse(self, locations):
        for folder, validity, uid, _ in locations:
            raw = self._mailbox.fetch(folder, validity, uid)
            if raw:
                return mail.parse(raw)
        return None

    def _final(self, evidence_hash, decision):
        for kind, _ in self._legs(decision):
            row = self._journal.dispatch_state(evidence_hash, kind, self._mode)
            if row is None or row["status"] == "retry":
                return False
        return True

    def _queue_result(self, evidence_hash, decision, raw):
        key = f"{evidence_hash}:result"
        if self._journal.has_notification(key) or not self._final(evidence_hash, decision):
            return
        records = []
        for kind, _ in self._legs(decision):
            row = self._journal.dispatch_state(evidence_hash, kind, self._mode)
            if row["status"] != "handed_off":
                records.append({**(row["result"] or {}), "_status": row["status"]})
        parsed = mail.parse(raw)
        text = notify.result_text(records, parsed.sender_domain, parsed.subject)
        # A silent outcome is recorded too, so it is never looked up again.
        self._journal.queue_notification(key, text or "")

    def _one(self, evidence_hash, decision, locations, since, handoff, summary, owner_choice=False):
        todo = []
        for kind, service in self._legs(decision):
            row = self._journal.dispatch_state(evidence_hash, kind, self._mode)
            if row is None or row["status"] == "retry":
                todo.append((kind, service, (row or {}).get("attempts", 0)))
        if not todo:
            if self._mode == "live":
                self._catch_up(evidence_hash, decision, locations)
            return
        if not owner_choice and not self._eligible(locations, since, handoff):
            return
        if self._mode == "live" and not owner_choice and self._handed_off(locations, handoff):
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
        if self._mode == "live":
            self._finish(evidence_hash, decision, locations, raw)

    def _finish(self, evidence_hash, decision, locations, raw):
        """Mark INBOX read, then queue the result: a crash between the two is caught up next run."""
        if self._all_done(evidence_hash, decision):
            for folder, validity, uid, _ in locations:
                if folder == INBOX:
                    self._journal.add_mark(folder, validity, uid)
            self._flush_marks()
        self._queue_result(evidence_hash, decision, raw)

    def _catch_up(self, evidence_hash, decision, locations):
        """An email whose legs all ended but whose result was never queued (a crash): finish it now."""
        if self._journal.has_notification(f"{evidence_hash}:result") or not self._final(evidence_hash, decision):
            return
        if all(self._journal.dispatch_state(evidence_hash, kind, self._mode)["status"] == "handed_off"
               for kind, _ in self._legs(decision)):
            return
        raw = None
        for folder, validity, uid, _ in locations:
            raw = self._mailbox.fetch(folder, validity, uid)
            if raw:
                break
        if raw:
            self._finish(evidence_hash, decision, locations, raw)

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
            # A dry run that answered is evidence for the comparison and is not repeated.
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
