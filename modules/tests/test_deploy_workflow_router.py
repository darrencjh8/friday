import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml


WORKFLOW = Path(__file__).parents[2] / ".github/workflows/deploy.yml"
SYNC_WORKFLOW = Path(__file__).parents[2] / ".github/workflows/sync-codex-router.yml"
COMPOSE_FILE = Path(__file__).parents[1] / "docker-compose.yml"
TEST_WORKFLOW = Path(__file__).parents[2] / ".github/workflows/test.yml"
HERMES_STABLE_WORKFLOW = Path(__file__).parents[2] / ".github/workflows/hermes-stable-update.yml"
ROUTER_CI_WORKFLOW = Path(__file__).parents[2] / ".github/workflows/codex-router-ci.yml"
DEPLOY_SCRIPT = Path(__file__).parents[1] / "deploy.sh"
HERMES_CONFIG = Path(__file__).parents[1] / "hermes/config.yaml"
HERMES_DOCKERFILE = Path(__file__).parents[1] / "hermes/Dockerfile"
BEHAVIOUR_SUITE = Path(__file__).parents[1] / "hermes/tests/test-refresh-codex-router-checkout.sh"


class DeployWorkflowRouterTests(unittest.TestCase):
    def test_checks_out_codex_router_main_and_rebuilds_for_router_changes(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        checkout = "repository: darrencjh8/codex-router\n                  ref: main"
        self.assertIn(checkout, workflow)
        self.assertIn('grep -qE "^(\\.github/workflows/deploy\\.yml|modules/(docker-compose\\.yml|deploy\\.sh))$"', workflow)
        self.assertIn('COMPONENTS="$COMPONENTS codex-router"', workflow)
        self.assertIn("else\n                      ARGS=\"\"", workflow)

    def test_records_router_revision_only_when_router_deploys(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        condition = (
            "steps.changes.outputs.components == 'all' || "
            "contains(format(' {0} ', steps.changes.outputs.components), ' codex-router ')"
        )
        self.assertEqual(workflow.count(condition), 2)
        self.assertIn("name: codex-router-sha", workflow)

    def test_sync_reads_newest_router_artifact_with_github_token(self):
        workflow = SYNC_WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("GH_TOKEN: ${{ secrets.SUBMODULE_PAT }}", workflow)
        self.assertIn("GH_TOKEN: ${{ github.token }}", workflow)
        self.assertIn("while [ -z \"$deployed_sha\" ]; do", workflow)
        self.assertIn("actions/workflows/deploy.yml/runs?branch=main&status=success&per_page=100&page=$page", workflow)
        self.assertIn("for run_id in $run_ids; do", workflow)
        self.assertIn("cat /tmp/router-sha/codex-router-sha.txt", workflow)

    def test_pins_expense_tracker_litellm_routing_in_deploy_workflow(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        # Repository variables still drive routing, but the default primary
        # model is the router's explicit cross-provider pool.
        self.assertIn("LLM_PROVIDER: ${{ vars.LLM_PROVIDER || 'litellm' }}", workflow)
        self.assertIn("LLM_BASE_URL: ${{ vars.LLM_BASE_URL || 'http://codex-router:4100/v1' }}", workflow)
        self.assertIn("LLM_MODEL: ${{ vars.LLM_MODEL || 'auto-thinking' }}", workflow)
        self.assertIn("LLM_REASONING_EFFORT: ${{ vars.LLM_REASONING_EFFORT || 'low' }}", workflow)
        self.assertIn("LLM_FALLBACK_MODEL: ${{ vars.LLM_FALLBACK_MODEL || '' }}", workflow)
        self.assertIn("LLM_FINAL_FALLBACK_PROVIDER: ${{ vars.LLM_FINAL_FALLBACK_PROVIDER || 'deepseek' }}", workflow)
        self.assertIn("LLM_FINAL_FALLBACK_MODEL: ${{ vars.LLM_FINAL_FALLBACK_MODEL || 'deepseek-flash' }}", workflow)

        # Credentials remain in secrets
        self.assertIn("LLM_API_KEY: ${{ secrets.LLM_API_KEY }}", workflow)
        self.assertIn("CODEX_ROUTER_AUTH_PASSWORD: ${{ secrets.CODEX_ROUTER_AUTH_PASSWORD }}", workflow)
        self.assertIn("DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}", workflow)
        # The router routes to external providers again, so their keys travel to
        # the deploy environment; hermes still never receives them.
        self.assertIn("OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}", workflow)
        self.assertIn("OPENCODE_ZEN_API_KEY: ${{ secrets.OPENCODE_ZEN_API_KEY }}", workflow)

    def test_compose_passes_expense_tracker_fallback_env_vars(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        env_list = compose["services"]["expense-tracker"]["environment"]

        self.assertIn("LLM_MODEL=${LLM_MODEL:-auto-thinking}", env_list)
        self.assertIn("LLM_FALLBACK_MODEL=${LLM_FALLBACK_MODEL:-}", env_list)
        self.assertIn("LLM_FINAL_FALLBACK_PROVIDER=${LLM_FINAL_FALLBACK_PROVIDER:-deepseek}", env_list)
        self.assertIn("LLM_FINAL_FALLBACK_MODEL=${LLM_FINAL_FALLBACK_MODEL:-deepseek-flash}", env_list)

    def test_compose_passes_portfolio_tracker_router_env_vars(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        env_list = compose["services"]["portfolio-tracker"]["environment"]

        self.assertIn("LLM_BASE_URL=${LLM_BASE_URL:-http://codex-router:4100/v1}", env_list)
        self.assertIn("LLM_MODEL=${LLM_MODEL:-auto-thinking}", env_list)
        self.assertIn("LLM_API_KEY=${LLM_API_KEY:-}", env_list)
        self.assertIn("LLM_REASONING_EFFORT=${LLM_REASONING_EFFORT:-low}", env_list)

    def test_external_provider_keys_reach_the_router_and_not_hermes(self):
        # codex-router owns these providers. PR #443 retired the Zen key while
        # the router had no Zen route; the router routes to Zen, Go and Meta
        # again, so the keys belong on the router service only — except the
        # Meta key, which in-container direct callers also need (see
        # test_hermes_service_forwards_the_model_key).
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        # The router runs as two colour containers behind the caddy front; the
        # front carries no router env of its own.
        for colour in ("codex-router-a", "codex-router-b"):
            router_env = compose["services"][colour]["environment"]
            for key in ("OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENCODE_GO_API_KEY", "MODEL_API_KEY"):
                self.assertIn(f"{key}=${{{key}:-}}", router_env)
        self.assertNotIn("environment", compose["services"]["codex-router"])

        deploy_script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        router_section = deploy_script.split("# ---- codex-router ----", 1)[1].split("# ---- pluggable modules", 1)[0]
        for key in ("OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENCODE_GO_API_KEY", "MODEL_API_KEY"):
            self.assertIn(f'check_var_optional "{key}"', router_section)

    def test_opencode_go_key_is_not_passed_to_hermes(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        hermes_env = compose["services"]["hermes"]["environment"]
        for key in ("OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY"):
            self.assertNotIn(f"{key}=${{{key}:-}}", hermes_env)
        # MODEL_API_KEY is the exception: in-container Meta-direct callers read
        # it, so Hermes forwards it (see test_hermes_service_forwards_the_model_key
        # in test_codex_router_provider_env).
        self.assertIn("MODEL_API_KEY=${MODEL_API_KEY:-}", hermes_env)

        deploy_script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        hermes_section = deploy_script.split("# ---- Hermes ----", 1)[1].split("# ---- portfolio-tracker", 1)[0]
        for key in ("OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY", "MODEL_API_KEY"):
            self.assertNotIn(key, hermes_section)

    def test_public_workflow_runs_private_router_tests_at_an_explicit_ref(self):
        workflow = ROUTER_CI_WORKFLOW.read_text(encoding="utf-8")
        config = yaml.safe_load(workflow)
        unit_job = config["jobs"]["test"]
        self.assertIn("live-providers", config["jobs"])
        live_job = config["jobs"]["live-providers"]
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("repository_dispatch:", workflow)
        self.assertIn("repository: darrencjh8/codex-router", workflow)
        self.assertIn("ref: ${{", workflow)
        self.assertIn("token: ${{ secrets.SUBMODULE_PAT }}", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn('python -m unittest discover -s tests -p "test_*.py"', workflow)
        self.assertIn("bash tests/test_docker.sh", workflow)
        self.assertNotIn("environment", unit_job)
        self.assertEqual(live_job["environment"], "darren-prod")
        self.assertEqual(live_job["if"], "github.ref == 'refs/heads/main'")
        self.assertNotIn("OPENCODE_API_KEY", workflow)
        self.assertIn("ref: main", workflow)

    def test_external_provider_smoke_uses_trusted_router_main(self):
        workflow = yaml.safe_load(ROUTER_CI_WORKFLOW.read_text(encoding="utf-8"))
        live_steps = {step["name"]: step for step in workflow["jobs"]["live-providers"]["steps"] if "name" in step}
        checkout = live_steps["Check out trusted Codex Router smoke tests"]["with"]
        self.assertEqual(checkout["repository"], "darrencjh8/codex-router")
        self.assertEqual(checkout["ref"], "main")
        self.assertEqual(checkout["path"], "trusted-router")
        smoke = live_steps["Smoke-test auto-thinking external providers"]
        self.assertEqual(smoke["working-directory"], "trusted-router")
        self.assertEqual(
            set(smoke["env"]),
            {"DEEPSEEK_API_KEY"},
        )
        self.assertIn("python tests/test_provider_smoke_live.py", smoke["run"])

    def test_code_reviewer_escalates_instead_of_dropping_tier(self):
        reviewer = yaml.safe_load((Path(__file__).parents[1] / "hermes/profiles/code-reviewer/config.yaml").read_text(encoding="utf-8"))
        self.assertEqual(
            reviewer["model"],
            {"provider": "custom:codex-router", "default": "auto-thinking"},
        )
        # The reviewer runs the pooled route with the direct vanilla deepseek
        # route as its terminal fallback when the pool is unavailable.
        self.assertEqual(
            reviewer["fallback_providers"],
            [{"provider": "deepseek", "model": "deepseek-flash"}],
        )
        self.assertFalse(reviewer["memory"]["memory_enabled"])
        self.assertEqual(reviewer["agent"]["reasoning_effort"], "high")

    def test_public_test_workflow_discovers_all_module_contract_tests(self):
        workflow = TEST_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("python -m unittest discover -s modules/tests -p 'test_*.py'", workflow)

    def test_hermes_custom_endpoint_contract_uses_responses_transport(self):
        config = yaml.safe_load(HERMES_CONFIG.read_text(encoding="utf-8"))
        provider = config["providers"]["codex-router"]
        self.assertEqual(provider["api"], "http://codex-router:4100/v1")
        self.assertEqual(provider["transport"], "codex_responses")
        self.assertEqual(config["model"]["provider"], "custom:codex-router")

    def test_hermes_deploy_health_gate_checks_gateway_not_dashboard_port(self):
        deploy_script = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # The dashboard is enabled with basic auth, so no unauthenticated port
        # probe can gate the deploy. The supervised gateway s6 service stays
        # the gate; credential presence is enforced by the preflight above.
        self.assertNotIn("9119", deploy_script)
        self.assertIn(
            "/package/admin/s6/command/s6-svstat -o up /run/service/gateway-default",
            deploy_script,
        )
        self.assertIn("HERMES_DASHBOARD_BASIC_AUTH_USERNAME", deploy_script)
        self.assertIn("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD", deploy_script)

    def test_hermes_gateway_health_gate_outlasts_a_slow_start(self):
        # Measured 2026-10-09: the gateway came up 2.5 minutes after container start
        # (config migration, profile seeding, state.db integrity check), but the gate
        # gave up after 90 seconds and failed deploy 585 with the gateway healthy.
        # Measured 2026-10-27: a one-time Mnemosyne dependency sync at boot plus the
        # same integrity check took 7 minutes and failed the 5-minute gate of the
        # PR #68 deploy, so the budget now covers 11 minutes.
        import re

        block = DEPLOY_SCRIPT.read_text(encoding="utf-8").split("# Hermes gateway (the dashboard", 1)[1]
        block = block.split('echo -e "  ${GREEN}✓ hermes gateway${NC}"', 1)[0]
        initial = int(re.search(r"sleep (\d+)\n\s*gateway_up=false", block).group(1))
        tries = int(re.search(r"seq 1 (\d+)", block).group(1))
        step = int(re.search(r"done\n", block) and re.findall(r"sleep (\d+)", block)[-1])
        self.assertGreaterEqual(initial + tries * step, 660)

    def test_hermes_container_checkout_is_refreshed(self):
        # Dev-loop sessions in the Hermes container drive the gate from their own
        # checkout (`codex/skills/dev-loop/scripts/loop.py`), so a checkout pinned
        # to an old revision runs an old gate no matter what the skill roots hold.
        # Measured 2026-09-25: the reconciled roots were current while
        # /workspace/codex-router sat at 2e0fcfc, six commits behind origin/main,
        # so the shipped driver never reached a session. Two writers must advance
        # it: the deploy to the revision it checked out, and boot to main.
        deploy_script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        checkout_block = deploy_script.split("# ---- Hermes container codex-router checkout ----", 1)[1].split(
            "# Hermes gateway", 1
        )[0]

        # Two arms are enough: should_deploy returns 0 as soon as any component is
        # `all`, so a full deploy reaches this block through the named arms. The test
        # pins the two-arm form so a redundant third arm cannot creep back in.
        self.assertIn('should_deploy "codex-router" || should_deploy "hermes"', checkout_block)
        self.assertNotIn('should_deploy "all"', checkout_block)
        # Deterministic target: the revision this deploy checked out, never
        # whatever main happens to be at deploy time.
        self.assertIn('git -C "$ROOT/modules/codex-router" rev-parse HEAD', checkout_block)
        self.assertIn("modules/hermes/scripts/refresh-codex-router-checkout.sh", checkout_block)
        # The checkout belongs to the container's hermes user; root writes would
        # leave its objects unwritable for the sessions that create worktrees.
        # The owner, plus a lock wait longer than the boot fetch bound: a saturating
        # fetch during a hermes recreate must not turn into a red deploy. The PAT
        # goes in as well, because the gate runs before the workflow installs gh and
        # a refresh that needs the gh binary cannot pass without it.
        self.assertIn("docker exec -e CODEX_ROUTER_LOCK_WAIT_SECONDS=300 -e GH_TOKEN=\"${FRIDAY_PAT:-}\" -u hermes hermes", checkout_block)
        self.assertIn("failed=$((failed + 1))", checkout_block)
        # A hermes deploy recreates the container, so the block must wait for it
        # rather than run docker exec against a container that is still starting.
        self.assertIn("for _ in $(seq 1 15)", checkout_block)
        self.assertIn("docker exec hermes true", checkout_block)
        # The copy, the run, the removal and the outcome report are the block's
        # behaviour, so they are pinned rather than left to wording.
        self.assertIn("docker cp \"$CHECKOUT_SCRIPT\" hermes:/tmp/refresh-codex-router-checkout.sh", checkout_block)
        self.assertIn("docker exec -e CODEX_ROUTER_LOCK_WAIT_SECONDS=300 -e GH_TOKEN=\"${FRIDAY_PAT:-}\" -u hermes hermes sh /tmp/refresh-codex-router-checkout.sh", checkout_block)
        self.assertIn("docker exec hermes rm -f /tmp/refresh-codex-router-checkout.sh", checkout_block)
        # The recovery recipe is pasted into an interactive shell, where history
        # expansion rewrites an unquoted `!gh`; the outer single quotes are what
        # keep the helper intact, so the runnable form is pinned verbatim.
        deploy_doc = (Path(__file__).parents[2] / "DEPLOY.md").read_text(encoding="utf-8")
        self.assertIn(
            "docker exec -u hermes hermes sh -c 'git -C /workspace/codex-router "
            "-c credential.helper=\"!gh auth git-credential\" fetch origin main",
            deploy_doc,
            "the recovery command must be paste-safe: outer single quotes, inner double quotes",
        )
        self.assertIn("--- Hermes Codex Router Checkout ---", checkout_block)
        self.assertIn("hermes codex-router checkout is at this deploy's revision", checkout_block)
        self.assertIn("hermes codex-router checkout left alone", checkout_block)
        self.assertIn("hermes codex-router checkout could not be advanced", checkout_block)
        # The success line is printed from the script's own output, not the exit code,
        # so the four exit-0 skip outcomes cannot report success on a stale checkout.
        # Pin the discriminating line verbatim, so a revert to exit-code-only success
        # cannot stay green behind a substring the success sentence already contains.
        self.assertIn('if printf \'%s\' "$CHECKOUT_OUTPUT" | grep -q "is at "; then', checkout_block)
        self.assertIn("CHECKOUT_OUTPUT=", checkout_block)

        refresh = Path(__file__).parents[1] / "hermes/scripts/refresh-codex-router-checkout.sh"
        self.assertTrue(refresh.is_file(), "refresh script is shipped")
        self.assertTrue(refresh.stat().st_mode & 0o111, "refresh script is executable")
        refresh_body = refresh.read_text(encoding="utf-8")
        # The deploy runs it as `sh <path>` and the boot hook execs it, so the body
        # must be POSIX shell: a bash-only body would pass a bash-only suite and
        # then fail every codex-router deploy under dash.
        self.assertTrue(refresh_body.startswith("#!/bin/sh\n"), "refresh script is POSIX sh")
        self.assertIn("set -eu", refresh_body)
        # A dirty checkout belongs to a live session: skip it, never force it.
        self.assertIn("status --porcelain", refresh_body)
        self.assertIn("--ff-only", refresh_body)
        self.assertIn("credential.helper", refresh_body)
        # A session branch — or a detached HEAD — in the base repository is not
        # ours to move.
        self.assertIn("rev-parse --abbrev-ref HEAD", refresh_body)
        # Two writers can overlap (a hermes deploy recreates the container while
        # the boot hook runs), so they serialize on a lock with a bounded wait.
        self.assertIn("flock", refresh_body)
        self.assertIn("CODEX_ROUTER_LOCK_WAIT_SECONDS", refresh_body)
        # A hung fetch would hold the lock past its bound and block both callers.
        self.assertIn("timeout --kill-after=10 120", refresh_body)
        # The safety claim is the absence of the destructive alternatives: this
        # script must never have a way to discard a session's work or touch a
        # session's checkout. The check covers comments too, which is why the file
        # may not name the forbidden literal anywhere.
        for destructive in ("reset --hard", "stash", "rebase", "checkout -f", "push --force", "worktree"):
            self.assertNotIn(destructive, refresh_body)
        # The expected branch is a literal: no call site sets a branch override.
        self.assertNotIn("CODEX_ROUTER_BRANCH", refresh_body)
        self.assertNotIn("CODEX_ROUTER_BRANCH", checkout_block)

        boot = (Path(__file__).parents[1] / "hermes/50-seed-defaults").read_text(encoding="utf-8")
        # The baked path, not a filename match: /opt/data/scripts/ holds a copy that
        # a fresh volume may not have reseeded yet. Scope the fallback PAT to this
        # legacy checkout refresh; it must not remain ambient for other gh
        # invocations, so it is read from the root-only secret file, not FRIDAY_PAT.
        self.assertIn('GH_TOKEN="$(cat /run/secrets/friday_pat)"', boot)
        self.assertNotIn("FRIDAY_PAT", boot)
        # `su -m` preserves the environment, so the prefix assignment reaches the
        # su'd shell: the single-quoted body stays unexpanded and lint-clean.
        self.assertIn(
            "GH_TOKEN=\"$(cat /run/secrets/friday_pat)\" su -m -s /bin/sh hermes -c '/opt/hermes-defaults/scripts/refresh-codex-router-checkout.sh'",
            boot,
        )
        # A boot hook may not fail the boot: the refresh call carries a fallback
        # that reports the failure and lets the boot continue.
        self.assertIn('|| echo "WARNING: could not advance the codex-router checkout', boot)
        # Placement matters twice over. test-50-seed-defaults.sh extracts and
        # executes the skills probe block and asserts its log exactly, so the call
        # must sit after that block's fi; and the fetch needs a credential, which
        # the auth block installs through the shared helper, so it must also sit
        # after that block.
        probe_end = boot.index("sync-codex-router-skills.sh 2>/dev/null || true\nfi")
        call_index = boot.index("refresh-codex-router-checkout.sh", probe_end)
        self.assertGreater(call_index, probe_end)
        auth_index = boot.index("Configure gh CLI authentication")
        self.assertGreater(call_index, auth_index)

    def test_the_checkout_refresh_classifier_leaves_a_skipped_checkout_alone(self):
        """The deploy's success signal is derived from the script's report.

        The classifier is executed against the script's real stdout, not against a
        copy of it: the behaviour suite captures that output for the advance and for
        each skip path and runs the deploy block's extracted classifier over it, so
        rewording a notice cannot turn a stale checkout into a reported success.
        """
        behaviour = BEHAVIOUR_SUITE.read_text(encoding="utf-8")
        self.assertIn("CLASSIFIER=$(sed -n '/grep -q \"is at \"; then/", behaviour)
        self.assertIn(
            'expect_classified "the deploy reports a real advance as success" "$out" success', behaviour,
            "if the refresh script never reports a token the deploy classifier matches, a real advance "
            "is reported as left alone",
        )
        self.assertIn('expect_classified "the deploy reports a real advance as success" "$out" success', behaviour)
        self.assertIn('expect_classified "the deploy leaves a dirty checkout alone" "$out" alone', behaviour)
        completed = subprocess.run(["bash", str(BEHAVIOUR_SUITE)], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stdout[-2000:])

    def test_hermes_deploy_health_gate_retries_before_failing(self):
        deploy_script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        gate = deploy_script.split("# Hermes gateway", 1)[1].split(
            "# Pluggable module health checks", 1
        )[0]

        # A single check after the fixed sleep is not enough: cont-init registers
        # the supervised gateway after container start, so the gate must poll it
        # with the same bounded budget the HTTP health checks used.
        self.assertRegex(gate, r"for _ in \$\(seq 1 10\)")
        self.assertIn("sleep 6", gate)


    def test_pat_secret_file_lifecycle(self):
        """T-secret-file-delivery: the fallback PAT is delivered as a root-only
        file, never as an ambient service variable.

        The security property is the delivery path, so this asserts the exact host
        path, mode 0400, atomic creation, the always-present regular-file
        invariant, and that the service environment cannot carry the PAT. The file
        must be written without sudo: the self-hosted runner has no passwordless
        sudo, and the target directory belongs to the container's hermes uid 10000,
        so a one-shot root container writes the file instead. It is gated: without
        the change the file is never created and the service still exports
        FRIDAY_PAT.
        """
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        secret_path = "/home/runner/data/hermes/friday_pat.secret"
        self.assertIn(f'SECRET_FILE="{secret_path}"', deploy)
        # The PAT reaches the writer on stdin, so it stays out of argv, out of the
        # environment, and out of the build log.
        self.assertIn('printf \'%s\' "${FRIDAY_PAT:-}" | docker run --rm -i --network none', deploy)
        self.assertIn('-v "$SECRET_DIR:/secrets"', deploy)
        # Mode 0400 on the file that is mounted into the container; the writer runs
        # as root and the hermes container reads the file as root.
        self.assertIn('chmod 0400 "$tmp"', deploy)
        # Atomic creation: a same-directory temp file renamed into place.
        self.assertIn('tmp="$(mktemp /secrets/.friday_pat.XXXXXX)"', deploy)
        self.assertIn('mv -f "$tmp" /secrets/friday_pat.secret', deploy)
        self.assertIn("umask 077", deploy)
        # No step of the secret delivery may require an interactive sudo password.
        secret_block = deploy[deploy.index("scoped fallback PAT secret"):deploy.index("$COMPOSE config -q")]
        self.assertNotIn("sudo ", secret_block)
        # The path must stay a regular file: a directory left by an earlier
        # missing-source mount is repaired before writing.
        self.assertIn('if [ -d /secrets/friday_pat.secret ]', deploy)
        # The file is materialized before any compose config/up call, and the PAT
        # is never passed through the service environment.
        secret_index = deploy.index("scoped fallback PAT secret")
        compose_index = deploy.index("$COMPOSE config -q")
        self.assertLess(secret_index, compose_index)

        compose = COMPOSE_FILE.read_text(encoding="utf-8")
        # The host file is bind-mounted read-only as the container's secret.
        self.assertIn(f"{secret_path}:/run/secrets/friday_pat:ro", compose)
        # No service environment may export the PAT.
        self.assertNotIn("FRIDAY_PAT=", compose)

    def test_deploy_workflow_delivers_the_pat_secret_without_ambient_export(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        # The workflow still supplies the secret to the deploy process, which is
        # what writes the root-only file the container mounts.
        self.assertIn("FRIDAY_PAT: ${{ secrets.FRIDAY_PAT }}", workflow)
        compose = COMPOSE_FILE.read_text(encoding="utf-8")
        self.assertNotIn("FRIDAY_PAT=${FRIDAY_PAT}", compose)


    def test_hermes_image_uses_stable_channel_and_bakes_no_cli_tools(self):
        dockerfile = HERMES_DOCKERFILE.read_text(encoding="utf-8")

        first_line = dockerfile.splitlines()[0]
        self.assertRegex(
            first_line,
            r"^FROM nousresearch/hermes-agent:stable@sha256:[a-f0-9]{64}$",
        )
        # gh and ntn are installed into the persisted /opt/data volume by
        # deploy.yml, so rebuilding the image must not reinstall them.
        self.assertNotIn("npm install --global", dockerfile)
        self.assertNotIn("\n    gh \\", dockerfile)

    def test_stable_digest_workflow_updates_the_pin_and_only_opens_review_prs(self):
        workflow = yaml.load(
            HERMES_STABLE_WORKFLOW.read_text(encoding="utf-8"),
            Loader=yaml.BaseLoader,
        )
        self.assertIn("schedule", workflow["on"])
        self.assertIn("workflow_dispatch", workflow["on"])
        self.assertEqual("read", workflow["permissions"]["contents"])
        self.assertNotIn("pull-requests", workflow["permissions"])
        steps = workflow["jobs"]["update-digest"]["steps"]
        updater = next(step for step in steps if step.get("id") == "digest")
        app_token = next(
            step
            for step in steps
            if step.get("uses", "").startswith("actions/create-github-app-token@")
        )
        self.assertEqual("write", app_token["with"]["permission-contents"])
        self.assertEqual("write", app_token["with"]["permission-pull-requests"])
        pr = next(
            step
            for step in steps
            if step.get("uses", "").startswith("peter-evans/create-pull-request@")
        )
        self.assertEqual("${{ steps.app-token.outputs.token }}", pr["with"]["token"])
        self.assertNotIn("auto-merge", pr["with"])

        old_digest = "0" * 64
        new_digest = "b" * 64
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            dockerfile = tmp_path / "modules/hermes/Dockerfile"
            dockerfile.parent.mkdir(parents=True)
            dockerfile.write_text(
                f"FROM nousresearch/hermes-agent:stable@sha256:{old_digest}\n",
                encoding="utf-8",
            )
            bin_dir = tmp_path / "bin"
            bin_dir.mkdir()
            curl = bin_dir / "curl"
            curl.write_text(
                "#!/bin/sh\n"
                'case "$*" in *auth.docker.io*) printf \'{"token":"test"}\\n\' ;; '
                f'*) printf \'docker-content-digest: sha256:{new_digest}\\r\\n\' ;; esac\n',
                encoding="utf-8",
            )
            curl.chmod(0o755)
            github_output = tmp_path / "github-output"
            env = {
                **os.environ,
                "PATH": f"{bin_dir}:{os.environ['PATH']}",
                "GITHUB_OUTPUT": str(github_output),
            }
            result = subprocess.run(
                ["bash", "-e", "-c", updater["run"]],
                cwd=tmp_path,
                env=env,
                capture_output=True,
                text=True,
            )
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertEqual(
                f"FROM nousresearch/hermes-agent:stable@sha256:{new_digest}\n",
                dockerfile.read_text(encoding="utf-8"),
            )
            self.assertIn(
                f"digest=sha256:{new_digest}",
                github_output.read_text(encoding="utf-8"),
            )

    def test_deploy_installs_hermes_cli_tools_into_the_persisted_volume(self):
        workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
        steps = workflow["jobs"]["deploy"]["steps"]
        named = {step.get("name"): step for step in steps}
        step = named["Ensure Hermes container tooling"]
        run = step["run"]

        # /opt/data is the persisted volume and is already on the image PATH.
        self.assertIn("/opt/data/.local", run)
        # Idempotent: install only when the tool is missing.
        self.assertIn("command -v gh", run)
        self.assertIn("command -v ntn", run)
        self.assertIn("npm install --global --prefix /opt/data/.local ntn", run)
        # The release lookup is authenticated, so a per-IP rate limit cannot
        # fail the deploy.
        self.assertIn("Authorization: Bearer ${GH_TOKEN}", run)
        self.assertIn("GH_TOKEN", step["env"])
        # Hermes-only, and after the container is up.
        self.assertIn("hermes", step["if"])
        names = [s.get("name") for s in steps]
        self.assertLess(names.index("Deploy services"), names.index("Ensure Hermes container tooling"))

    def test_hermes_build_installs_codex_router_dependencies(self):
        dockerfile = HERMES_DOCKERFILE.read_text(encoding="utf-8")
        requirements = HERMES_DOCKERFILE.parent / "requirements-codex-router.txt"
        self.assertTrue(requirements.is_file())
        self.assertIn("COPY requirements-codex-router.txt /tmp/requirements-codex-router.txt", dockerfile)
        # The Hermes venv is sealed and has no pip, and these pins would downgrade
        # its core packages (mcp, uvicorn, rich), so they get their own venv.
        self.assertNotIn("/opt/hermes/.venv/bin/pip", dockerfile)
        self.assertIn('print(uv_launcher("uv"))', dockerfile)
        self.assertIn('"$uv_bin" venv /opt/codex-router-venv', dockerfile)
        self.assertIn(
            '"$uv_bin" pip install --no-cache --python /opt/codex-router-venv/bin/python \\\n'
            "        --requirement /tmp/requirements-codex-router.txt",
            dockerfile,
        )
        self.assertIn("/usr/local/bin/codex-router-python", dockerfile)
        self.assertNotIn("docker exec hermes", dockerfile)
        self.assertLess(
            dockerfile.index("requirements-codex-router.txt"),
            dockerfile.index("COPY config.yaml"),
        )


    def test_manual_deploy_smokes_the_ref_it_will_deploy(self):
        """The deploy job checks out inputs.ref, so the reusable test workflow has
        to smoke that same tree; otherwise a manual deploy of another branch or
        commit builds the image with the smoke gate skipped or aimed elsewhere."""
        workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
        test_workflow = yaml.safe_load(TEST_WORKFLOW.read_text(encoding="utf-8"))

        call = workflow["jobs"]["test"]
        self.assertEqual(
            call.get("with", {}).get("ref"),
            "${{ github.event.inputs.ref || github.sha }}",
        )

        inputs = test_workflow[True]["workflow_call"]["inputs"]
        self.assertIn("ref", inputs)

        steps = test_workflow["jobs"]["hermes-webui-image"]["steps"]
        self.assertEqual(steps[0]["with"]["ref"], "${{ inputs.ref }}")
        resolver = next(
            step for step in steps if step.get("name") == "Resolve changed image inputs"
        )["run"]
        self.assertIn("git merge-base origin/main", resolver)

    def test_image_job_waits_for_the_webui_port_before_failing(self):
        """s6 reports the service up as soon as its run script starts, which is
        before the WebUI binds 8787, so a single probe fails on a healthy image.
        Both probes must retry on a bounded budget."""
        workflow = yaml.safe_load(TEST_WORKFLOW.read_text(encoding="utf-8"))
        steps = workflow["jobs"]["hermes-webui-image"]["steps"]
        boot = next(
            step for step in steps if step.get("name") == "Boot the image and probe the WebUI"
        )["run"]

        self.assertRegex(boot, r"wait_for_health\(\) \{")
        self.assertIn("for _ in $(seq 1 30)", boot)
        self.assertIn(
            "wait_for_health in-container docker exec hermes-webui-test curl", boot
        )
        self.assertIn("wait_for_health published-port curl", boot)

    def test_image_job_smokes_the_chat_path_through_the_service(self):
        """The agent venv resolves the real agent whatever the launcher's agent
        dir says, so the chat smoke replaces the resolved module inside the
        throwaway container and restarts the supervised service, then talks to
        the port the deploy publishes instead of a second WebUI."""
        workflow = yaml.safe_load(TEST_WORKFLOW.read_text(encoding="utf-8"))
        steps = workflow["jobs"]["hermes-webui-image"]["steps"]
        boot = next(
            step for step in steps if step.get("name") == "Boot the image and probe the WebUI"
        )["run"]

        self.assertIn("import run_agent; print(run_agent.__file__)", boot)
        self.assertIn("/command/s6-svc -r /run/service/hermes-webui", boot)
        self.assertIn("http://127.0.0.1:8787/api/chat", boot)
        self.assertNotIn("8788", boot)


if __name__ == "__main__":
    unittest.main()
