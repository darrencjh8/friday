#!/bin/bash
# Verify docker-compose.yml has required env vars for the hermes service.
# HERMES_WRITE_SAFE_ROOT must include /opt/data, /workspace, and /tmp
# so Hermes can write to its internal data volume, git worktrees, and scratch space.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/../../docker-compose.yml"

echo "=== docker-compose.yml: hermes env vars ==="

# Extract env vars for the hermes service from the compose file.
# Uses awk to get all lines between "hermes:" and the next top-level key (dedented or end of file).
get_hermes_env() {
    awk '/^[[:space:]]*hermes:/,/^[a-z]/' "$COMPOSE_FILE" | grep -E '^\s+- ' || true
}

# Test: HERMES_WRITE_SAFE_ROOT is present
test_has_safe_root() {
    if grep -q 'HERMES_WRITE_SAFE_ROOT' "$COMPOSE_FILE"; then
        ok "HERMES_WRITE_SAFE_ROOT is present in docker-compose.yml"
    else
        nope "HERMES_WRITE_SAFE_ROOT" "not found in docker-compose.yml"
    fi
}

# Test: HERMES_WRITE_SAFE_ROOT includes /opt/data
test_has_opt_data() {
    local val
    val=$(grep 'HERMES_WRITE_SAFE_ROOT' "$COMPOSE_FILE" | head -1)
    if echo "$val" | grep -q '/opt/data'; then
        ok "HERMES_WRITE_SAFE_ROOT includes /opt/data"
    else
        nope "HERMES_WRITE_SAFE_ROOT includes /opt/data" "value: $val"
    fi
}

# Test: HERMES_WRITE_SAFE_ROOT includes /workspace
test_has_workspace() {
    local val
    val=$(grep 'HERMES_WRITE_SAFE_ROOT' "$COMPOSE_FILE" | head -1)
    if echo "$val" | grep -q '/workspace'; then
        ok "HERMES_WRITE_SAFE_ROOT includes /workspace"
    else
        nope "HERMES_WRITE_SAFE_ROOT includes /workspace" "value: $val"
    fi
}

# Test: HERMES_WRITE_SAFE_ROOT includes /tmp
test_has_tmp() {
    local val
    val=$(grep 'HERMES_WRITE_SAFE_ROOT' "$COMPOSE_FILE" | head -1)
    if echo "$val" | grep -q '/tmp'; then
        ok "HERMES_WRITE_SAFE_ROOT includes /tmp"
    else
        nope "HERMES_WRITE_SAFE_ROOT includes /tmp" "value: $val"
    fi
}

# Test: /workspace volume mount exists for hermes service
test_has_workspace_volume() {
    if grep -A 50 'hermes:' "$COMPOSE_FILE" | grep -q '/workspace'; then
        ok "/workspace volume mount exists for hermes service"
    else
        nope "/workspace volume mount exists" "not found in hermes service section"
    fi
}

# gh gives GH_TOKEN precedence over hosts.yml, so the hermes service must not
# inject the long-lived PAT as an ambient override. The PAT is delivered only as
# the root-only read-only secret mount, and no service environment may carry it.
test_app_auth_not_shadowed() {
    if awk '/^[[:space:]]*hermes:/,/^[a-z]/' "$COMPOSE_FILE" | grep -qE 'GH_TOKEN=.*FRIDAY_PAT'; then
        nope "App auth is not shadowed by ambient GH_TOKEN" "hermes service injects GH_TOKEN from FRIDAY_PAT"
    else
        ok "App auth is not shadowed by ambient GH_TOKEN"
    fi
}

# The PAT must not reach the hermes service environment at all; scoping is by the
# read-only secret mount, not by an environment variable.
test_pat_secret_not_in_compose_environment() {
    if awk '/^[[:space:]]*hermes:/,/^[a-z]/' "$COMPOSE_FILE" | grep -q 'FRIDAY_PAT='; then
        nope "T-pat-secret-delivery: FRIDAY_PAT is not in the hermes service environment" \
            "hermes service still exports FRIDAY_PAT"
    else
        ok "T-pat-secret-delivery: FRIDAY_PAT is not in the hermes service environment"
    fi
}

# The fallback PAT is delivered as a read-only mount of a root-only host file.
test_pat_secret_mounted_read_only() {
    if grep -q '/home/runner/data/hermes/friday_pat.secret:/run/secrets/friday_pat:ro' "$COMPOSE_FILE"; then
        ok "T-pat-secret-delivery: fallback PAT is a read-only secret mount"
    else
        nope "T-pat-secret-delivery: fallback PAT is a read-only secret mount" \
            "missing /home/runner/data/hermes/friday_pat.secret:/run/secrets/friday_pat:ro"
    fi
}

