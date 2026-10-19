"""Telegram messages for live email intake (issue #783, cutover PR 2).

One message per email, queued in the intake journal and delivered once:
the tracker's own words for a booking (plus its learning offer), a review
request with /replay commands for uncertain mail, a blocked notice for a
password-protected statement, a notify rule's message, and a failure notice
once retries are spent. Shadow mode queues nothing.

Messages go straight to the Bot API sendMessage, as expense-tracker's
learning offers do: Hermes owns getUpdates, and sendMessage does not
conflict with it. Plain text, never parse_mode.
"""

import logging
import urllib.error

from . import redact

logger = logging.getLogger(__name__)

SENT, RETRY, REJECTED = "sent", "retry", "rejected"
REPLAY_ID_LENGTH = 10
TELEGRAM_LIMIT = 4000


def replay_id(evidence_hash):
    return evidence_hash[:REPLAY_ID_LENGTH]


def _subject(subject):
    return redact.scrub(" ".join(str(subject or "").split()))[:120] or "(no subject)"


def offer_text(candidate):
    """The tracker's offer wording: key, the descriptor it came from, payee and category."""
    offer_id = str(candidate.get("id", "")).lower()
    descriptor = candidate.get("descriptor", "")
    example = candidate.get("example") or ""
    source = f" (from {example})" if example and example != descriptor else ""
    category = f', category {candidate["category"]}' if candidate.get("category") else ""
    return (f'Remember "{descriptor}"{source} as {candidate.get("payee", "")}{category}? '
            f"Tap /remember_{offer_id} or /forget_{offer_id}. Nothing is saved until you choose.")


def review_text(domain, subject, evidence_hash):
    rid = replay_id(evidence_hash)
    return (f'Needs review: email from {domain or "an unknown sender"}, "{_subject(subject)}". '
            f"Book it with /replay_{rid}_tx (transaction), /replay_{rid}_stmt (statement) "
            f"or /replay_{rid}_pf (portfolio), or ignore it.")


def blocked_text(domain, subject):
    return (f'Couldn\'t open the password-protected statement from {domain or "an unknown sender"} '
            f'("{_subject(subject)}"). It stays unread.')


def result_text(records, domain, subject):
    """One message for an email whose legs all ended; None when there is nothing to say."""
    lines, offers, failures = [], [], []
    for record in records:
        lines.extend(str(m) for m in (record.get("messages") or []) if str(m).strip())
        if record.get("mapping_candidate"):
            offers.append(offer_text(record["mapping_candidate"]))
        if record.get("_status") in ("failed", "invalid"):
            failures.append(record.get("reason") or record.get("action") or "error")
    if failures:
        lines.append(f'Could not process an email from {domain or "an unknown sender"} '
                     f'("{_subject(subject)}"): {", ".join(failures)}. It stays unread.')
    lines.extend(offers)
    text = "\n".join(lines).strip()
    return text[:TELEGRAM_LIMIT] or None


class TelegramSender:
    def __init__(self, token, chat_id, post):
        self._url = f"https://api.telegram.org/bot{token}/sendMessage"
        self._chat_id = str(chat_id)
        self._post = post

    def __call__(self, text):
        """SENT; REJECTED when Telegram refuses this message for good; RETRY otherwise."""
        try:
            response = self._post(self._url, {"chat_id": self._chat_id, "text": text}, {})
        except urllib.error.HTTPError as error:
            if error.code in (400, 403):
                return REJECTED
            logger.warning("email-intake telegram send failed: HTTP %s", error.code)
            return RETRY
        except Exception as error:  # noqa: BLE001 - retried on the next flush
            logger.warning("email-intake telegram send failed: %s", type(error).__name__)
            return RETRY
        return SENT if isinstance(response, dict) and response.get("ok") else RETRY


class Outbox:
    """Delivers queued messages in order; each is sent at most once."""

    def __init__(self, journal, send):
        self._journal = journal
        self._send = send

    def flush(self):
        """An outage keeps every message for later, in order; a rejected message is dropped and logged."""
        sent = 0
        for key, text, _attempts in self._journal.unsent_notifications():
            outcome = self._send(text)
            if outcome == SENT:
                self._journal.mark_notification_sent(key)
                sent += 1
            elif outcome == REJECTED:
                logger.warning("email-intake telegram rejected a message; dropped")
                self._journal.reject_notification(key)
            else:
                self._journal.note_notification_attempt(key)
                break  # keep order: try the rest next run
        return sent
