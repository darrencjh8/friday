"""Mnemosyne forget pass: candidates, guarded apply with archive, and retention prune.

Fixtures are synthetic and use only the Mnemosyne columns the script reads.
"""

import datetime
import hashlib
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
SCRIPT = SCRIPTS / "mnemosyne_forget.py"
GATE = SCRIPTS / "mnemosyne-forget-gate.py"

NOW = datetime.datetime.now()


def ts(days_ago):
    return (NOW - datetime.timedelta(days=days_ago)).isoformat()


def day(days_ago):
    return (NOW - datetime.timedelta(days=days_ago)).date().isoformat()


SCHEMA = """
CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT, timestamp TEXT,
    session_id TEXT, scope TEXT, importance REAL, metadata_json TEXT, event_date TEXT,
    consolidated_at TEXT, valid_until TEXT, superseded_by TEXT);
CREATE TABLE episodic_memory (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL, source TEXT, timestamp TEXT, session_id TEXT, scope TEXT,
    summary_of TEXT DEFAULT '', metadata_json TEXT, event_date TEXT, valid_until TEXT, superseded_by TEXT);
CREATE TABLE annotations (id INTEGER PRIMARY KEY, memory_id TEXT, value TEXT);
CREATE TABLE gists (id TEXT, memory_id TEXT, text TEXT);
CREATE TABLE memory_embeddings (memory_id TEXT, embedding_json TEXT);
CREATE TABLE facts (fact_id TEXT, source_msg_id TEXT, subject TEXT);
CREATE TABLE consolidated_facts (id TEXT, subject TEXT, sources_json TEXT);
"""


class ForgetTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.db = self.home / "mnemosyne" / "data" / "mnemosyne.db"
        self.db.parent.mkdir(parents=True)
        conn = sqlite3.connect(self.db)
        conn.executescript(SCHEMA)
        conn.close()

    def tearDown(self):
        self.tmp.cleanup()

    def env(self):
        return {**os.environ, "HERMES_HOME": str(self.home)}

    def run_script(self, *args, ok=True):
        result = subprocess.run([sys.executable, str(SCRIPT), *args], env=self.env(), text=True, capture_output=True)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return result

    def add_wm(self, id, content, days_ago, source="conversation", event_date=None, metadata=None):
        conn = sqlite3.connect(self.db)
        conn.execute("INSERT INTO working_memory (id, content, source, timestamp, session_id, scope, metadata_json, event_date)"
                     " VALUES (?, ?, ?, ?, 's1', 'session', ?, ?)",
                     (id, content, source, ts(days_ago), json.dumps(metadata or {}), event_date))
        for table, column in (("annotations", "memory_id"), ("gists", "memory_id"),
                              ("memory_embeddings", "memory_id"), ("facts", "source_msg_id")):
            conn.execute(f"INSERT INTO {table} ({column}) VALUES (?)", (id,))
        conn.execute("INSERT INTO consolidated_facts (id, sources_json) VALUES (?, ?)", ("cf_" + id, json.dumps([id])))
        conn.commit()
        conn.close()

    def add_ep(self, id, content, days_ago, summary_of):
        conn = sqlite3.connect(self.db)
        conn.execute("INSERT INTO episodic_memory (id, content, source, timestamp, session_id, scope, summary_of)"
                     " VALUES (?, ?, 'sleep_consolidation', ?, 's1', 'session', ?)",
                     (id, content, ts(days_ago), ",".join(summary_of)))
        conn.execute("INSERT INTO memory_embeddings (memory_id) VALUES (?)", (id,))
        conn.commit()
        conn.close()

    def ids(self, table):
        conn = sqlite3.connect(self.db)
        try:
            return {r[0] for r in conn.execute(f"SELECT id FROM {table}")}
        finally:
            conn.close()

    def refs(self, memory_id):
        conn = sqlite3.connect(self.db)
        try:
            return sum(conn.execute(sql, (memory_id,)).fetchone()[0] for sql in (
                "SELECT COUNT(*) FROM annotations WHERE memory_id = ?",
                "SELECT COUNT(*) FROM gists WHERE memory_id = ?",
                "SELECT COUNT(*) FROM memory_embeddings WHERE memory_id = ?",
                "SELECT COUNT(*) FROM facts WHERE source_msg_id = ?",
                "SELECT COUNT(*) FROM consolidated_facts WHERE id = 'cf_' || ?",
            ))
        finally:
            conn.close()

    def candidates(self):
        self.run_script("candidates")
        data = json.loads((self.home / "tmp" / "mnemosyne-forget-candidates.json").read_text())
        return {c["id"]: c for c in data["candidates"]}

    def apply(self, *entries, dry_run=False, ok=True):
        plan = self.home / "plan.json"
        plan.write_text(json.dumps({"forget": list(entries)}))
        args = ["apply", "--plan", str(plan)] + (["--dry-run"] if dry_run else [])
        return self.run_script(*args, ok=ok)

    def jsonl(self, path):
        path = self.home / path
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def stale_date_fixture(self):
        self.add_wm("fact1", "Example Fibre: pay manually on the 1st; the bill itself is due on the 4th.", 16, source="fact")
        self.add_ep("ep1", "Example Fibre costs RM10/month, due on the 4th.", 6, ["fact1"])
        self.add_wm("prop1", "[MODEL_REFRESH_PROPOSAL] Example Fibre bill due on the 4th.", 6,
                    source="sleep_model_refresh_proposal", metadata={"status": "rejected"})
        self.add_wm("fix1", "[USER] it shouldn't be due on the 4th, Example Fibre is due on the first weekend of the month", 8)


