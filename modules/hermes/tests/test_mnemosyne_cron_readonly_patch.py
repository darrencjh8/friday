"""Cron sessions recall Mnemosyne memory but never write it; proactive-tick is seeded to use it.

The patch is applied to a stand-in provider module with the same method names
the pinned mnemosyne-hermes 0.7.1 provider has, because the real plugin is not
installed in CI. The pinned-hash guard is what binds the patch to the real file.
"""

import hashlib
import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PATCH_PATH = HERE.parent / "patches" / "patch-mnemosyne-cron-readonly.py"
SEED = (HERE.parent / "50-seed-defaults").read_text(encoding="utf-8")
DOCKERFILE = (HERE.parent / "Dockerfile").read_text(encoding="utf-8")
TICK_SCRIPT = HERE.parent / "scripts" / "proactive-tick.py"

STUB = '''
import json

DEFAULT_SKIP = {"cron", "flush", "subagent", "background", "skill_loop"}


class MnemosyneMemoryProvider:
    def __init__(self, configured=None):
        self._skip_contexts = set(DEFAULT_SKIP)
        self._configured = configured
        self._agent_context = "primary"
        self.writes = []
        self.active = False

    def _read_config_key(self, key):
        return self._configured if key == "skip_contexts" else None

    def initialize(self, session_id, **kwargs):
        self._agent_context = kwargs.get("agent_context", "primary")
        raw = kwargs.get("skip_contexts")
        if raw is None:
            raw = self._read_config_key("skip_contexts")
        if raw is not None:
            self._skip_contexts = set(raw.split(",")) if isinstance(raw, str) else set(raw)
        self.active = self._agent_context not in self._skip_contexts

    def sync_turn(self, user_content, assistant_content, *, session_id="", messages=None):
        self.writes.append(("sync_turn", user_content))

    def on_session_end(self, messages):
        self.writes.append(("on_session_end", len(messages)))

    def on_memory_write(self, action, target, content):
        self.writes.append(("on_memory_write", content))

    def handle_tool_call(self, tool_name, args, **kwargs):
        self.writes.append((tool_name, args))
        return json.dumps({"ok": tool_name})
'''


