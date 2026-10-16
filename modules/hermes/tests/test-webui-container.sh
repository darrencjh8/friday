#!/bin/bash
# Verify the Hermes WebUI is baked into the hermes image, supervised by s6,
# published on host loopback only, and health-gated by deploy.sh.
#
# The listener must bind 0.0.0.0 inside the container because compose publishes
# 127.0.0.1:8787 on the host: Docker forwards a published port to the container
# interface, not to the container's own loopback, so a 127.0.0.1 bind inside the
# container is unreachable through the published port while in-container health
# checks still pass.
#
# No network and no docker daemon are needed: this reads the repository files.
#
# The single-quoted grep patterns below are literal on purpose: they match the
# exact text written in the Dockerfile, the run script, and deploy.sh, so the
# shell must not expand `$VAR` and `$(...)` inside them.
# shellcheck disable=SC2016
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HERMES_DIR="$SCRIPT_DIR/.."
DOCKERFILE="$HERMES_DIR/Dockerfile"
COMPOSE_FILE="$SCRIPT_DIR/../../docker-compose.yml"
DEPLOY_SCRIPT="$SCRIPT_DIR/../../deploy.sh"
SERVICE_DIR="$HERMES_DIR/webui/s6-rc.d/hermes-webui"

echo "=== hermes WebUI: Dockerfile ==="

