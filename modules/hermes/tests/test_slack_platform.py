"""Regression tests for the Hermes Slack platform integration.

Hermes supports Slack through its official adapter (slack-bolt, Socket Mode).
Credentials live in environment variables; behaviour lives under
``platforms.slack`` in ``modules/hermes/config.yaml``. This suite asserts the
repository wiring end to end, because a missing link in any of the four files
below silently produces a bot that starts but never connects:

1. config.yaml          -> platform block declared, ordered, and gated correctly
2. docker-compose.yml   -> credentials reach the container
3. deploy.yml           -> GitHub secrets/vars reach compose
4. deploy.sh            -> deployment validates credentials when Slack is on

Socket Mode is a WebSocket client, so no published port is expected.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
HERMES_CONFIG = REPO_ROOT / "modules" / "hermes" / "config.yaml"
COMPOSE_FILE = REPO_ROOT / "modules" / "docker-compose.yml"
DEPLOY_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "deploy.yml"
DEPLOY_SCRIPT = REPO_ROOT / "modules" / "deploy.sh"
MANIFEST_SCRIPT = REPO_ROOT / "modules" / "hermes" / "scripts" / "slack-manifest.sh"

# Credential env vars the official Slack adapter reads.
REQUIRED_CREDENTIALS = ("SLACK_BOT_TOKEN", "SLACK_APP_TOKEN")
# Non-secret config, supplied from repository variables.
REQUIRED_VARS = ("SLACK_ALLOWED_USERS", "SLACK_HOME_CHANNEL", "SLACK_HOME_CHANNEL_NAME")


def _extract_probe_source() -> str:
    """Pull slack_platform_enabled() out of deploy.sh so tests can run it."""
    text = DEPLOY_SCRIPT.read_text(encoding="utf-8")
    match = re.search(
        r"^(slack_platform_enabled\(\) \{.*?^\})",
        text,
        re.DOTALL | re.MULTILINE,
    )
    if match is None:
        raise AssertionError("slack_platform_enabled() not found in modules/deploy.sh")
    return match.group(1)


probe_source = _extract_probe_source()


class HermesSlackConfigTests(unittest.TestCase):
    """platforms.slack must be declared, schema-correct, and safe to enable."""

    def setUp(self) -> None:
        self.config = yaml.safe_load(HERMES_CONFIG.read_text(encoding="utf-8"))

    def _slack(self) -> dict:
        """Return platforms.slack, failing the test instead of raising KeyError."""
        platforms = self.config.get("platforms") or {}
        self.assertIn("slack", platforms, "platforms.slack missing from config.yaml")
        slack = platforms["slack"]
        self.assertIsInstance(slack, dict, "platforms.slack must be a mapping")
        return slack

    def test_slack_platform_ships_enabled(self) -> None:
        """The block ships enabled; the flag must be explicit and boolean."""
        self.assertIsInstance(
            self._slack().get("enabled"),
            bool,
            "platforms.slack.enabled must be an explicit YAML boolean",
        )
        self.assertTrue(
            self._slack().get("enabled"),
            "platforms.slack.enabled must ship true — the Slack app and its "
            "tokens exist, and deploy.sh gates the tokens on this flag",
        )

    def test_slack_answers_without_a_mention_in_every_channel(self) -> None:
        """Free response: no mention gate, and no channel whitelist.

        ``allowed_channels`` set to any value silently drops messages from
        every channel not listed, which would defeat the free-response mode
        this configuration exists to provide.
        """
        extra = self._slack().get("extra") or {}
        self.assertIn("require_mention", extra, "require_mention must be explicit")
        self.assertIs(
            extra.get("require_mention"),
            False,
            "require_mention must be false to answer without an @mention",
        )
        self.assertNotIn(
            "allowed_channels",
            extra,
            "allowed_channels is a whitelist; leaving it unset is what lets the "
            "bot answer in every channel it is invited to",
        )

    def test_slack_reply_mode_is_a_valid_value(self) -> None:
        self.assertIn(self._slack().get("reply_to_mode"), {"off", "first", "all"})

    def test_slack_extra_block_uses_documented_keys(self) -> None:
        extra = self._slack().get("extra") or {}
        self.assertIsInstance(extra, dict)

        allowed = {
            "reply_in_thread",
            "reply_broadcast",
            "unfurl_links",
            "unfurl_media",
            "rich_blocks",
            "feedback_buttons",
            "native_task_cards",
            "suggested_prompts",
            "assistant_thread_titles",
            "allow_bots",
            "api_human_users",
            "cron_continuable_surface",
            "require_mention",
        }
        unknown = set(extra) - allowed
        self.assertEqual(set(), unknown, f"undocumented platforms.slack.extra keys: {unknown}")

        if "allow_bots" in extra:
            self.assertIn(extra["allow_bots"], {"none", "mentions", "all"})

    def test_config_holds_no_slack_credentials(self) -> None:
        """Tokens belong in .env / GitHub secrets, never in the tracked YAML."""
        raw = HERMES_CONFIG.read_text(encoding="utf-8")

        self.assertNotRegex(raw, r"xoxb-[A-Za-z0-9-]{10,}", "bot token committed to config.yaml")
        self.assertNotRegex(raw, r"xapp-[A-Za-z0-9-]{10,}", "app token committed to config.yaml")


class HermesSlackComposeTests(unittest.TestCase):
    """The hermes service must forward every Slack variable into the container."""

    def setUp(self) -> None:
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        hermes = compose["services"]["hermes"]
        self.env = list(hermes.get("environment") or [])

    def _assert_env_mapping(self, name: str) -> None:
        expected = f"{name}=${{{name}}}"
        self.assertIn(
            expected,
            self.env,
            f"docker-compose hermes environment missing {expected}",
        )

    def test_required_slack_credentials_are_forwarded(self) -> None:
        for name in REQUIRED_CREDENTIALS:
            with self.subTest(name=name):
                self._assert_env_mapping(name)

    def test_slack_allowed_users_and_home_channel_are_forwarded(self) -> None:
        for name in REQUIRED_VARS:
            with self.subTest(name=name):
                self._assert_env_mapping(name)

    def test_hermes_publishes_only_its_gateway_ports(self) -> None:
        """Socket Mode is outbound-only, so no additional inbound port may appear.

        The Hermes WebUI on 8787 was the first addition, the Google Tasks
        OAuth callback on 8299 the second, and the reminders dashboard on
        8300 the third. All three are published on host loopback only, so
        none adds a LAN-reachable port: Tailscale serve terminates tailnet
        TLS and proxies to 127.0.0.1.
        """
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        ports = compose["services"]["hermes"].get("ports") or []

        self.assertEqual(
            {"8642", "9119", "8644", "8787", "8299", "8300"},
            {str(p).rsplit(":", 1)[-1] for p in ports},
            "hermes must publish exactly its gateway/dashboard/webhook ports, the WebUI, the Tasks callback, and reminders",
        )
        self.assertIn(
            "127.0.0.1:8787:8787",
            [str(p) for p in ports],
            "the WebUI must stay on host loopback; Tailscale serves it",
        )
        self.assertIn(
            "127.0.0.1:8299:8299",
            [str(p) for p in ports],
            "the Tasks callback must stay on host loopback; Tailscale serves it",
        )
        self.assertIn(
            "127.0.0.1:8300:8300",
            [str(p) for p in ports],
            "reminders must stay on host loopback; Tailscale serves it",
        )

    def test_api_server_is_reachable_through_a_loopback_only_publish(self) -> None:
        """Conduit talks to the API server on 8642, served over the tailnet.

        The server defaults to binding 127.0.0.1 inside the container, which a
        published port cannot reach, so the bind must be widened. The host side
        stays on loopback and Tailscale serve is the only way in, so the wider
        bind adds no LAN-reachable port. The API key stays in the container's
        own env file and is not a compose variable.
        """
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        hermes = compose["services"]["hermes"]
        ports = [str(p) for p in hermes.get("ports") or []]

        self.assertIn("API_SERVER_HOST=0.0.0.0", hermes["environment"])
        self.assertIn("127.0.0.1:8642:8642", ports)
        self.assertNotIn("8642:8642", ports)
        self.assertFalse(
            [e for e in hermes["environment"] if str(e).startswith("API_SERVER_KEY")],
            "the API key must come from the container's own env file, not compose",
        )


class HermesSlackDeployWorkflowTests(unittest.TestCase):
    """GitHub Actions must source Slack secrets and vars on the deploy job."""

    def setUp(self) -> None:
        self.text = DEPLOY_WORKFLOW.read_text(encoding="utf-8")

    def test_slack_tokens_come_from_secrets(self) -> None:
        for name in REQUIRED_CREDENTIALS:
            with self.subTest(name=name):
                expected = f"{name}: ${{{{ secrets.{name} }}}}"
                self.assertIn(expected, self.text, f"deploy.yml missing secret mapping for {name}")

    def test_slack_config_comes_from_vars(self) -> None:
        for name in REQUIRED_VARS:
            with self.subTest(name=name):
                expected = f"{name}: ${{{{ vars.{name} }}}}"
                self.assertIn(expected, self.text, f"deploy.yml missing var mapping for {name}")


class HermesSlackDeployValidationTests(unittest.TestCase):
    """deploy.sh must validate Slack credentials before rebuilding the gateway."""

    def setUp(self) -> None:
        self.text = DEPLOY_SCRIPT.read_text(encoding="utf-8")

    def test_deploy_script_validates_slack_credentials(self) -> None:
        self.assertRegex(self.text, r"\[Slack\]", "deploy.sh has no [Slack] section")

        for name in REQUIRED_CREDENTIALS:
            with self.subTest(name=name):
                pattern = rf'check_var\s+"{name}"\s+"\$HERMES_ENV"'
                self.assertRegex(self.text, pattern, f"deploy.sh does not validate {name}")

    def test_token_validation_is_gated_on_the_platform_flag(self) -> None:
        """Merging the wiring before the Slack app exists must not break deploys."""
        self.assertRegex(
            self.text,
            r"if\s+slack_platform_enabled;",
            "Slack token validation is not gated on platforms.slack.enabled",
        )

    def test_platform_enabled_probe_reads_the_repo_config(self) -> None:
        self.assertRegex(
            self.text,
            r"HERMES_DIR/config\.yaml",
            "the Slack enabled probe does not read the repo config.yaml",
        )

    def test_allowlist_is_hard_required_while_home_channel_stays_optional(self) -> None:
        """The allowlist is the only authz gate in free-response mode.

        With ``require_mention: false`` every message from an allowlisted user
        becomes an agent turn, so an empty ``SLACK_ALLOWED_USERS`` means the bot
        connects and silently answers nobody. Deploy must fail loudly instead.
        The home channel stays optional because cron delivery does not need it.
        """
        self.assertRegex(
            self.text,
            r'check_var\s+"SLACK_ALLOWED_USERS"',
            "SLACK_ALLOWED_USERS must be hard-required while Slack is enabled",
        )
        for name in ("SLACK_HOME_CHANNEL", "SLACK_HOME_CHANNEL_NAME"):
            with self.subTest(name=name):
                self.assertNotRegex(
                    self.text,
                    rf'check_var\s+"{name}"',
                    f"{name} should use check_var_optional, not check_var",
                )


class SlackPlatformEnabledProbeTests(unittest.TestCase):
    """Execute deploy.sh's real probe against YAML shapes.

    The probe decides whether deployment hard-requires Slack tokens. Grepping the
    script for the probe's name proved nothing, so these tests extract the
    function from deploy.sh and run it.
    """

    def _run_probe(self, config_text: str | bytes | None) -> bool:
        """Return the probe's verdict; None means no file.

        Accepts bytes so tests can supply content that is not valid UTF-8.
        """
        with tempfile.TemporaryDirectory() as tmp:
            module_dir = Path(tmp) / "hermes"
            module_dir.mkdir()
            if config_text is not None:
                target = module_dir / "config.yaml"
                if isinstance(config_text, bytes):
                    target.write_bytes(config_text)
                else:
                    target.write_text(config_text, encoding="utf-8")

            harness = "\n".join(
                [
                    "set -euo pipefail",
                    f'HERMES_DIR="{module_dir}"',
                    probe_source,
                    "slack_platform_enabled",
                ]
            )
            result = subprocess.run(
                ["bash", "-c", harness],
                capture_output=True,
                text=True,
                check=False,
            )

        self.assertIn(result.returncode, (0, 1), f"probe crashed: {result.stderr}")
        return result.returncode == 0

    def _run_probe_without_pyyaml(self, config_text: str) -> bool:
        """Run the probe with PyYAML unimportable, as on the deploy runner.

        The deploy host has no PyYAML. A probe that falls back to "enabled" when
        the import fails aborts production deployment, which is exactly what
        happened when this integration first shipped.
        """
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            module_dir = tmp_path / "hermes"
            module_dir.mkdir()
            (module_dir / "config.yaml").write_text(config_text, encoding="utf-8")

            # A directory holding a yaml module that raises on import, placed
            # ahead of site-packages so it shadows any real PyYAML.
            shim = tmp_path / "shim"
            shim.mkdir()
            (shim / "yaml.py").write_text(
                'raise ImportError("simulated: runner has no PyYAML")\n',
                encoding="utf-8",
            )

            harness = "\n".join(
                [
                    "set -euo pipefail",
                    f'HERMES_DIR="{module_dir}"',
                    probe_source,
                    "slack_platform_enabled",
                ]
            )
            env = dict(os.environ, PYTHONPATH=str(shim))
            result = subprocess.run(
                ["bash", "-c", harness],
                capture_output=True,
                text=True,
                check=False,
                env=env,
            )

        self.assertIn(result.returncode, (0, 1), f"probe crashed: {result.stderr}")
        return result.returncode == 0

    def test_disabled_config_skips_without_pyyaml(self) -> None:
        """Regression: no PyYAML on the runner must not force token validation."""
        body = "platforms:\n  slack:\n    enabled: false\n  webhook:\n    enabled: true\n"

        self.assertFalse(
            self._run_probe_without_pyyaml(body),
            "disabled Slack must skip token validation even without PyYAML",
        )

    def test_enabled_config_requires_tokens_without_pyyaml(self) -> None:
        body = "platforms:\n  slack:\n    enabled: true\n"

        self.assertTrue(
            self._run_probe_without_pyyaml(body),
            "enabled Slack must still require tokens without PyYAML",
        )

    def test_capitalised_and_string_booleans_are_read(self) -> None:
        """Reviewer finding: quoted/capitalised truthy forms must not read disabled."""
        truthy = {
            "quoted-capital": 'platforms:\n  slack:\n    enabled: "True"\n',
            "quoted-upper": 'platforms:\n  slack:\n    enabled: "TRUE"\n',
            "quoted-yes-capital": 'platforms:\n  slack:\n    enabled: "Yes"\n',
            "quoted-one": 'platforms:\n  slack:\n    enabled: "1"\n',
        }
        for label, body in truthy.items():
            with self.subTest(shape=label):
                self.assertTrue(self._run_probe(body), f"{label} should require tokens")

    def test_enabled_shapes_require_token_validation(self) -> None:
        shapes = {
            "plain": "platforms:\n  slack:\n    enabled: true\n",
            "enabled-below-extra": (
                "platforms:\n  slack:\n    extra:\n      x: 1\n    enabled: true\n"
            ),
            "flow-style": "platforms: {slack: {enabled: true}}\n",
            "quoted": 'platforms:\n  slack:\n    enabled: "true"\n',
            "yaml-yes": "platforms:\n  slack:\n    enabled: yes\n",
            "yaml-on": "platforms:\n  slack:\n    enabled: on\n",
            "comment-between": "platforms:\n  slack:\n    # note\n    enabled: true\n",
            "key-present-no-flag": "platforms:\n  slack:\n    reply_to_mode: first\n",
        }
        for label, body in shapes.items():
            with self.subTest(shape=label):
                self.assertTrue(self._run_probe(body), f"{label} should require tokens")

    def test_disabled_shape_skips_token_validation(self) -> None:
        body = "platforms:\n  slack:\n    enabled: false\n  webhook:\n    enabled: true\n"

        self.assertFalse(self._run_probe(body))

    def test_unreadable_or_absent_config_fails_closed(self) -> None:
        """Detection failure must require tokens, never silently skip them."""
        self.assertTrue(self._run_probe(None), "missing config must fail closed")
        self.assertTrue(self._run_probe("not: [valid: yaml\n"), "bad YAML must fail closed")
        # An empty or comment-only document has no disabled flag to honour.
        self.assertTrue(self._run_probe(""), "empty config must fail closed")
        self.assertTrue(self._run_probe("# nothing here\n"), "comment-only must fail closed")

    def test_unexpected_parse_failures_fail_closed(self) -> None:
        """A crash inside the probe must not read as 'Slack disabled'.

        The caller treats a non-zero probe as permission to skip the token
        check, so any exception escaping the parser would silently disable the
        gate while Slack is enabled.
        """
        risky = {
            "null-value": "platforms:\n  slack:\n    enabled:\n",
            "comment-only-value": "platforms:\n  slack:\n    enabled: # c\n",
            "tilde-null": "platforms:\n  slack:\n    enabled: ~\n",
            "quoted-null": 'platforms:\n  slack:\n    enabled: "null"\n',
            "tab-indented": "platforms:\n\tslack:\n\t\tenabled: false\n",
            # Raw Latin-1 byte: genuinely invalid UTF-8, unlike a \u00e9 escape.
            "non-utf8-byte": b"platforms:\n  slack:\n    enabled: true\n# caf\xe9\n",
        }
        for label, body in risky.items():
            with self.subTest(case=label):
                self.assertTrue(self._run_probe(body), f"{label} must fail closed")

    def test_flow_style_platforms_mapping(self) -> None:
        """`platforms: {slack: {enabled: false}}` is valid YAML and must be read."""
        disabled = "platforms: {slack: {enabled: false}}\n"
        enabled = "platforms: {slack: {enabled: true}}\n"
        slack_not_first = "platforms: {webhook: {enabled: true}, slack: {enabled: false}}\n"
        # `slack` nested inside another flow mapping is not the platform key.
        nested_route = "platforms: {webhook: {routes: {slack: {enabled: false}}}}\n"

        self.assertFalse(self._run_probe(disabled), "flow-style disabled must skip tokens")
        self.assertTrue(self._run_probe(enabled), "flow-style enabled must require tokens")
        self.assertFalse(self._run_probe(slack_not_first), "second flow key must be found")
        self.assertTrue(self._run_probe(nested_route), "nested flow slack key must not match")

    def test_slack_must_be_a_direct_child_of_platforms(self) -> None:
        """A nested `slack:` mapping must not stand in for the platform block."""
        nested_route = (
            "platforms:\n"
            "  webhook:\n"
            "    routes:\n"
            "      slack:\n"
            "        enabled: false\n"
            "  slack:\n"
            "    enabled: true\n"
        )
        nested_only = (
            "platforms:\n"
            "  webhook:\n"
            "    routes:\n"
            "      slack:\n"
            "        enabled: false\n"
        )
        fake_platforms = (
            "other:\n"
            "  platforms:\n"
            "    slack:\n"
            "      enabled: false\n"
            "platforms:\n"
            "  slack:\n"
            "    enabled: true\n"
        )

        self.assertTrue(self._run_probe(nested_route), "nested slack key must not disable the gate")
        self.assertTrue(self._run_probe(nested_only), "nested-only slack is not the platform")
        self.assertTrue(self._run_probe(fake_platforms), "indented platforms is not the top level")

    def test_duplicate_platforms_keys_fail_closed(self) -> None:
        """Two top-level `platforms:` keys are invalid YAML; err on enabled.

        Real parsers disagree on duplicate keys, so the gate must not guess in
        the direction that skips token validation.
        """
        duplicated = (
            "platforms:\n"
            "  slack:\n"
            "    enabled: false\n"
            "platforms:\n"
            "  slack:\n"
            "    enabled: true\n"
        )

        self.assertTrue(self._run_probe(duplicated))

    def test_duplicate_slack_or_enabled_keys_fail_closed(self) -> None:
        """Duplicate `slack:` or `enabled:` keys are ambiguous, so err on enabled.

        A first-wins read would skip token validation while the effective YAML
        (last-wins) has Slack enabled.
        """
        dup_slack = (
            "platforms:\n"
            "  slack:\n"
            "    enabled: false\n"
            "  slack:\n"
            "    enabled: true\n"
        )
        dup_enabled = (
            "platforms:\n"
            "  slack:\n"
            "    enabled: false\n"
            "    enabled: true\n"
        )

        self.assertTrue(self._run_probe(dup_slack), "duplicate slack key is ambiguous")
        self.assertTrue(self._run_probe(dup_enabled), "duplicate enabled key is ambiguous")

    def test_quoted_values_keep_their_literal_text(self) -> None:
        """A quoted string is a string: comments inside quotes are not comments."""
        cases = {
            "quote-then-comment": 'platforms:\n  slack:\n    enabled: "false # x"\n',
            "quote-with-comma-flow": 'platforms: {slack: {enabled: "false,true"}}\n',
            "quote-with-comment-flow": 'platforms: {slack: {enabled: "false # x"}}\n',
            "genuine-quoted-false": 'platforms:\n  slack:\n    enabled: "false"\n',
        }
        for label, body in cases.items():
            with self.subTest(case=label):
                expected = label == "genuine-quoted-false"
                self.assertEqual(
                    expected,
                    not self._run_probe(body),
                    f"{label}: probe disagreed with the quoted scalar's real value",
                )

    def test_quotes_elsewhere_do_not_hide_the_real_flag(self) -> None:
        """A quote in an earlier scalar must not blank the `enabled:` line.

        Opening a multi-line quote on any stray apostrophe or `" #"` would mask
        every later line, which re-creates the production abort this change
        fixes: the gate would read "enabled" and demand tokens for a disabled
        platform.
        """
        cases = {
            "apostrophe-plain": "platforms:\n  slack:\n    note: don't\n    enabled: false\n",
            "hash-in-double-quotes": (
                'platforms:\n  slack:\n    note: "a # b"\n    enabled: false\n'
            ),
            "apostrophe-at-top-level": (
                'identity: "Example\'s"\nplatforms:\n  slack:\n    enabled: false\n'
            ),
            "escaped-double-quote": (
                'platforms:\n  slack:\n    note: "say \\"hi\\""\n    enabled: false\n'
            ),
            "doubled-single-quote": (
                "platforms:\n  slack:\n    note: 'it''s'\n    enabled: false\n"
            ),
            "multi-line-value-inside-slack": (
                'platforms:\n  slack:\n    note: "multi\n      line"\n    enabled: false\n'
            ),
        }
        for label, body in cases.items():
            with self.subTest(case=label):
                self.assertFalse(
                    self._run_probe(body),
                    f"{label}: a genuine false flag must still disable the gate",
                )

    def test_quoted_block_scalar_key_is_masked(self) -> None:
        """`"prompt": |` is a valid block scalar and its body is not config."""
        enabled_after = (
            "platforms:\n"
            '  "prompt": |\n'
            "    slack:\n"
            "      enabled: false\n"
            "  slack:\n"
            "    enabled: true\n"
        )
        disabled_after = (
            "platforms:\n"
            "  'prompt': >\n"
            "    slack:\n"
            "      enabled: false\n"
            "  slack:\n"
            "    enabled: false\n"
        )

        self.assertTrue(self._run_probe(enabled_after), "quoted key block body must be masked")
        self.assertFalse(self._run_probe(disabled_after), "real flag after the block still counts")

    def test_duplicate_flow_keys_fail_closed(self) -> None:
        """Flow mappings with repeated keys are as ambiguous as block style."""
        dup_enabled = "platforms: {slack: {enabled: false, enabled: true}}\n"
        dup_slack = "platforms: {slack: {enabled: false}, slack: {enabled: true}}\n"

        self.assertTrue(self._run_probe(dup_enabled), "duplicate flow enabled is ambiguous")
        self.assertTrue(self._run_probe(dup_slack), "duplicate flow slack is ambiguous")

    def test_multiline_quoted_scalar_is_not_parsed_as_config(self) -> None:
        """A quoted scalar can span lines; its continuation is not a key."""
        body = (
            "platforms:\n"
            '  note: "text\n'
            "  slack:\n"
            "    enabled: false\n"
            '  tail"\n'
            "  slack:\n"
            "    enabled: true\n"
        )

        self.assertTrue(self._run_probe(body), "multi-line quoted text must not disable the gate")

    def test_only_a_direct_child_flag_counts(self) -> None:
        """A nested or block-scalar `enabled:` must not stand in for slack's own flag."""
        after_nested = (
            "platforms:\n"
            "  slack:\n"
            "    enabled: false\n"
            "    extra:\n"
            "      enabled: true\n"
        )
        nested_before_flag = (
            "platforms:\n"
            "  slack:\n"
            "    extra:\n"
            "      sub:\n"
            "        enabled: false\n"
            "    enabled: true\n"
        )
        block_scalar = (
            "platforms:\n"
            "  slack:\n"
            "    extra:\n"
            "      prompt: |\n"
            "        enabled: false\n"
            "    enabled: true\n"
        )
        literal_under_slack = (
            "platforms:\n"
            "  slack:\n"
            "    prompt: |\n"
            "      enabled: true\n"
            "    enabled: false\n"
        )

        self.assertFalse(self._run_probe(after_nested), "direct flag wins over a later nested one")
        self.assertTrue(self._run_probe(nested_before_flag), "nested flag must not mask the real one")
        self.assertTrue(self._run_probe(block_scalar), "block scalar text must not mask the real flag")
        self.assertFalse(self._run_probe(literal_under_slack), "direct false still wins")

    def test_block_scalar_body_is_not_parsed_as_config(self) -> None:
        """A prompt block's free text must never be read as the platform flag.

        The webhook route prompt is a `|` block that necessarily sits before the
        `slack:` block, and its text can contain anything, including lines that
        look exactly like `slack:` and `enabled: false`.
        """
        fake_slack_in_prompt = (
            "platforms:\n"
            "  webhook:\n"
            "    extra:\n"
            "      routes:\n"
            "        notify:\n"
            "          prompt: |\n"
            "            slack:\n"
            "              enabled: false\n"
            "  slack:\n"
            "    enabled: true\n"
        )
        folded_scalar = (
            "platforms:\n"
            "  webhook:\n"
            "    extra:\n"
            "      prompt: >\n"
            "        platforms:\n"
            "          slack:\n"
            "            enabled: false\n"
            "  slack:\n"
            "    enabled: true\n"
        )
        fake_platforms_in_prompt = (
            "platforms:\n"
            "  webhook:\n"
            "    extra:\n"
            "      prompt: |\n"
            "        platforms:\n"
            "          slack:\n"
            "            enabled: false\n"
            "  slack:\n"
            "    enabled: false\n"
        )

        self.assertTrue(
            self._run_probe(fake_slack_in_prompt),
            "a `slack:` line inside a prompt block must not disable the gate",
        )
        self.assertTrue(
            self._run_probe(folded_scalar),
            "a folded scalar body must not disable the gate",
        )
        self.assertFalse(
            self._run_probe(fake_platforms_in_prompt),
            "the real flag after a block scalar must still be honoured",
        )

    def test_repo_config_matches_the_probe_verdict(self) -> None:
        """Whatever the repo ships, the probe must agree with the YAML."""
        committed = yaml.safe_load(HERMES_CONFIG.read_text(encoding="utf-8"))
        enabled = (committed.get("platforms") or {}).get("slack", {}).get("enabled", True)

        self.assertIs(
            bool(enabled),
            self._run_probe(HERMES_CONFIG.read_text(encoding="utf-8")),
            "probe verdict disagrees with the committed platforms.slack.enabled",
        )

    def test_committed_config_requires_tokens_now_that_they_exist(self) -> None:
        """The deploy gate must guard Slack credentials.

        The Slack app exists and SLACK_BOT_TOKEN/SLACK_APP_TOKEN live in the
        `darren-prod` environment scope, so Slack ships enabled and the gate is
        expected to hard-require both tokens. Flipping `enabled` back to false
        would silently stop validating them.
        """
        committed = yaml.safe_load(HERMES_CONFIG.read_text(encoding="utf-8"))

        self.assertTrue(
            (committed.get("platforms") or {}).get("slack", {}).get("enabled", False),
            "Slack must be enabled now that the tokens are configured, so the "
            "deploy gate keeps validating them",
        )


