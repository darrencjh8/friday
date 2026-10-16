#!/bin/bash
# Contract test for durable Hermes model routing defaults.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/../config.yaml"

python3 - "$CONFIG" <<'PY'
import sys
from pathlib import Path

import yaml

root = Path(sys.argv[1]).resolve().parents[2]
with open(sys.argv[1]) as f:
    config = yaml.safe_load(f)

router_provider = {
    "name": "Model Router",
    "api": "http://codex-router:4100/v1",
    "api_key": "local",
    "transport": "codex_responses",
}
router_route = "custom:codex-router"
# Every route's primary is the auto-thinking pool; the only fallback anywhere
# is the direct vanilla deepseek route as the terminal rung.
deepseek_fallback = {
    "provider": "deepseek",
    "model": "deepseek-flash",
}


def assert_provider(config, model, label):
    provider = config.get("providers", {}).get("codex-router", {})
    for key, value in router_provider.items():
        assert provider.get(key) == value, (
            f"{label}.providers.codex-router.{key}: expected {value!r}, got {provider.get(key)!r}"
        )
    assert provider.get("default_model") == model, (
        f"{label}.providers.codex-router.default_model: expected {model!r}, got {provider.get('default_model')!r}"
    )


def assert_route(route, model, label):
    assert route.get("provider") == router_route, (
        f"{label}.provider: expected {router_route!r}, got {route.get('provider')!r}"
    )
    assert route.get("model") == model, f"{label}.model: expected {model!r}, got {route.get('model')!r}"
    assert "base_url" not in route, f"{label} must use its named provider URL"
    assert "api_key" not in route, f"{label} must use its named provider API key"


assert_provider(config, "auto-thinking", "main")
assert config["model"].get("provider") == router_route
assert config["model"].get("default") == "auto-thinking"
assert "base_url" not in config["model"]
assert "api_key" not in config["model"]
assert config["agent"]["reasoning_effort"] == "none"
assert "moa" not in (config["agent"].get("disabled_toolsets") or []), (
    "main agent must not disable the moa toolset"
)
assert config["compression"]["threshold_tokens"] == 300000, (
    f"compression.threshold_tokens: expected 300000, got {config['compression'].get('threshold_tokens')!r}"
)
assert config["compression"]["threshold"] == 0.90, (
    f"compression.threshold: expected 0.90, got {config['compression'].get('threshold')!r}"
)
assert config["compression"]["enabled"] is True, (
    f"compression.enabled: expected True, got {config['compression'].get('enabled')!r}"
)
assert config["fallback_providers"] == [deepseek_fallback], (
    "main fallback_providers must be deepseek-flash"
)
assert_route(config["delegation"], "auto-thinking", "delegation")

aux_pool = "auto"
aux_thinking = "auto-thinking"

vision = config["auxiliary"]["vision"]
assert vision.get("provider") == router_route, (
    "auxiliary.vision.provider: expected 'custom:codex-router', got "
    f"{vision.get('provider')!r}"
)
assert vision.get("model") == aux_pool, (
    f"auxiliary.vision.model: expected {aux_pool!r}, got {vision.get('model')!r}"
)
assert vision.get("fallback_chain") == [deepseek_fallback], (
    "auxiliary.vision.fallback_chain must use deepseek-flash"
)
assert "base_url" not in vision, "auxiliary.vision must use its named provider URL"
assert "api_key" not in vision, "auxiliary.vision must use its named provider API key"

for task in (
    "web_extract",
    "compression",
    "triage_specifier",
    "profile_describer",
    "skills_hub",
    "mcp",
    "title_generation",
    "voice_chat",
):
    route = config["auxiliary"][task]
    assert_route(route, aux_pool, f"auxiliary.{task}")
    assert route.get("fallback_chain") == [deepseek_fallback], (
        f"auxiliary.{task}.fallback_chain must use deepseek-flash"
    )

# The judges keep the thinking pool so their verdicts track the main agent:
# approval, the review subagent, and the skill-usage curator.
for task in ("approval", "review", "curator"):
    assert_route(config["auxiliary"][task], aux_thinking, f"auxiliary.{task}")
    assert config["auxiliary"][task].get("fallback_chain") == [deepseek_fallback], (
        f"auxiliary.{task}.fallback_chain must use deepseek-flash"
    )

assert config["kanban"]["default_assignee"] == "code-reviewer"
decomposer = config["auxiliary"]["kanban_decomposer"]
assert decomposer.get("provider") == router_route, (
    "auxiliary.kanban_decomposer.provider: expected 'custom:codex-router', got "
    f"{decomposer.get('provider')!r}"
)
assert decomposer.get("model") == aux_pool, (
    f"auxiliary.kanban_decomposer.model: expected {aux_pool!r}, got {decomposer.get('model')!r}"
)
assert "base_url" not in decomposer, "auxiliary.kanban_decomposer must use its named provider URL"
assert "api_key" not in decomposer, "auxiliary.kanban_decomposer must use its named provider API key"
assert decomposer.get("fallback_chain") == [deepseek_fallback], (
    "auxiliary.kanban_decomposer.fallback_chain must use deepseek-flash"
)

for profile, effort in {
    "code-reviewer": "high",
}.items():
    model = "auto-thinking"
    profile_config_path = root / "modules/hermes/profiles" / profile / "config.yaml"
    assert profile_config_path.is_file(), f"{profile} profile config is missing"
    with open(profile_config_path) as f:
        profile_config = yaml.safe_load(f)
    assert_provider(profile_config, model, profile)
    expected_provider = router_route
    assert profile_config["model"].get("provider") == expected_provider, (
        f"{profile}.model.provider: expected {expected_provider!r}, got {profile_config['model'].get('provider')!r}"
    )
    assert profile_config["model"].get("default") == model
    assert "base_url" not in profile_config["model"]
    assert "api_key" not in profile_config["model"]
    assert profile_config["agent"]["reasoning_effort"] == effort, (
        f"{profile}.agent.reasoning_effort: expected {effort!r}, got "
        f"{profile_config['agent'].get('reasoning_effort')!r}"
    )
    assert "moa" not in (profile_config["agent"].get("disabled_toolsets") or []), (
        f"{profile} agent must not disable the moa toolset"
    )
    fallback = profile_config["fallback_providers"]
    # Every profile falls back to the direct vanilla deepseek route: the
    # terminal rung when the pool itself is unavailable. Profiles carry their
    # own api_key on the fallback, so only provider and model are asserted.
    assert len(fallback) == 1, (
        f"{profile} must keep exactly one fallback, got {fallback!r}"
    )
    assert fallback[0].get("provider") == "deepseek", (
        f"{profile} fallback must use the deepseek provider, got {fallback!r}"
    )
    assert fallback[0].get("model") == "deepseek-flash", (
        f"{profile} fallback must use deepseek-flash, got {fallback!r}"
    )
    if profile == "code-reviewer":
        assert profile_config["memory"]["memory_enabled"] is False, (
            "code-reviewer memory must be disabled so every review has a fresh context"
        )
PY