# Test: the pinned WebUI revision is a full commit SHA, not a tag.
test_ref_is_commit() {
    local ref
    ref=$(grep -E '^ARG HERMES_WEBUI_REF=' "$DOCKERFILE" | head -1 | cut -d= -f2 || true)
    if [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then
        ok "HERMES_WEBUI_REF pins a 40-hex commit ($ref)"
    else
        nope "HERMES_WEBUI_REF is a 40-hex commit" "value: '${ref:-missing}'"
    fi
}

# Test: the build names the remote before fetching, so `git fetch origin` resolves.
test_remote_named_before_fetch() {
    if grep -qF 'git remote add origin https://github.com/nesquena/hermes-webui.git' "$DOCKERFILE"; then
        ok "Dockerfile adds the upstream origin remote"
    else
        nope "Dockerfile adds the upstream origin remote" "no 'git remote add origin' line"
    fi
}

# Test: the fetch is by the pinned ref variable, so a moved tag cannot substitute.
test_fetches_pinned_ref() {
    if grep -qF 'git fetch --depth 1 origin "$HERMES_WEBUI_REF"' "$DOCKERFILE"; then
        ok "Dockerfile fetches the pinned ref"
    else
        nope "Dockerfile fetches the pinned ref" "no fetch of \"\$HERMES_WEBUI_REF\""
    fi
}

# Test: the checkout lands in /opt/hermes-webui.
test_checkout_destination() {
    if grep -qF '/opt/hermes-webui' "$DOCKERFILE"; then
        ok "Dockerfile checks the WebUI out into /opt/hermes-webui"
    else
        nope "Dockerfile checks out into /opt/hermes-webui" "path not present"
    fi
}

# Test: the WebUI gets its missing YAML dependency without writing into its checkout or Hermes venv.
test_webui_dependency_isolated() {
    if grep -qF '"$uv_bin" pip install --target /opt/hermes-webui-deps --python /usr/bin/python3 PyYAML==6.0.3' "$DOCKERFILE"; then
        ok "Dockerfile installs pinned PyYAML in an isolated WebUI path"
    else
        nope "Dockerfile installs pinned WebUI PyYAML" "isolated dependency install not found"
    fi
    if grep -qF 'export PYTHONPATH="/opt/hermes-webui-deps${PYTHONPATH:+:$PYTHONPATH}"' "$SERVICE_DIR/run"; then
        ok "WebUI service adds only the isolated dependency path"
    else
        nope "WebUI service adds isolated dependency path" "PYTHONPATH entry not found"
    fi
    if grep -qF 'PYTHONPATH="/opt/hermes-webui-deps${PYTHONPATH:+:$PYTHONPATH}"' "$HERMES_DIR/50-seed-defaults"; then
        ok "seed script exposes the isolated dependency path"
    else
        nope "seed script exposes isolated dependency path" "PYTHONPATH entry not found in 50-seed-defaults"
    fi
    if grep -qF "su -s /bin/sh hermes -c 'PYTHONPATH=/opt/hermes-webui-deps python3 -" "$HERMES_DIR/50-seed-defaults"; then
        ok "seed config merge carries the path through su"
    else
        nope "seed config merge carries path through su" "su without the dependency path leaves the merge without yaml"
    fi
}

# Test: the s6 service tree is installed and enabled.
test_s6_service_installed() {
    if grep -qF 'COPY webui/s6-rc.d/hermes-webui /etc/s6-overlay/s6-rc.d/hermes-webui' "$DOCKERFILE"; then
        ok "Dockerfile installs the s6 service tree"
    else
        nope "Dockerfile installs the s6 service tree" "no COPY into /etc/s6-overlay/s6-rc.d"
    fi
    if grep -qF 'touch /etc/s6-overlay/s6-rc.d/user/contents.d/hermes-webui' "$DOCKERFILE"; then
        ok "Dockerfile enables the service in user/contents.d"
    else
        nope "Dockerfile enables the service" "no contents.d entry"
    fi
}

echo ""
echo "=== hermes WebUI: s6 service ==="

# Test: the service is a longrun.
test_service_type() {
    if [ "$(cat "$SERVICE_DIR/type" 2>/dev/null)" = "longrun" ]; then
        ok "service type is longrun"
    else
        nope "service type is longrun" "type: '$(cat "$SERVICE_DIR/type" 2>/dev/null || echo missing)'"
    fi
}

# Test: the run script is executable with the with-contenv shebang.
test_run_script_shape() {
    if [ ! -f "$SERVICE_DIR/run" ]; then
        nope "run script exists" "$SERVICE_DIR/run is missing"
        return
    fi
    if [ -x "$SERVICE_DIR/run" ]; then
        ok "run script is executable"
    else
        nope "run script is executable" "not executable"
    fi
    if [ "$(head -1 "$SERVICE_DIR/run")" = '#!/command/with-contenv sh' ]; then
        ok "run script uses the with-contenv shebang"
    else
        nope "run script uses the with-contenv shebang" "first line: '$(head -1 "$SERVICE_DIR/run")'"
    fi
    if grep -qF 's6-setuidgid hermes' "$SERVICE_DIR/run"; then
        ok "run script drops to the hermes user"
    else
        nope "run script drops to the hermes user" "no s6-setuidgid hermes"
    fi
}

# Test: every launcher variable is set explicitly to its exact value.
test_launcher_env_values() {
    local expected=(
        'HERMES_WEBUI_AGENT_DIR=/opt/hermes'
        'HERMES_WEBUI_PYTHON=/opt/hermes/.venv/bin/python3'
        'HERMES_WEBUI_HOST=0.0.0.0'
        'HERMES_WEBUI_PORT=8787'
        'HERMES_WEBUI_STATE_DIR=/opt/data/webui'
        'HERMES_WEBUI_DEFAULT_WORKSPACE=/workspace'
        'HERMES_WEBUI_SERVER_CWD=/workspace'
        'HERMES_WEBUI_FOREGROUND=1'
        'PYTHONUNBUFFERED=1'
    )
    local pair
    for pair in "${expected[@]}"; do
        if grep -qF "$pair" "$SERVICE_DIR/run" 2>/dev/null; then
            ok "run script sets $pair"
        else
            nope "run script sets $pair" "not found in run script"
        fi
    done
}

# Test: the CSP frame-ancestors allowlist is forwarded end to end.
test_csp_frame_extra_forwarded() {
    if grep -qF 'HERMES_WEBUI_CSP_FRAME_EXTRA=${HERMES_WEBUI_CSP_FRAME_EXTRA:-}' "$COMPOSE_FILE"; then
        ok "compose forwards HERMES_WEBUI_CSP_FRAME_EXTRA"
    else
        nope "compose forwards HERMES_WEBUI_CSP_FRAME_EXTRA" "passthrough not found"
    fi
    if grep -qF 'HERMES_WEBUI_CSP_FRAME_EXTRA=' "$SERVICE_DIR/run"; then
        ok "run script forwards HERMES_WEBUI_CSP_FRAME_EXTRA"
    else
        nope "run script forwards HERMES_WEBUI_CSP_FRAME_EXTRA" "not found in run script"
    fi
}

echo ""
echo "=== hermes WebUI: compose port ==="

# Test: the port is published on host loopback only.
test_compose_publishes_loopback() {
    if grep -qF '"127.0.0.1:8787:8787"' "$COMPOSE_FILE"; then
        ok "compose publishes 127.0.0.1:8787:8787"
    else
        nope "compose publishes 127.0.0.1:8787:8787" "stanza not found"
    fi
    if grep -qE '"(0\.0\.0\.0:)?8787:8787"' "$COMPOSE_FILE"; then
        nope "compose does not publish a wildcard 8787" "found a non-loopback 8787 publish"
    else
        ok "compose does not publish a wildcard 8787"
    fi
}

echo ""
echo "=== hermes WebUI: deploy health gate ==="

# Test: deploy.sh polls the WebUI with a bounded loop that fails the deploy.
test_deploy_poll_is_bounded() {
    local block
    block=$(awk '/^if should_deploy "hermes" \|\| should_deploy "all"; then/,/^fi$/' "$DEPLOY_SCRIPT")
    if echo "$block" | grep -qF 'http://127.0.0.1:8787/health'; then
        ok "deploy.sh polls the WebUI health endpoint"
    else
        nope "deploy.sh polls the WebUI health endpoint" "no 8787/health probe in the hermes block"
    fi
    if echo "$block" | grep -qF 'curl -fsS --max-time 10 http://127.0.0.1:8787/health'; then
        ok "deploy.sh bounds each WebUI probe with --max-time"
    else
        nope "deploy.sh bounds each WebUI probe" "no 'curl -fsS --max-time 10' WebUI probe"
    fi
    if echo "$block" | grep -qF 'webui_up=false' && echo "$block" | grep -qF 'for _ in $(seq 1 10)'; then
        ok "deploy.sh bounds the WebUI poll to 10 attempts"
    else
        nope "deploy.sh bounds the WebUI poll to 10 attempts" "no counter with seq 1 10"
    fi
    if echo "$block" | grep -qF 'sleep 6'; then
        ok "deploy.sh sleeps between WebUI attempts"
    else
        nope "deploy.sh sleeps between WebUI attempts" "no sleep between attempts"
    fi
    if echo "$block" | grep -qF 'failed=$((failed + 1))'; then
        ok "deploy.sh fails the deploy when the WebUI never answers"
    else
        nope "deploy.sh fails the deploy when the WebUI never answers" "no failed counter increment"
    fi
}

test_ref_is_commit
test_remote_named_before_fetch
test_fetches_pinned_ref
test_checkout_destination
test_s6_service_installed
test_webui_dependency_isolated
test_service_type
test_run_script_shape
test_launcher_env_values
test_csp_frame_extra_forwarded
test_compose_publishes_loopback
test_deploy_poll_is_bounded

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1