class HermesSlackConfigOrderingTests(unittest.TestCase):
    """H1 regression guard.

    modules/expense-tracker/__tests__/hermes-webhook.test.js reads this config
    with a single-level-depth hand-rolled parser. A nested mapping placed before
    the three-level `webhook` route desynchronises it and the `expense-tracker`
    CI job fails. This mirrors that parser to catch the ordering hazard here.
    """

    @staticmethod
    def expense_tracker_parser(content: str) -> dict:
        """Faithful port of parseSimpleYaml (see the JS test for the original)."""
        result: dict = {}
        stack = [result]
        current_indent = -1
        lines = content.split("\n")

        for line in lines:
            if not line.strip() or line.strip().startswith("#"):
                continue
            indent_match = re.search(r"\S", line)
            if indent_match is None:
                continue
            indent = indent_match.start()
            trimmed = line.strip()

            while len(stack) > 1 and indent <= current_indent:
                stack.pop()
                current_indent = indent if len(stack) > 1 else -1

            colon = trimmed.find(":")
            if colon < 0:
                continue
            key = trimmed[:colon].strip()
            value = trimmed[colon + 1 :].strip()

            if value == "|":
                parts = []
                j = lines.index(line) + 1
                while j < len(lines):
                    nxt = lines[j]
                    next_indent_match = re.search(r"\S", nxt)
                    if next_indent_match is not None and next_indent_match.start() <= indent:
                        break
                    if not nxt.strip():
                        break
                    parts.append(nxt.strip())
                    j += 1
                value = "\n".join(parts)
            elif value == "":
                obj: dict = {}
                stack[-1][key] = obj
                stack.append(obj)
                current_indent = indent
                continue
            else:
                if (value.startswith('"') and value.endswith('"')) or (
                    value.startswith("'") and value.endswith("'")
                ):
                    value = value[1:-1]

            if isinstance(stack[-1], dict):
                stack[-1][key] = value

        return result

    def test_webhook_route_survives_order_dependent_parser(self) -> None:
        parsed = self.expense_tracker_parser(HERMES_CONFIG.read_text(encoding="utf-8"))
        routes = parsed.get("platforms", {}).get("webhook", {}).get("extra", {}).get("routes")

        self.assertIsNotNone(routes, "platforms.webhook hoisted: slack block ordered before webhook")
        self.assertIn("notify", routes)
        self.assertEqual("telegram", routes["notify"].get("deliver"))


