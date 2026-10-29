"""Cron sessions recall Mnemosyne memory but never write it; goal-tick is seeded to use it.

The patch is applied to a stand-in provider module with the same method names
the pinned mnemosyne-hermes 0.7.1 provider has, because the real plugin is not
installed in CI. The pinned-hash guard is what binds the patch to the real file.
"""

import hashlib
import importlib.util
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PATCH_PATH = HERE.parent / "patches" / "patch-mnemosyne-cron-readonly.py"
SEED = (HERE.parent / "50-seed-defaults").read_text(encoding="utf-8")
DOCKERFILE = (HERE.parent / "Dockerfile").read_text(encoding="utf-8")

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
GOAL_TICK = next(b for b in BLOCKS if '"goal-tick"' in b)


class GoalTickSeedTest(unittest.TestCase):
    def run_seed(self, jobs):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "jobs.json"
            path.write_text(json.dumps({"jobs": jobs}), encoding="utf-8")
            result = subprocess.run(["python3", "-c", GOAL_TICK.replace("/opt/data/cron/jobs.json", str(path))],
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(path.read_text(encoding="utf-8"))["jobs"]

    def test_new_install_gets_an_attached_job_that_reads_goal_slots(self):
        [job] = self.run_seed([])
        self.assertEqual(job["name"], "goal-tick")
        self.assertIs(job["attach_to_session"], True)
        self.assertEqual(job["context_from"], ["self"])
        self.assertEqual(job["skills"], ["goals"])
        self.assertEqual(job["deliver"], "telegram")
        self.assertIn('mnemosyne_recall_canonical(category="goal")', job["prompt"])
        self.assertIn("[SILENT]", job["prompt"])

    def test_existing_job_keeps_operator_schedule_and_gets_managed_fields(self):
        mine = {"id": "abc", "name": "goal-tick", "prompt": "old", "attach_to_session": False,
                "schedule": {"kind": "cron", "expr": "0 12 * * *"}, "enabled": False, "deliver": "local"}
        [job] = self.run_seed([mine])
        self.assertEqual(job["id"], "abc")
        self.assertEqual(job["schedule"]["expr"], "0 12 * * *")
        self.assertIs(job["enabled"], False)
        self.assertEqual(job["deliver"], "local")
        self.assertIs(job["attach_to_session"], True)
        self.assertNotEqual(job["prompt"], "old")


class WiringTest(unittest.TestCase):
    def test_image_ships_the_patch_and_the_seed_applies_it(self):
        self.assertIn("COPY patches/patch-mnemosyne-cron-readonly.py /opt/hermes-defaults/patches/", DOCKERFILE)
        self.assertIn("/opt/hermes-defaults/patches/patch-mnemosyne-cron-readonly.py", SEED)
        self.assertIn("site-packages/mnemosyne_hermes/__init__.py", SEED)

    def test_goals_skill_ships(self):
        skill = (HERE.parent / "skills" / "goals" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("name: goals", skill)
        self.assertIn('category="goal"', skill)


if __name__ == "__main__":
    unittest.main()