def load_patch_module():
    spec = importlib.util.spec_from_file_location("patch_mnemosyne_cron_readonly", PATCH_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def patched_provider_class():
    mod = load_patch_module()
    text = mod.patch(STUB, expected_sha256=hashlib.sha256(STUB.encode("utf-8")).hexdigest())
    ns = {}
    exec(compile(text, "mnemosyne_hermes/__init__.py", "exec"), ns)
    return ns["MnemosyneMemoryProvider"]


class PatchGuardTest(unittest.TestCase):
    def test_refuses_a_module_that_is_not_the_pinned_one(self):
        mod = load_patch_module()
        with self.assertRaises(mod.PatchError):
            mod.patch(STUB)

    def test_is_idempotent(self):
        mod = load_patch_module()
        digest = hashlib.sha256(STUB.encode("utf-8")).hexdigest()
        once = mod.patch(STUB, expected_sha256=digest)
        self.assertEqual(mod.patch(once, expected_sha256=digest), once)
        self.assertEqual(once.count(mod.MARKER), 1)

    def test_cli_leaves_an_unpinned_file_untouched_and_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "__init__.py"
            path.write_text(STUB, encoding="utf-8")
            result = subprocess.run(["python3", str(PATCH_PATH), str(path)], text=True, capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("not the pinned 0.7.1", result.stderr)
            self.assertEqual(path.read_text(encoding="utf-8"), STUB)


class CronReadOnlyTest(unittest.TestCase):
    def provider(self, context, configured=None):
        cls = patched_provider_class()
        p = cls(configured)
        p.initialize("s1", agent_context=context, platform=context)
        return p

    def test_cron_initializes_instead_of_being_skipped(self):
        p = self.provider("cron")
        self.assertTrue(p.active)
        self.assertNotIn("cron", p._skip_contexts)
        self.assertEqual(p._skip_contexts, {"flush", "subagent", "background", "skill_loop"})

    def test_cron_keeps_an_operator_skip_list_minus_cron(self):
        p = self.provider("cron", configured="cron,subagent")
        self.assertEqual(p._skip_contexts, {"subagent"})

    def test_cron_write_hooks_are_no_ops(self):
        p = self.provider("cron")
        p.sync_turn("CRON PROMPT", "[SILENT]", session_id="s1")
        p.on_session_end([{"role": "user"}])
        p.on_memory_write("add", "memory", "x")
        self.assertEqual(p.writes, [])

    def test_cron_allows_read_tools_and_blocks_every_other_tool(self):
        p = self.provider("cron")
        self.assertEqual(json.loads(p.handle_tool_call("mnemosyne_recall_canonical", {"category": "goal"})),
                         {"ok": "mnemosyne_recall_canonical"})
        self.assertEqual(json.loads(p.handle_tool_call("mnemosyne_recall", {"query": "car"})),
                         {"ok": "mnemosyne_recall"})
        for tool in ("mnemosyne_remember", "mnemosyne_remember_canonical", "mnemosyne_forget",
                     "mnemosyne_sleep", "mnemosyne_some_future_tool"):
            self.assertIn("read-only in cron", json.loads(p.handle_tool_call(tool, {}))["error"])
        self.assertEqual([w[0] for w in p.writes], ["mnemosyne_recall_canonical", "mnemosyne_recall"])

    def test_chat_sessions_are_unchanged(self):
        p = self.provider("primary")
        self.assertIn("cron", p._skip_contexts)
        p.sync_turn("hi", "hello", session_id="s1")
        p.handle_tool_call("mnemosyne_remember", {"content": "x"})
        self.assertEqual([w[0] for w in p.writes], ["sync_turn", "mnemosyne_remember"])

    def test_other_skipped_contexts_stay_skipped(self):
        self.assertFalse(self.provider("subagent").active)


BLOCKS = re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", SEED, re.DOTALL)
TICK_SEED = next(b for b in BLOCKS if '"proactive-tick"' in b)


class ProactiveTickSeedTest(unittest.TestCase):
    def run_seed(self, jobs):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "jobs.json"
            path.write_text(json.dumps({"jobs": jobs}), encoding="utf-8")
            result = subprocess.run(["python3", "-c", TICK_SEED.replace("/opt/data/cron/jobs.json", str(path))],
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(path.read_text(encoding="utf-8"))["jobs"]

    def test_new_install_gets_an_hourly_script_gated_attached_job(self):
        [job] = self.run_seed([])
        self.assertEqual(job["name"], "proactive-tick")
        self.assertEqual(job["script"], "proactive-tick.py")
        self.assertEqual(job["schedule"]["expr"], "0 8-21 * * *")
        self.assertIs(job["attach_to_session"], True)
        self.assertNotIn("skills", job)
        self.assertNotIn("context_from", job)
        self.assertEqual(job["deliver"], "telegram")
        self.assertIn("[SILENT]", job["prompt"])
        self.assertIn("[CRON_FAILURE]", job["prompt"])

    def test_existing_job_keeps_operator_schedule_and_gets_managed_fields(self):
        mine = {"id": "abc", "name": "proactive-tick", "prompt": "old", "attach_to_session": False,
                "schedule": {"kind": "cron", "expr": "0 12 * * *"}, "enabled": False, "deliver": "local"}
        [job] = self.run_seed([mine])
        self.assertEqual(job["id"], "abc")
        self.assertEqual(job["schedule"]["expr"], "0 12 * * *")
        self.assertIs(job["enabled"], False)
        self.assertEqual(job["deliver"], "local")
        self.assertIs(job["attach_to_session"], True)
        self.assertEqual(job["script"], "proactive-tick.py")
        self.assertNotEqual(job["prompt"], "old")


# Stand-ins the pre-check imports or runs from its own directory. Each reads
# its canned data from $FAKE_DIR so a test controls mail, tasks and login.
FAKE_GMAIL = '''
import json, os
FAKE = os.environ["FAKE_DIR"]
class AuthExpired(Exception):
    pass
def load_token():
    return os.path.exists(os.path.join(FAKE, "gmail-token"))
def list_messages(after_ms=0, limit=20):
    if os.path.exists(os.path.join(FAKE, "gmail-expired")):
        raise AuthExpired()
    with open(os.path.join(FAKE, "mail.json")) as fh:
        return [m for m in json.load(fh) if m["received_ms"] > after_ms][:limit]
'''
FAKE_GTASKS = '''
import os, sys
path = os.path.join(os.environ["FAKE_DIR"], "tasks.json")
if not os.path.exists(path):
    sys.exit("List not found: Friday")
print(open(path).read())
'''


class ProactiveTickScriptTest(unittest.TestCase):
    """The pre-check prints only what is new; empty output means the agent never runs."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.scripts = self.home / "scripts"
        self.scripts.mkdir()
        shutil.copy(TICK_SCRIPT, self.scripts / "proactive-tick.py")
        (self.scripts / "gmail.py").write_text(FAKE_GMAIL)
        (self.scripts / "gtasks.py").write_text(FAKE_GTASKS)
        data = self.home / "mnemosyne" / "data"
        data.mkdir(parents=True)
        self.db = sqlite3.connect(data / "mnemosyne.db")
        self.db.execute("CREATE TABLE canonical_facts (id INTEGER PRIMARY KEY, owner_id TEXT, category TEXT,"
                        " name TEXT, body TEXT, valid_until TEXT)")

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def slot(self, category, name, body, valid_until=None):
        self.db.execute("INSERT INTO canonical_facts (owner_id, category, name, body, valid_until)"
                        " VALUES ('o', ?, ?, ?, ?)", (category, name, body, valid_until))
        self.db.commit()

    def module(self, marker=True):
        site = self.home / "installs/a/environments/b/venv/lib/python3.14/site-packages/mnemosyne_hermes"
        site.mkdir(parents=True, exist_ok=True)
        (site / "__init__.py").write_text("x = 1\n" + ("# friday-patch: mnemosyne read-only in cron\n" if marker else ""))

    def tick(self):
        env = {k: v for k, v in os.environ.items() if k != "MNEMOSYNE_DATA_DIR"}
        result = subprocess.run(["python3", str(self.scripts / "proactive-tick.py")], text=True,
                                capture_output=True,
                                env={**env, "HERMES_HOME": str(self.home), "FAKE_DIR": str(self.home)})
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_nothing_due_prints_nothing(self):
        self.module()
        self.assertEqual(self.tick(), "")
        self.slot("goal", "future", "status: active\ncheck_in: 2999-01-01")
        self.slot("goal", "paused", "status: paused\ncheck_in: daily")
        self.slot("goal", "old", "status: active\ncheck_in: daily", valid_until="2026-01-01")
        self.assertEqual(self.tick(), "")

    def test_due_goal_is_raised_once_a_day_with_preferences(self):
        self.module()
        self.slot("goal", "car-fund", "status: active\ncheck_in: 2026-01-01\nkeywords: car")
        self.slot("goal", "gym", "status: active\ncheck_in: weekly\nupdated: 2026-01-01")
        self.slot("goal", "fresh", "status: active\ncheck_in: weekly\nupdated: 2999-01-01")
        self.slot("notify", "preferences", "no dividend pings")
        out = self.tick()
        self.assertIn("goal `car-fund`", out)
        self.assertIn("goal `gym`", out)
        self.assertNotIn("fresh", out)
        self.assertIn("## notify preferences\nno dividend pings", out)
        self.assertEqual(self.tick(), "")

    def test_missing_patch_alerts_once_a_day(self):
        self.module(marker=False)
        out = self.tick()
        self.assertIn("ALERT: the Mnemosyne cron read-only patch is not applied", out)
        self.assertEqual(self.tick(), "")

    def fake(self, name, data):
        (self.home / name).write_text(json.dumps(data) if not isinstance(data, str) else data)

    def test_mail_is_off_until_login_and_starts_from_now(self):
        self.module()
        self.fake("mail.json", [{"id": "old", "received_ms": 1, "from": "a", "subject": "old", "date": "",
                                 "snippet": ""}])
        self.assertEqual(self.tick(), "")  # no login: source off
        self.fake("gmail-token", "x")
        self.assertEqual(self.tick(), "")  # first tick after login only sets the cursor
        later = int(__import__("time").time() * 1000) + 60_000
        self.fake("mail.json", [{"id": "m1", "received_ms": later, "from": "landlord@example.com",
                                 "subject": "Lease renewal", "date": "", "snippet": "please sign by Friday"}])
        self.fake("tasks.json", [{"id": "t1", "title": "Pay water bill", "status": "needsAction",
                                  "notes": "gmail:abc"}])
        out = self.tick()
        self.assertIn("mail id=m1 | from: landlord@example.com | subject: Lease renewal", out)
        self.assertIn("snippet: please sign by Friday", out)
        self.assertIn("## Friday tasks (open)\n- [id=t1] Pay water bill — gmail:abc", out)
        self.assertEqual(self.tick(), "")  # each message is reported once

    def test_expired_gmail_login_alerts_once_a_day(self):
        self.module()
        self.fake("gmail-token", "x")
        self.tick()
        self.fake("gmail-expired", "x")
        out = self.tick()
        self.assertIn("ALERT: source mail failed: Gmail login expired or was revoked", out)
        self.assertEqual(self.tick(), "")

    def test_due_friday_task_is_raised_once_a_day(self):
        self.module()
        self.fake("tasks.json", [
            {"id": "t1", "title": "Renew passport", "status": "needsAction", "due": "2026-01-01T00:00:00.000Z"},
            {"id": "t2", "title": "Later thing", "status": "needsAction", "due": "2999-01-01T00:00:00.000Z"},
            {"id": "t3", "title": "Done thing", "status": "completed", "due": "2026-01-01T00:00:00.000Z"}])
        out = self.tick()
        self.assertIn("due: - [id=t1] Renew passport (due 2026-01-01)", out)
        self.assertNotIn("due: - [id=t2]", out)
        self.assertNotIn("Done thing", out)
        self.assertEqual(self.tick(), "")

    def test_never_writes_the_memory_db(self):
        self.module()
        self.slot("goal", "car-fund", "status: active\ncheck_in: daily")
        before = self.db.execute("SELECT * FROM canonical_facts").fetchall()
        self.tick()
        self.assertEqual(self.db.execute("SELECT * FROM canonical_facts").fetchall(), before)


class WiringTest(unittest.TestCase):
    def test_image_ships_the_patch_and_the_seed_applies_it(self):
        self.assertIn("COPY patches/patch-mnemosyne-cron-readonly.py /opt/hermes-defaults/patches/", DOCKERFILE)
        self.assertIn("/opt/hermes-defaults/patches/patch-mnemosyne-cron-readonly.py", SEED)
        self.assertIn("site-packages/mnemosyne_hermes/__init__.py", SEED)

    def test_seed_pins_the_mnemosyne_version_the_patch_targets(self):
        # Bumping the pin without re-checking the patch and its hash must fail here.
        version = load_patch_module().PINNED_VERSION
        self.assertIn(f'"mnemosyne-hermes": "mnemosyne-hermes=={version}"', SEED)

    def test_goals_skill_ships(self):
        skill = (HERE.parent / "skills" / "goals" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("name: goals", skill)
        self.assertIn('category="goal"', skill)
        self.assertIn('category="notify", name="preferences"', skill)


if __name__ == "__main__":
    unittest.main()
