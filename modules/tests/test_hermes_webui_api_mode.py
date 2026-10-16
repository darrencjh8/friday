from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sys
import textwrap
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
HERMES = ROOT / "modules" / "hermes"
PATCH_PATH = HERMES / "patches" / "patch-webui-api-mode.py"
WEBUI_REF = "c67fd2dd270a1128c2754200406bca58e9d9a25a"
# Exact API-mode handoff and constructor statements from the pinned upstream source.
UPSTREAM_SNIPPET = (
    "def build_agent("
    "_agent_params, _agent_kwargs, _rt, resolved_base_url, configured_base_url, _cfg, _AIAgent):\n"
    + textwrap.indent(
        """if 'api_mode' in _agent_params:
    _agent_kwargs['api_mode'] = _rt.get('api_mode')
agent = _AIAgent(**_agent_kwargs)
return agent
""",
        " " * 12,
    )
)


def load_patcher():
    spec = spec_from_file_location("patch_webui_api_mode", PATCH_PATH)
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WebUIApiModeRoutingTest(unittest.TestCase):
    def test_webui_api_mode_patch_installed(self):
        dockerfile = (HERMES / "Dockerfile").read_text()
        self.assertIn(f"ARG HERMES_WEBUI_REF={WEBUI_REF}", dockerfile)
        self.assertIn(
            "COPY patches/patch-webui-api-mode.py /tmp/patch-webui-api-mode.py",
            dockerfile,
        )
        self.assertIn(
            "python3 /tmp/patch-webui-api-mode.py /opt/hermes-webui/api/streaming.py",
            dockerfile,
        )

    def test_agent_constructor_receives_profile_transport_or_runtime_fallback(self):
        patched_source = load_patcher().patch_source(UPSTREAM_SNIPPET)
        calls = []

        def get_custom_provider_api_mode(base_url, custom_providers=None, config=None):
            calls.append((base_url, config))
            return config.get("matched_transport", "")

        hermes_cli = types.ModuleType("hermes_cli")
        config_module = types.ModuleType("hermes_cli.config")
        config_module.get_custom_provider_api_mode = get_custom_provider_api_mode
        hermes_cli.config = config_module
        namespace = {}
        with patch.dict(sys.modules, {"hermes_cli": hermes_cli, "hermes_cli.config": config_module}):
            exec(patched_source, namespace)

            route = "http://codex-router:4100/v1"
            matched_config = {"matched_transport": "codex_responses"}
            configured_kwargs = namespace["build_agent"](
                {"api_mode"}, {}, {"api_mode": "chat_completions"},
                route, None, matched_config, lambda **kwargs: kwargs,
            )
            fallback_config = {"matched_transport": ""}
            fallback_kwargs = namespace["build_agent"](
                {"api_mode"}, {}, {"api_mode": "chat_completions"},
                route, None, fallback_config, lambda **kwargs: kwargs,
            )

        self.assertEqual(configured_kwargs["api_mode"], "codex_responses")
        self.assertEqual(fallback_kwargs["api_mode"], "chat_completions")
        self.assertEqual(calls, [(route, matched_config), (route, fallback_config)])


if __name__ == "__main__":
    unittest.main()
