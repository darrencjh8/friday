"""Read-only IMAP scanning for email-intake (issue #783).

Every selectable folder is opened with EXAMINE (select readonly) and fetched
with BODY.PEEK[], so read flags never change and nothing is stored, copied or
moved. New mail is found by UID past the folder's checkpoint. When a folder's
UIDVALIDITY changes, its old UIDs mean nothing, so the folder is re-scanned
over a bounded window and the journal's evidence hashes decide what is new;
the checkpoint is never simply reset to the newest UID.

The Sent folder (by \\Sent flag or name) is never read: own outgoing mail
is not evidence.

With baseline=True, a folder seen for the first time only records its newest
UID: mail that predates intake is history, not processed (cutover baseline).
"""

import datetime
import re
from dataclasses import dataclass

RESCAN_DAYS = 30
SENT_NAMES = {"sent", "sent items", "sent messages", "sent mail", "[gmail]/sent mail"}
_LIST_LINE = re.compile(rb'^\((?P<flags>[^)]*)\)\s+(?:"[^"]*"|NIL)\s+(?P<name>.+)$')


@dataclass
class Found:
    folder: str
    uidvalidity: int
    uid: int
    raw: bytes


def _folders(imap):
    status, lines = imap.list()
    if status != "OK":
        return []
    names = []
    for line in lines or []:
        if not isinstance(line, bytes):
            continue
        match = _LIST_LINE.match(line.strip())
        flags = match.group("flags").lower() if match else b""
        if not match or b"\\noselect" in flags or b"\\sent" in flags.split():
            continue
        name = match.group("name").strip().strip(b'"').decode("utf-8", "replace")
        if name.lower() not in SENT_NAMES:
            names.append(name)
    return names


def _quote(folder):
    return '"' + folder.replace("\\", "\\\\").replace('"', '\\"') + '"'


class Scanner:
    def __init__(self, connect, journal, account, baseline=False):
        self._connect = connect
        self._journal = journal
        self._account = account
        self._baseline = baseline

    def scan(self):
        imap = self._connect()
        try:
            for folder in _folders(imap):
                yield from self._scan_folder(imap, folder)
        finally:
            try:
                imap.logout()
            except Exception:  # noqa: BLE001
                pass

    def _scan_folder(self, imap, folder):
        status, _ = imap.select(_quote(folder), readonly=True)
        if status != "OK":
            return
        _, values = imap.response("UIDVALIDITY")
        try:
            uidvalidity = int((values or [b"0"])[0])
        except (TypeError, ValueError):
            uidvalidity = 0
        stored_validity, last_uid = self._journal.folder_state(self._account, folder)
        if stored_validity is None and self._baseline:
            status, data = imap.uid("SEARCH", None, "ALL")
            uids = [int(t) for t in (data[0] or b"").split()] if status == "OK" and data else []
            self._journal.checkpoint(folder, uidvalidity, max(uids, default=0), account=self._account)
            return
        if stored_validity is not None and stored_validity != uidvalidity:
            since = (datetime.date.today() - datetime.timedelta(days=RESCAN_DAYS)).strftime("%d-%b-%Y")
            criteria, floor = f"SINCE {since}", 0
        else:
            criteria, floor = f"UID {last_uid + 1}:*", last_uid
        status, data = imap.uid("SEARCH", None, criteria)
        if status != "OK":
            return
        for token in (data[0] or b"").split():
            uid = int(token)
            if uid <= floor or self._journal.known(self._account, folder, uidvalidity, uid):
                continue
            status, fetched = imap.uid("FETCH", str(uid), "(BODY.PEEK[])")
            if status != "OK":
                continue
            raw = next((item[1] for item in fetched or [] if isinstance(item, tuple)), None)
            if raw:
                yield Found(folder, uidvalidity, uid, raw)