class StaleDateTest(ForgetTest):
    def test_correction_and_rejected_proposal_are_candidates(self):
        self.stale_date_fixture()
        found = self.candidates()
        self.assertEqual(found["fact1"]["hint"], "superseded")
        self.assertIn("fix1", [e["id"] for e in found["fact1"]["evidence"]])
        self.assertEqual(found["prop1"]["hint"], "rejected_proposal")
        self.assertNotIn("fix1", found)

    def test_stale_date_forgotten_after_correction(self):
        self.stale_date_fixture()
        self.apply({"id": "fact1", "reason": "superseded", "evidence_id": "fix1"},
                   {"id": "prop1", "reason": "rejected_proposal"})
        self.assertEqual(self.ids("working_memory"), {"fix1"})
        # The single-source summary of the stale fact goes with it.
        self.assertEqual(self.ids("episodic_memory"), set())
        for memory_id in ("fact1", "prop1", "ep1"):
            self.assertEqual(self.refs(memory_id), 0, memory_id)
        self.assertEqual(self.refs("fix1"), 5)

        archive = {e["row"]["id"]: e for e in self.jsonl("mnemosyne/archive/forgotten.jsonl")}
        self.assertEqual(set(archive), {"fact1", "prop1", "ep1"})
        self.assertIn("due on the 4th", archive["fact1"]["row"]["content"])
        self.assertEqual(archive["ep1"]["reason"], "derived")

        audit = {e["id"]: e for e in self.jsonl("logs/mnemosyne-forget-audit.jsonl")}
        self.assertEqual(audit["fact1"]["evidence_id"], "fix1")
        self.assertEqual(audit["fact1"]["content_sha256"],
                         hashlib.sha256(archive["fact1"]["row"]["content"].encode()).hexdigest())
        self.assertNotIn("content", audit["fact1"])

    def test_dry_run_changes_nothing(self):
        self.stale_date_fixture()
        self.apply({"id": "fact1", "reason": "superseded", "evidence_id": "fix1"}, dry_run=True)
        self.assertEqual(self.ids("working_memory"), {"fact1", "prop1", "fix1"})
        self.assertEqual(self.jsonl("mnemosyne/archive/forgotten.jsonl"), [])


class ExpiredOneOffTest(ForgetTest):
    def test_expired_one_off_is_dropped(self):
        self.add_wm("once1", "[USER] remind me to book the hotel by the 27th", 20, event_date=day(17))
        self.assertEqual(self.candidates()["once1"]["hint"], "expired")
        self.apply({"id": "once1", "reason": "expired"})
        self.assertEqual(self.ids("working_memory"), set())

    def test_future_one_off_is_kept(self):
        self.add_wm("once2", "[USER] remind me to renew the card", 2, event_date=day(-20))
        self.assertNotIn("once2", self.candidates())
        result = self.apply({"id": "once2", "reason": "expired"}, ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.ids("working_memory"), {"once2"})


