"""Durable intake journal (issue #783).

Message identity is (account, folder, UIDVALIDITY, UID); the evidence hash
links copies of one email across folders so it is classified once. A
per-folder checkpoint is advanced only after a message is recorded. Dispatch
results (rehearsal dry runs and live requests) are kept per evidence hash and
booking leg. No email body is ever stored here.
"""

import json
import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    account TEXT NOT NULL,
    folder TEXT NOT NULL,
    uidvalidity INTEGER NOT NULL,
    uid INTEGER NOT NULL,
    evidence_hash TEXT NOT NULL,
    message_id_hash TEXT,
    status TEXT NOT NULL,
    decision TEXT,
    updated_at REAL NOT NULL,
    PRIMARY KEY (account, folder, uidvalidity, uid)
);
CREATE INDEX IF NOT EXISTS messages_evidence ON messages (evidence_hash);
CREATE TABLE IF NOT EXISTS folders (
    account TEXT NOT NULL,
    folder TEXT NOT NULL,
    uidvalidity INTEGER NOT NULL,
    last_uid INTEGER NOT NULL,
    PRIMARY KEY (account, folder)
);
CREATE TABLE IF NOT EXISTS decisions (
    evidence_hash TEXT NOT NULL,
    version TEXT NOT NULL,
    decision TEXT NOT NULL,
    PRIMARY KEY (evidence_hash, version)
);
CREATE TABLE IF NOT EXISTS dispatches (
    evidence_hash TEXT NOT NULL,
    kind TEXT NOT NULL,
    mode TEXT NOT NULL,
    request_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    result TEXT,
    updated_at REAL NOT NULL,
    PRIMARY KEY (evidence_hash, kind, mode)
);
CREATE TABLE IF NOT EXISTS pending_marks (
    folder TEXT NOT NULL,
    uidvalidity INTEGER NOT NULL,
    uid INTEGER NOT NULL,
    PRIMARY KEY (folder, uidvalidity, uid)
);
CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class Journal:
    def __init__(self, path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self.path)
        self._db.executescript(SCHEMA)
        self._account = None

    def close(self):
        self._db.close()

    def folder_state(self, account, folder):
        row = self._db.execute(
            "SELECT uidvalidity, last_uid FROM folders WHERE account = ? AND folder = ?", (account, folder)
        ).fetchone()
        return row if row else (None, 0)

    def known(self, account, folder, uidvalidity, uid):
        return self._db.execute(
            "SELECT 1 FROM messages WHERE account=? AND folder=? AND uidvalidity=? AND uid=?",
            (account, folder, uidvalidity, uid),
        ).fetchone() is not None

    def record(self, account, folder, uidvalidity, uid, evidence_hash, message_id_hash, status, decision):
        self._db.execute(
            """INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT(account, folder, uidvalidity, uid) DO UPDATE SET
               status=excluded.status, decision=excluded.decision, updated_at=excluded.updated_at""",
            (account, folder, uidvalidity, uid, evidence_hash, message_id_hash, status,
             json.dumps(decision) if decision is not None else None, time.time()),
        )
        self._db.commit()

    def checkpoint(self, folder, uidvalidity, uid, account="acct"):
        self._db.execute(
            """INSERT INTO folders VALUES (?,?,?,?)
               ON CONFLICT(account, folder) DO UPDATE SET
               uidvalidity=excluded.uidvalidity,
               last_uid=CASE WHEN folders.uidvalidity = excluded.uidvalidity
                             THEN MAX(folders.last_uid, excluded.last_uid) ELSE excluded.last_uid END""",
            (account, folder, uidvalidity, uid),
        )
        self._db.commit()

    def status_of_evidence(self, evidence_hash):
        row = self._db.execute(
            "SELECT status, decision FROM messages WHERE evidence_hash = ? ORDER BY updated_at LIMIT 1",
            (evidence_hash,),
        ).fetchone()
        return (row[0], json.loads(row[1]) if row[1] else None) if row else None

    def cached_decision(self, evidence_hash, version):
        row = self._db.execute(
            "SELECT decision FROM decisions WHERE evidence_hash = ? AND version = ?", (evidence_hash, version)
        ).fetchone()
        return json.loads(row[0]) if row else None

    def cache_decision(self, evidence_hash, version, decision):
        self._db.execute(
            "INSERT OR REPLACE INTO decisions VALUES (?,?,?)", (evidence_hash, version, json.dumps(decision))
        )
        self._db.commit()

    def get_state(self, key):
        row = self._db.execute("SELECT value FROM state WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def set_state(self, key, value):
        self._db.execute("INSERT OR REPLACE INTO state VALUES (?,?)", (key, str(value)))
        self._db.commit()

    def routed(self, account, statuses):
        """[(evidence_hash, decision, [(folder, uidvalidity, uid, updated_at)])] for mail routed to a tracker."""
        marks = ",".join("?" * len(statuses))
        rows = self._db.execute(
            f"SELECT evidence_hash, folder, uidvalidity, uid, decision, updated_at FROM messages "
            f"WHERE account = ? AND status IN ({marks}) ORDER BY updated_at, folder, uid",
            (account, *statuses),
        ).fetchall()
        grouped = {}
        for evidence_hash, folder, uidvalidity, uid, decision, updated_at in rows:
            entry = grouped.setdefault(evidence_hash, [json.loads(decision) if decision else {}, []])
            entry[1].append((folder, uidvalidity, uid, updated_at))
        return [(h, d, locs) for h, (d, locs) in grouped.items()]

    def dispatch_state(self, evidence_hash, kind, mode):
        row = self._db.execute(
            "SELECT request_id, status, attempts, result FROM dispatches WHERE evidence_hash=? AND kind=? AND mode=?",
            (evidence_hash, kind, mode),
        ).fetchone()
        if not row:
            return None
        return {"request_id": row[0], "status": row[1], "attempts": row[2],
                "result": json.loads(row[3]) if row[3] else None}

    def save_dispatch(self, evidence_hash, kind, mode, request_id, status, attempts, result):
        self._db.execute(
            "INSERT OR REPLACE INTO dispatches VALUES (?,?,?,?,?,?,?,?)",
            (evidence_hash, kind, mode, request_id, status, attempts, json.dumps(result), time.time()),
        )
        self._db.commit()

    def add_mark(self, folder, uidvalidity, uid):
        self._db.execute("INSERT OR IGNORE INTO pending_marks VALUES (?,?,?)", (folder, uidvalidity, uid))
        self._db.commit()

    def pending_marks(self):
        return self._db.execute("SELECT folder, uidvalidity, uid FROM pending_marks").fetchall()

    def clear_mark(self, folder, uidvalidity, uid):
        self._db.execute("DELETE FROM pending_marks WHERE folder=? AND uidvalidity=? AND uid=?",
                         (folder, uidvalidity, uid))
        self._db.commit()

    def stale(self, account, statuses, version, limit):
        """Locations whose Jev decision came from another classifier version."""
        marks = ",".join("?" * len(statuses))
        return self._db.execute(
            f"SELECT folder, uidvalidity, uid FROM messages WHERE account = ? AND status IN ({marks}) "
            f"AND COALESCE(json_extract(decision, '$.version'), '') != ? ORDER BY updated_at DESC LIMIT ?",
            (account, *statuses, version, limit),
        ).fetchall()

    def update_decision(self, account, folder, uidvalidity, uid, status, decision):
        """Replace a decision in place, keeping updated_at (when the mail was first recorded)."""
        self._db.execute(
            "UPDATE messages SET status = ?, decision = ? WHERE account=? AND folder=? AND uidvalidity=? AND uid=?",
            (status, json.dumps(decision), account, folder, uidvalidity, uid),
        )
        self._db.commit()
