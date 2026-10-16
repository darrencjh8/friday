"""Parse one raw email into the evidence intake needs (issue #783).

Only stdlib: the text body (plain, else HTML stripped), sender domain,
Authentication-Results verdicts, whether a PDF is attached and whether it is
encrypted, and stable hashes for de-duplicating copies across folders.
"""

import hashlib
import html
import re
from dataclasses import dataclass, field
from email import policy
from email.parser import BytesParser
from email.utils import parseaddr

_TAG = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"[ \t]+")
_AUTH = re.compile(r"\b(dkim|spf|dmarc)=(\w+)", re.IGNORECASE)


@dataclass
class Parsed:
    subject: str
    sender_domain: str
    text: str
    auth: dict = field(default_factory=dict)
    has_pdf: bool = False
    encrypted_pdf: bool = False
    evidence_hash: str = ""
    message_id_hash: str = ""


def _html_to_text(markup: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", markup)
    text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", text)
    return _SPACE.sub(" ", html.unescape(_TAG.sub(" ", text)))


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parse(raw: bytes) -> Parsed:
    msg = BytesParser(policy=policy.default).parsebytes(raw)
    plain, markup, has_pdf, encrypted = [], [], False, False
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        name = (part.get_filename() or "").lower()
        if ctype == "application/pdf" or name.endswith(".pdf"):
            has_pdf = True
            payload = part.get_payload(decode=True) or b""
            if b"/Encrypt" in payload:
                encrypted = True
            continue
        if part.get_content_disposition() == "attachment":
            continue
        if ctype == "text/plain":
            plain.append(part.get_content())
        elif ctype == "text/html":
            markup.append(_html_to_text(part.get_content()))
    text = "\n".join(plain) if plain else "\n".join(markup)
    auth = {}
    for header in msg.get_all("Authentication-Results", []) or []:
        for kind, verdict in _AUTH.findall(str(header)):
            auth.setdefault(kind.lower(), verdict.lower())
    sender = parseaddr(str(msg.get("From", "")))[1]
    message_id = str(msg.get("Message-ID", "")).strip()
    return Parsed(
        subject=str(msg.get("Subject", "")),
        sender_domain=sender.rsplit("@", 1)[-1].lower() if "@" in sender else "",
        text=text.strip(),
        auth=auth,
        has_pdf=has_pdf,
        encrypted_pdf=encrypted,
        evidence_hash=_sha(raw),
        message_id_hash=_sha(message_id.encode()) if message_id else "",
    )
