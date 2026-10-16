"""The codex-router service must receive the external provider credentials.

Discovery skips a provider whose key is absent, so a key that never reaches the
container disables that provider's models. All four provider keys are optional:
an unset key simply leaves that provider's models unpublished.
"""

from pathlib import Path
import unittest

import yaml


REPO = Path(__file__).parents[2]
COMPOSE_FILE = Path(__file__).parents[1] / "docker-compose.yml"
WORKFLOW = REPO / ".github/workflows/deploy.yml"
DEPLOY_SCRIPT = Path(__file__).parents[1] / "deploy.sh"

PROVIDER_KEYS = (
    "MODEL_API_KEY",
    "OPENCODE_GO_API_KEY",
    "OPENCODE_ZEN_API_KEY",
    "OPENCODE_API_KEY",
)

# Every provider key is optional: discovery skips a provider whose key is
# absent, so an unset value simply leaves those models unpublished. See
# test_deploy_script_treats_the_model_key_as_optional.
OPTIONAL_PROVIDER_KEYS = (
    "MODEL_API_KEY",
    "OPENCODE_GO_API_KEY",
    "OPENCODE_ZEN_API_KEY",
    "OPENCODE_API_KEY",
)


class CodexRouterProviderEnvTests(unittest.TestCase):
    def test_router_service_forwards_provider_keys(self):
        config = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        # The router is two interchangeable colour containers; both must carry
        # the keys, because either one can be the serving colour after a roll.
        for colour in ("codex-router-a", "codex-router-b"):
            environment = config["services"][colour]["environment"]

            for key in PROVIDER_KEYS:
                self.assertIn(f"{key}=${{{key}:-}}", environment, colour)
            self.assertIn(
                "CODEX_ROUTER_OPENCODE_ZEN_MODELS=${CODEX_ROUTER_OPENCODE_ZEN_MODELS:-space-bunny-free}",
                environment,
                colour,
            )

    def test_deploy_workflow_passes_provider_secrets(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        for key in PROVIDER_KEYS:
            if key == "MODEL_API_KEY":
                # The GitHub secret is MUSE_API_KEY; it maps to the runtime
                # MODEL_API_KEY name the upstream meta-ai provider reads.
                self.assertIn("MODEL_API_KEY: ${{ secrets.MUSE_API_KEY }}", workflow)
            else:
                self.assertIn(f"{key}: ${{{{ secrets.{key} }}}}", workflow)
        self.assertIn(
            "CODEX_ROUTER_OPENCODE_ZEN_MODELS: ${{ vars.CODEX_ROUTER_OPENCODE_ZEN_MODELS || 'space-bunny-free' }}",
            workflow,
        )

    def test_hermes_service_forwards_the_model_key(self):
        config = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        environment = config["services"]["hermes"]["environment"]

        # In-container Meta-direct callers read MODEL_API_KEY, so it is not
        # enough for the key to reach codex-router. The container's HOME is
        # /root and its ~/.env does not exist, so a file fallback never finds
        # the key either: the environment variable is the only source that
        # reaches it.
        self.assertIn("MODEL_API_KEY=${MODEL_API_KEY:-}", environment)

    def test_hermes_service_forwards_the_jev_key(self):
        # The adjudicator's primary route is TypeSafe's official jev endpoint, keyed
        # by JEV_API_KEY, and it is called from inside this container. The key is
        # optional: without it the adjudicator falls back to auto-thinking.
        config = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        environment = config["services"]["hermes"]["environment"]
        self.assertIn("JEV_API_KEY=${JEV_API_KEY:-}", environment)
        self.assertIn("JEV_API_KEY: ${{ secrets.JEV_API_KEY }}", WORKFLOW.read_text(encoding="utf-8"))
        self.assertIn('check_var_optional "JEV_API_KEY"', DEPLOY_SCRIPT.read_text(encoding="utf-8"))

    def test_deploy_script_treats_opencode_provider_keys_as_optional(self):
        script = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        for key in OPTIONAL_PROVIDER_KEYS:
            self.assertIn(f'check_var_optional "{key}"', script)
        self.assertIn('check_var_optional "CODEX_ROUTER_OPENCODE_ZEN_MODELS"', script)

    def test_deploy_script_treats_the_model_key_as_optional(self):
        script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        # Scope to the codex-router section, as the sibling test does, so moving
        # the check to another section turns this red.
        script = script.split("# ---- codex-router ----", 1)[1].split("# ---- pluggable modules", 1)[0]

        # Discovery skips the meta/ lane while this key is absent, so an unset
        # key degrades instead of breaking the deploy: it must be optional.
        self.assertIn('check_var_optional "MODEL_API_KEY"', script)
        self.assertNotIn('check_var "MODEL_API_KEY" ""', script)


if __name__ == "__main__":
    unittest.main(verbosity=2)