# The memory scripts must not read the long-lived PAT: it is scoped to the
# codex-router checkout refresh, and an ambient PAT there would bypass the App.
test_memory_scripts_do_not_read_pat() {
    local script_dir="$SCRIPT_DIR/../scripts"
    local leaked=""
    for f in "$script_dir/memory-backup.sh" "$script_dir/memory-restore.sh"; do
        if grep -q 'FRIDAY_PAT' "$f"; then
            leaked="$leaked $(basename "$f")"
        fi
    done
    if [ -n "$leaked" ]; then
        nope "T-memory-no-pat: memory scripts do not read FRIDAY_PAT" "still reads it in:$leaked"
    else
        ok "T-memory-no-pat: memory scripts do not read FRIDAY_PAT"
    fi
}

# The node services run node as PID 1 with no signal handler, so SIGTERM is
# ignored and every `docker stop` waits out the timeout and SIGKILLs them
# (exit 137). An init process forwards SIGTERM so they stop cleanly.
test_node_services_have_init() {
    local svc
    for svc in expense-tracker actual-api portfolio-tracker; do
        if python3 -c 'import sys,yaml; s=yaml.safe_load(open(sys.argv[1]))["services"][sys.argv[2]]; sys.exit(0 if s.get("init") is True else 1)' "$COMPOSE_FILE" "$svc"; then
            ok "$svc runs under an init process"
        else
            nope "$svc runs under an init process" "init: true not set"
        fi
    done
}

# Own Google Tasks callback wiring: fixed tailnet redirect needs the env,
# the redirect default, and the host-loopback-only published port.
test_gtasks_oauth_wiring() {
    if grep -q 'GTASKS_CLIENT_ID=' "$COMPOSE_FILE" && grep -q 'GTASKS_CLIENT_SECRET=' "$COMPOSE_FILE" && grep -q 'GTASKS_REDIRECT_URI=' "$COMPOSE_FILE"; then
        ok "gtasks OAuth env is wired"
    else
        nope "gtasks OAuth env" "GTASKS_CLIENT_ID/SECRET/REDIRECT_URI missing"
    fi
    if grep -q '127.0.0.1:8299:8299' "$COMPOSE_FILE"; then
        ok "gtasks callback port is host-loopback only"
    else
        nope "gtasks callback port" "127.0.0.1:8299:8299 not found"
    fi
}

test_revision_labels_are_wired() {
    local root="$(cd "$SCRIPT_DIR/../../.." && pwd)"
    local compose_labels
    compose_labels=$(grep -Fc 'org.opencontainers.image.revision: ${HERMES_SOURCE_REVISION:-unknown}' "$COMPOSE_FILE")
    if [ "$compose_labels" -eq 3 ] && grep -Fq 'org.opencontainers.image.revision: ${CODEX_ROUTER_REVISION:-unknown}' "$COMPOSE_FILE" && grep -q 'export HERMES_SOURCE_REVISION=' "$root/modules/build.sh" && grep -q 'export CODEX_ROUTER_REVISION=' "$root/modules/build.sh"; then
        ok "triage source revisions are labelled on app and router containers"
    else
        nope "triage source revision labels" "labels/build variables missing or incomplete"
    fi
}

# gtasks wiring lives in a root-level test so the dev-loop base control can run it.
test_gtasks_cli_wiring() {
    local root="$(cd "$SCRIPT_DIR/../../.." && pwd)"
    if python3 "$root/tests/test_gtasks_cli_wiring.py"; then
        ok "gtasks CLI wiring and skill safety"
    else
        nope "gtasks CLI wiring and skill safety" "Python assertions failed"
    fi
}

# Test: glibc malloc arenas are capped for hermes. The WebUI runs ~37 threads;
# uncapped, glibc keeps up to 8 arenas per core and freed memory is not reused
# across them, so RSS climbs and stays high (1.4 GB observed 2026-10-10).
test_hermes_malloc_arena_cap() {
    if get_hermes_env | grep -qE -- '- MALLOC_ARENA_MAX=2$'; then
        ok "hermes caps glibc malloc arenas (MALLOC_ARENA_MAX=2)"
    else
        nope "hermes MALLOC_ARENA_MAX" "MALLOC_ARENA_MAX=2 not in the hermes environment"
    fi
}

test_revision_labels_are_wired
test_hermes_malloc_arena_cap
test_has_safe_root
# Test: Mnemosyne sleep summarises with the in-process Hermes model. local_llm
# reads both flags from the environment at import, so config.yaml cannot set them.
test_mnemosyne_host_llm_enabled() {
    local env
    env=$(get_hermes_env)
    for var in MNEMOSYNE_LLM_ENABLED MNEMOSYNE_HOST_LLM_ENABLED; do
        if echo "$env" | grep -qE "^\s+- ${var}=true\s*$"; then
            ok "$var=true in the hermes environment"
        else
            nope "$var" "not set to true in the hermes environment"
        fi
    done
}

test_has_opt_data
test_has_workspace
test_has_tmp
test_has_workspace_volume
test_app_auth_not_shadowed
test_pat_secret_not_in_compose_environment
test_pat_secret_mounted_read_only
test_memory_scripts_do_not_read_pat
test_node_services_have_init
test_mnemosyne_host_llm_enabled
test_gtasks_cli_wiring
test_gtasks_oauth_wiring

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
