"""Known email senders from the wiki (issue #783, dest-v3).

The wiki page `entities/email-senders.md` lists sender domains the owner has
confirmed, with the institution and what its mail usually needs. A listed
domain only becomes a hint for Jev, never a routing rule, and only when the
email passes DMARC: SPF or DKIM aligned with the From domain, so a spoofed
From header gets no hint.

The same page's `Notify rules` table names mail that needs no model at all,
only a message to the owner (e.g. "contract note ready, download it"). A rule
matches on the exact sender domain, DMARC pass and subject text.
"""

import re
from dataclasses import dataclass
from pathlib import Path

SECTION = "sender domains"
RULES_SECTION = "notify rules"
EXPECTED = {
    "actual_budget": "usually actual_budget",
    "portfolio": "usually portfolio",
    "neither": "usually neither",
    "content": "content decides",
}
_HEADING = re.compile(r"^#{1,6}\s+(.*)$")


@dataclass(frozen=True)
class Sender:
    institution: str
    expected: str


@dataclass(frozen=True)
class NotifyRule:
    domain: str
    subject_contains: str
    message: str


def _cells(line):
    parts = [c.strip() for c in line.strip().strip("|").split("|")]
    return None if all(re.fullmatch(r":?-+:?", c) for c in parts) else parts


def _confirmed_rows(path, section):
    """Rows (header -> cell, lower-case headers) of the tables under `## <section>` with status confirmed."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return []
    rows, in_section, header = [], False, None
    for line in text.splitlines():
        heading = _HEADING.match(line)
        if heading:
            in_section, header = heading.group(1).strip().lower() == section, None
            continue
        if not in_section or not line.strip().startswith("|"):
            header = None
            continue
        cells = _cells(line)
        if cells is None:
            continue
        if header is None:
            header = [c.lower() for c in cells]
            continue
        row = dict(zip(header, cells))
        if row.get("status", "").strip().lower() == "confirmed":
            rows.append(row)
    return rows


def _domain(row):
    return row.get("sender domain", "").strip("`").strip().lower()


def load(path):
    """Confirmed rows of the page's `Sender domains` table: {domain: Sender}. Missing page: {}."""
    known = {}
    for row in _confirmed_rows(path, SECTION):
        expected = row.get("expected", "").strip().lower()
        if _domain(row) and expected in EXPECTED:
            known[_domain(row)] = Sender(row.get("institution", "").strip(), expected)
    return known


def load_rules(path):
    """Confirmed rows of the page's `Notify rules` table that name a domain, subject text and message."""
    rules = []
    for row in _confirmed_rows(path, RULES_SECTION):
        subject = row.get("subject contains", "").strip().lower()
        message = row.get("message", "").strip()
        if _domain(row) and subject and message:
            rules.append(NotifyRule(_domain(row), subject, message))
    return rules


def match_rule(rules, sender_domain, auth, subject):
    """The first rule for this authenticated, exactly matching sender whose text is in the subject."""
    if (auth or {}).get("dmarc") != "pass":
        return None
    domain, subject = (sender_domain or "").lower(), (subject or "").lower()
    return next((r for r in rules if r.domain == domain and r.subject_contains in subject), None)


def hint(known, sender_domain, auth):
    """One line describing an authenticated, exactly listed sender; "" otherwise."""
    sender = known.get((sender_domain or "").lower())
    if not sender or (auth or {}).get("dmarc") != "pass":
        return ""
    return f"Known sender: {sender.institution} ({EXPECTED[sender.expected]})"