class DurableFactTest(ForgetTest):
    def test_durable_fact_survives_every_reason_without_a_correction(self):
        self.add_wm("gym", "[USER] my monthly gym fee is S$90", 30)
        self.add_wm("older", "[USER] actually the gym fee is wrong, it should be S$80", 40)
        self.add_wm("agent", "Correction: the gym fee should be S$70", 5, source="fact")
        self.assertNotIn("gym", self.candidates())
        for entry in ({"id": "gym", "reason": "superseded", "evidence_id": "older"},  # correction is older
                      {"id": "gym", "reason": "superseded", "evidence_id": "agent"},  # not the owner's words
                      {"id": "gym", "reason": "superseded"},
                      {"id": "gym", "reason": "expired"},
                      {"id": "gym", "reason": "noise"},
                      {"id": "gym", "reason": "rejected_proposal"},
                      {"id": "gym", "reason": "because"}):
            result = self.apply(entry, ok=False)
            self.assertNotEqual(result.returncode, 0, entry)
        self.assertEqual(self.ids("working_memory"), {"gym", "older", "agent"})
        self.assertEqual(self.jsonl("logs/mnemosyne-forget-audit.jsonl"), [])

    def test_one_bad_entry_refuses_the_whole_plan(self):
        self.stale_date_fixture()
        self.add_wm("gym", "[USER] my monthly gym fee is S$90", 30)
        self.apply({"id": "prop1", "reason": "rejected_proposal"}, {"id": "gym", "reason": "noise"}, ok=False)
        self.assertEqual(self.ids("working_memory"), {"fact1", "prop1", "fix1", "gym"})

    def test_multi_fact_summary_is_report_only(self):
        self.add_wm("a", "Example Fibre due on the 4th", 20, source="fact")
        self.add_wm("b", "[USER] the gym fee is S$90", 20)
        self.add_ep("mixed", "Bills: Example Fibre due on the 4th; gym S$90.", 10, ["a", "b"])
        self.add_wm("fix", "[USER] it shouldn't be due on the 4th, Example Fibre is due on the first weekend", 5)
        result = self.apply({"id": "mixed", "reason": "superseded", "evidence_id": "fix"}, ok=False)
        self.assertIn("multi-fact", result.stdout + result.stderr)
        # Forgetting a source row keeps the mixed summary and reports it.
        result = self.apply({"id": "a", "reason": "superseded", "evidence_id": "fix"})
        self.assertEqual(self.ids("episodic_memory"), {"mixed"})
        self.assertIn("mixed", json.loads(result.stdout)["kept_summaries"])


class NoiseTest(ForgetTest):
    def test_probe_is_noise(self):
        self.add_wm("probe", "[USER] Read-only memory probe from the nightly job, do not write any memory", 9)
        self.assertEqual(self.candidates()["probe"]["hint"], "noise")
        self.apply({"id": "probe", "reason": "noise"})
        self.assertEqual(self.ids("working_memory"), set())


@unittest.skipIf(importlib.util.find_spec("sqlite_vec"), "sqlite_vec installed here")
class VectorTableTest(ForgetTest):
    def test_refuses_when_vector_tables_cannot_be_cleaned(self):
        self.add_wm("probe", "[USER] memory probe, ignore", 9)
        conn = sqlite3.connect(self.db)
        conn.execute("CREATE TABLE vec_working (embedding BLOB)")
        conn.close()
        result = self.apply({"id": "probe", "reason": "noise"}, ok=False)
        self.assertIn("sqlite_vec", result.stdout + result.stderr)
        self.assertEqual(self.ids("working_memory"), {"probe"})
        self.assertEqual(self.jsonl("mnemosyne/archive/forgotten.jsonl"), [])


class PruneTest(ForgetTest):
    def write_jsonl(self, path, entries):
        path = self.home / path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(e) + "\n" for e in entries))

    def test_archive_kept_30_days_and_audit_one_year(self):
        self.write_jsonl("mnemosyne/archive/forgotten.jsonl",
                         [{"forgotten_at": ts(31), "row": {"id": "old"}}, {"forgotten_at": ts(29), "row": {"id": "new"}}])
        self.write_jsonl("logs/mnemosyne-forget-audit.jsonl",
                         [{"forgotten_at": ts(366), "id": "old"}, {"forgotten_at": ts(31), "id": "new"}])
        report = json.loads(self.run_script("prune").stdout)
        self.assertEqual((report["archive_pruned"], report["audit_pruned"]), (1, 1))
        self.assertEqual([e["row"]["id"] for e in self.jsonl("mnemosyne/archive/forgotten.jsonl")], ["new"])
        self.assertEqual([e["id"] for e in self.jsonl("logs/mnemosyne-forget-audit.jsonl")], ["new"])

    def test_prune_without_files_is_a_no_op(self):
        self.assertEqual(json.loads(self.run_script("prune").stdout), {"archive_pruned": 0, "audit_pruned": 0})


class GateTest(ForgetTest):
    def gate(self):
        result = subprocess.run([sys.executable, str(GATE)], env=self.env(), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def test_wakes_once_per_new_candidate_set(self):
        self.add_wm("gym", "[USER] my monthly gym fee is S$90", 30)
        self.assertEqual(self.gate(), "")
        self.add_wm("probe", "[USER] memory probe, ignore", 9)
        self.assertIn("1 candidate", self.gate())
        self.assertEqual(self.gate(), "")

    def test_absent_db_is_silent(self):
        self.db.unlink()
        self.assertEqual(self.gate(), "")


if __name__ == "__main__":
    unittest.main()
