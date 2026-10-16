"""Redaction applied to evidence before it leaves the host (issue #783).

Amounts and short suffixes stay usable; card and account numbers, national
ids, links (which carry tokens), and credential lines do not. The email is
untrusted data, so its own closing marker is escaped.
"""

import re

MAX_CHARS = 6000

_CREDENTIAL_LINE = re.compile(r"^.*\b(password|passcode|passwd|otp|pin)\b.*$", re.IGNORECASE | re.MULTILINE)
_LINK = re.compile(r"https?://\S+", re.IGNORECASE)
_SG_NRIC = re.compile(r"\b[STFGM]\d{7}[A-Z]\b", re.IGNORECASE)
_MY_IC = re.compile(r"\b\d{6}-\d{2}-\d{4}\b")
_LONG_DIGITS = re.compile(r"\d{8,}")
_MARKER = re.compile(r"<\s*/?\s*email\s*>", re.IGNORECASE)


def scrub(text: str) -> str:
    text = str(text or "")
    text = _CREDENTIAL_LINE.sub("[credential line removed]", text)
    text = _LINK.sub("[link]", text)
    text = _SG_NRIC.sub("[id]", text)
    text = _MY_IC.sub("[id]", text)
    text = _LONG_DIGITS.sub(lambda m: "*" * (len(m.group()) - 4) + m.group()[-4:], text)
    text = _MARKER.sub("[email-tag]", text)
    return text[:MAX_CHARS]