class HermesSlackManifestHelperTests(unittest.TestCase):
    """A helper must exist for the one-time Slack app manifest generation."""

    def test_manifest_helper_script_is_present(self) -> None:
        script = REPO_ROOT / "modules" / "hermes" / "scripts" / "slack-manifest.sh"

        self.assertTrue(script.is_file(), "modules/hermes/scripts/slack-manifest.sh missing")

    def test_manifest_helper_uses_official_agent_view_command(self) -> None:
        script = REPO_ROOT / "modules" / "hermes" / "scripts" / "slack-manifest.sh"
        text = script.read_text(encoding="utf-8")

        self.assertRegex(text, r"hermes slack manifest", "helper must show the official command")
        self.assertIn("--agent-view", text)
        self.assertIn("--write", text)
        self.assertRegex(text, r"^#!", "helper must declare a shebang")

    def test_manifest_name_tracks_the_installed_bot_name(self) -> None:
        """Re-applying a manifest must not rename the bot back to 'Hermes'.

        The generator defaults ``--name`` to ``Hermes`` while the installed
        Slack app is ``friday``. The script therefore has to forward an
        explicit name rather than trusting the default.
        """
        text = MANIFEST_SCRIPT.read_text(encoding="utf-8")

        self.assertIn(
            "SLACK_MANIFEST_BOT_NAME",
            text,
            "manifest helper must accept SLACK_MANIFEST_BOT_NAME",
        )
        self.assertRegex(
            text,
            r'ARGS\+=\(--name "\$[A-Z_]*BOT_NAME"\)',
            "manifest helper must forward the configured bot name as --name",
        )


if __name__ == "__main__":
    unittest.main()
