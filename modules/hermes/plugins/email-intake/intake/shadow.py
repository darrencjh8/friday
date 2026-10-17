"""Shadow-mode intake run (issue #783).

Reads new mail, classifies each unique email once with Jev, and records the
decision. It never dispatches to a tracker, never notifies, and never
changes the mailbox: the old watcher keeps booking while these decisions are
compared against it.
"""

from . import mail, redact, senders
from .jev import Decision

CLASSIFIER_VERSION = "dest-v3"

_STATUS = {
    "actual_budget": "shadow_actual_budget",
    "portfolio": "shadow_portfolio",
    "both": "shadow_both",
    "neither": "ignored",
    "uncertain": "shadow_uncertain",
}


def _state_text(parsed):
    auth = ", ".join(f"{k}={v}" for k, v in sorted(parsed.auth.items())) or "none"
    return (
        f"Sender domain: {parsed.sender_domain}\n"
        f"Sender authentication: {auth}\n"
        f"Subject: {redact.scrub(parsed.subject)[:200]}\n"
        f"PDF attached: {'yes' if parsed.has_pdf else 'no'}\n\n"
        f"{redact.scrub(parsed.text)}"
    )


REFRESH_PER_RUN = 20
_JEV_STATUSES = tuple(_STATUS.values())


class ShadowRunner:
    def __init__(self, scanner, journal, classify, senders=dict, notify_rules=list, fetch=None, unlock=None):
        """`fetch(folder, uidvalidity, uid)` re-reads one email so stale decisions can be refreshed;
        `unlock(raw)` opens its password-protected PDFs, None while one stays locked."""
        self._scanner = scanner
        self._journal = journal
        self._classify = classify
        self._senders = senders
        self._notify_rules = notify_rules
        self._fetch = fetch
        self._unlock = unlock

    def _jev_decision(self, parsed, known, summary):
        decision = self._journal.cached_decision(parsed.evidence_hash, CLASSIFIER_VERSION)
        if decision is None:
            result = self._classify(_state_text(parsed), senders.hint(known, parsed.sender_domain, parsed.auth))
            if not isinstance(result, Decision):
                result = Decision("uncertain", reason="bad_result")
            decision = {
                "version": CLASSIFIER_VERSION,
                "destination": result.destination,
                "subtype": result.subtype,
                "confidence": result.confidence,
                "reason": result.reason,
                "proposed": result.proposed,
                "proposed_subtype": result.proposed_subtype,
                "kind": result.kind,
                "sender_domain": parsed.sender_domain,
                "auth": parsed.auth,
            }
            self._journal.cache_decision(parsed.evidence_hash, CLASSIFIER_VERSION, decision)
            summary["classified"] += 1
        return _STATUS.get(decision.get("destination"), "shadow_uncertain"), decision

    def _refresh(self, account, known, summary):
        """Re-classify mail an older classifier decided: the scanner never re-reads a known UID."""
        for folder, uidvalidity, uid in self._journal.stale(account, _JEV_STATUSES, CLASSIFIER_VERSION,
                                                            REFRESH_PER_RUN):
            try:
                raw = self._fetch(folder, uidvalidity, uid)
            except Exception:  # noqa: BLE001 - retried next run
                continue
            if not raw:
                continue
            parsed = mail.parse(raw)
            status, decision = self._jev_decision(parsed, known, summary)
            # The recorded time is kept: a refresh is not new mail.
            self._journal.update_decision(account, folder, uidvalidity, uid, status, decision)
            summary["refreshed"] += 1

    def run_once(self):
        summary = {"seen": 0, "classified": 0, "copies": 0, "blocked": 0, "notified": 0, "refreshed": 0}
        account = self._scanner._account
        known, rules = self._senders(), self._notify_rules()
        if self._fetch is not None:
            self._refresh(account, known, summary)
        for found in self._scanner.scan():
            summary["seen"] += 1
            parsed = mail.parse(found.raw)
            prior = self._journal.status_of_evidence(parsed.evidence_hash)
            rule = None if prior else senders.match_rule(rules, parsed.sender_domain, parsed.auth, parsed.subject)
            if prior:
                summary["copies"] += 1
                status, decision = prior
            elif rule:
                # A notify rule needs no model: the owner is told to fetch the document themselves.
                summary["notified"] += 1
                status, decision = "shadow_notify", {"version": CLASSIFIER_VERSION, "destination": "notify",
                                                     "message": rule.message, "sender_domain": parsed.sender_domain}
            elif parsed.encrypted_pdf and (self._unlock is None or self._unlock(found.raw) is None):
                summary["blocked"] += 1
                status, decision = "blocked_encrypted", {"version": CLASSIFIER_VERSION}
            else:
                status, decision = self._jev_decision(parsed, known, summary)
            self._journal.record(account, found.folder, found.uidvalidity, found.uid,
                                 parsed.evidence_hash, parsed.message_id_hash, status, decision)
            # Checkpoint only after the evidence and decision are durably recorded.
            self._journal.checkpoint(found.folder, found.uidvalidity, found.uid, account=account)
        return summary
