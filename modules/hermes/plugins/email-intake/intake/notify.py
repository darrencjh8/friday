"""Owner messages for live email intake (issue #783, cutover PR 2).

One message per email, queued in the intake journal and delivered once:
the tracker's own words for a booking (plus its learning offer), a review
request with /replay commands for uncertain mail, a blocked notice for a
password-protected statement, a notify rule's message, and a failure notice
once retries are spent. Shadow mode queues nothing.

Messages that carry a tap command (/remember_, /forget_, /replay_) go
straight to the Bot API sendMessage, as expense-tracker's learning offers
do: Hermes owns getUpdates, sendMessage does not conflict with it, and those
commands are handled only on Telegram. Plain text, never parse_mode. Every
other message goes to Dots through the Hermes `notify` webhook, the same
signed route expense-tracker's notify_user uses.
"""

import hashlib
import hmac
import json
import logging
import re
import urllib.error
import urllib.request

from . import redact

logger = logging.getLogger(__name__)

SENT, RETRY, REJECTED = "sent", "retry", "rejected"
REPLAY_ID_LENGTH = 10
TELEGRAM_LIMIT = 4000
COMMAND = re.compile(r"/(remember|forget|replay)_")


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
    lines, failures = [], []
    for record in records:
        lines.extend(str(m) for m in (record.get("messages") or []) if str(m).strip())
        if record.get("_status") in ("failed", "invalid"):
            failures.append(record.get("reason") or record.get("action") or "error")
    if failures:
        lines.append(f'Could not process an email from {domain or "an unknown sender"} '
                     f'("{_subject(subject)}"): {", ".join(failures)}. It stays unread.')
    text = "\n".join(lines).strip()
    return text[:TELEGRAM_LIMIT] or None


def offers_text(records):
    """The learning offers, sent apart from the result so their commands reach Telegram."""
    offers = [offer_text(r["mapping_candidate"]) for r in records if r.get("mapping_candidate")]
    return "\n".join(offers)[:TELEGRAM_LIMIT] or None


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


def post_bytes(url, data, headers, timeout=30):
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        resp.read()


class WebhookSender:
    """Posts {"message": text} to the Hermes notify webhook, which delivers it to Dots."""

    def __init__(self, url, secret, post=post_bytes):
        self._url = url
        self._secret = secret
        self._post = post

    def __call__(self, text):
        """SENT; REJECTED when the webhook refuses this message for good; RETRY otherwise."""
        data = json.dumps({"message": text}).encode()
        # The gateway recomputes the HMAC over the raw body (see notify_user in expense-tracker).
        signature = hmac.new(self._secret.encode(), data, hashlib.sha256).hexdigest()
        try:
            self._post(self._url, data, {"X-Webhook-Signature": signature})
        except urllib.error.HTTPError as error:
            if error.code in (400, 413):
                return REJECTED
            # 401/404 are configuration faults: keep the message until they are fixed.
            logger.warning("email-intake notify webhook failed: HTTP %s", error.code)
            return RETRY
        except Exception as error:  # noqa: BLE001 - retried on the next flush
            logger.warning("email-intake notify webhook failed: %s", type(error).__name__)
            return RETRY
        return SENT


class Outbox:
    """Delivers queued messages in order; each is sent at most once.

    Messages with a tap command go to Telegram, the rest to Dots when it is
    configured. ponytail: one ordered queue for both, so an outage on either
    holds the other back until the next run; split the queue per channel if
    that ever bites.
    """

    def __init__(self, journal, send, dots=None):
        self._journal = journal
        self._send = send
        self._dots = dots

    def flush(self):
        """An outage keeps every message for later, in order; a rejected message is dropped and logged."""
        sent = 0
        for key, text, _attempts in self._journal.unsent_notifications():
            send = self._send if self._dots is None or COMMAND.search(text) else self._dots
            outcome = send(text)
            if outcome == SENT:
                self._journal.mark_notification_sent(key)
                sent += 1
            elif outcome == REJECTED:
                logger.warning("email-intake notification rejected; dropped")
                self._journal.reject_notification(key)
            else:
                self._journal.note_notification_attempt(key)
                break  # keep order: try the rest next run
        return sent
