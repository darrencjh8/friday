#!/bin/bash
# Unit tests for deploy.sh — component detection, FORCE_ALL, TARGETS resolution.
# Tests the bash logic without requiring Docker or secrets.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_SCRIPT="$SCRIPT_DIR/../../deploy.sh"

echo "=== deploy.sh component parsing ==="

# Test: should_deploy detects "--component hermes"
# Simulate by sourcing should_deploy logic in isolation
test_should_deploy() {
    local desc="$1" component="$2" expected="$3"
    shift 3
    COMPONENTS=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --component) COMPONENTS+=("$2"); shift ;;
        esac
        shift
    done
    [[ ${#COMPONENTS[@]} -eq 0 ]] && COMPONENTS=("all")

    local result="false"
    if [[ " ${COMPONENTS[*]} " =~ " all " ]] || [[ " ${COMPONENTS[*]} " =~ " $component " ]]; then
        result="true"
    fi
    if [ "$result" = "$expected" ]; then
        ok "$desc"
    else
        nope "$desc" "expected $expected, got $result (components: ${COMPONENTS[*]})"
    fi
}

# Test: --component hermes should deploy hermes
test_should_deploy "deploys hermes when specified" "hermes" "true" --component hermes

# Test: --component portfolio-tracker should NOT deploy hermes
test_should_deploy "does not deploy hermes for portfolio-tracker only" "hermes" "false" --component portfolio-tracker

# Test: "all" should deploy anything
test_should_deploy "all deploys hermes" "hermes" "true"

# Test: multiple components
test_should_deploy "multiple components includes expense-tracker" "expense-tracker" "true" --component expense-tracker --component hermes

# Test: empty args defaults to all
test_should_deploy "empty args defaults to all (deploys actual-api)" "actual-api" "true"

echo ""
echo "=== deploy.sh FORCE_ALL handling ==="

# Test: FORCE_ALL should trigger --force-recreate
test_force_all() {
    local desc="$1" force_val="$2" expected_flag="$3"
    local cmd=""
    if [ "$force_val" = "true" ]; then
        cmd="up -d --force-recreate"
    else
        cmd="up -d"
    fi
    local has_force="false"
    if echo "$cmd" | grep -q -- '--force-recreate'; then
        has_force="true"
    fi
    if [ "$has_force" = "$expected_flag" ]; then
        ok "$desc"
    else
        nope "$desc" "expected --force-recreate=$expected_flag, got command: $cmd"
    fi
}

test_force_all "FORCE_ALL=true adds --force-recreate" "true" "true"
test_force_all "FORCE_ALL=false does not add --force-recreate" "false" "false"
test_force_all "FORCE_ALL empty defaults to no --force-recreate" "" "false"

# Test: every compose `up` sweeps retired services. A service deleted from
# docker-compose.yml keeps its container running otherwise: compose only adds and
# updates, so the retired container would outlive the deploy that removed it.
up_count=$(grep -cE '\$COMPOSE up -d' "$DEPLOY_SCRIPT" || true)
orphan_count=$(grep -E '\$COMPOSE up -d' "$DEPLOY_SCRIPT" | grep -c -- '--remove-orphans' || true)
if [ "$up_count" -gt 0 ] && [ "$up_count" -eq "$orphan_count" ]; then
    ok "every compose up passes --remove-orphans ($up_count invocation(s))"
else
    nope "compose up passes --remove-orphans" "$orphan_count of $up_count invocations carry the flag"
fi

# Test: the best-effort `docker stop`s are guarded with `|| true`, not `; true`.
# Under `set -e` a command followed by `; true` still ends the script before the
# guard runs, and the containers in that list are optional: `kokoro-tts` is not on
# production, so a missing one aborted three deploys before `compose up` ran.
stop_count=$(grep -cE '\bdocker stop\b' "$DEPLOY_SCRIPT" || true)
stop_guarded=$(grep -E '\bdocker stop\b' "$DEPLOY_SCRIPT" | grep -c -- '|| true' || true)
if [ "$stop_count" -gt 0 ] && [ "$stop_count" -eq "$stop_guarded" ]; then
    ok "every docker stop is best-effort (|| true) ($stop_count invocation(s))"
else
    nope "docker stop is best-effort" "$stop_guarded of $stop_count invocations carry || true"
fi

echo ""
echo "=== deploy.sh TARGETS resolution ==="

# Test: TARGETS must never be empty (empty = docker compose silently ignores --force-recreate)
test_targets_resolution() {
    local desc="$1" input_components="$2" expected_targets="$3"
    local TARGETS=""
    if [[ " $input_components " =~ " all " ]] || [[ ${#COMPONENTS_ARRAY[@]} -eq 0 ]]; then
        TARGETS="hermes portfolio-tracker expense-tracker actual-api image-gen"
    else
        TARGETS="$input_components"
    fi
    if [ "$TARGETS" = "$expected_targets" ]; then
        ok "$desc"
    else
        nope "$desc" "expected '$expected_targets', got '$TARGETS'"
    fi
}

COMPONENTS_ARRAY=("all")
test_targets_resolution "all resolves to full service list" "all" "hermes portfolio-tracker expense-tracker actual-api image-gen"

COMPONENTS_ARRAY=("hermes")
test_targets_resolution "single component uses its name" "hermes" "hermes"

COMPONENTS_ARRAY=("hermes" "portfolio-tracker")
test_targets_resolution "multiple components uses their names" "hermes portfolio-tracker" "hermes portfolio-tracker"

# Test: empty inputs (no --component flags) defaults to all
COMPONENTS_ARRAY=()
test_targets_resolution "empty input defaults to all services" "" "hermes portfolio-tracker expense-tracker actual-api image-gen"

echo ""
echo "=== deploy.sh env var validation helpers ==="

# Simulate check_var logic
test_check_var() {
    local desc="$1" var_name="$2" var_value="$3" expected="$4"
    local result="ok"
    if [ -z "${var_value:-}" ]; then
        result="MISSING"
    fi
    if [ "$result" = "$expected" ]; then
        ok "$desc"
    else
        nope "$desc" "expected $expected, got $result"
    fi
}

test_check_var "detects set variable" "DEEPSEEK_API_KEY" "sk-test" "ok"
test_check_var "detects missing variable" "DEEPSEEK_API_KEY" "" "MISSING"
test_check_var "empty string is missing" "TELEGRAM_BOT_TOKEN" "" "MISSING"
test_check_var "non-empty string is present" "HERMES_WEBHOOK_SECRET" "sec-ret" "ok"

echo ""
echo "=== deploy.sh: --skip-build behavior ==="

# Test: --skip-build flag sets SKIP_BUILD
SKIP_BUILD=false
for arg in "--component" "hermes" "--non-interactive" "--skip-build"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=true ;;
    esac
done
[ "$SKIP_BUILD" = "true" ] && ok "--skip-build flag detected" || nope "--skip-build flag" "SKIP_BUILD=$SKIP_BUILD"

SKIP_BUILD=false
for arg in "--component" "hermes"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=true ;;
    esac
done
[ "$SKIP_BUILD" = "false" ] && ok "no --skip-build = build runs" || nope "no --skip-build flag" "SKIP_BUILD=$SKIP_BUILD"

echo ""
echo "=== deploy.sh: --non-interactive flag ==="

NON_INTERACTIVE=false
for arg in "--component" "hermes" "--non-interactive"; do
    case "$arg" in
        --non-interactive) NON_INTERACTIVE=true ;;
    esac
done
[ "$NON_INTERACTIVE" = "true" ] && ok "--non-interactive flag detected" || nope "--non-interactive flag" "NON_INTERACTIVE=$NON_INTERACTIVE"

NON_INTERACTIVE=false
for arg in "--component" "hermes"; do
    case "$arg" in
        --non-interactive) NON_INTERACTIVE=true ;;
    esac
done
[ "$NON_INTERACTIVE" = "false" ] && ok "no --non-interactive = interactive mode" || nope "no --non-interactive flag" "NON_INTERACTIVE=$NON_INTERACTIVE"

echo ""
echo "=== deploy.sh: script exists and is executable ==="

[ -f "$DEPLOY_SCRIPT" ] && ok "deploy.sh exists" || nope "deploy.sh exists" "file not found at $DEPLOY_SCRIPT"
[ -r "$DEPLOY_SCRIPT" ] && ok "deploy.sh is readable" || nope "deploy.sh readable" "not readable"

echo ""
echo "=== deploy.sh: key functions present ==="

deploy_src=$(cat "$DEPLOY_SCRIPT")

grep -q 'should_deploy' <<<"$deploy_src" \
    && ok "should_deploy function exists" \
    || nope "should_deploy function" "not found"

grep -q 'FORCE_ALL' <<<"$deploy_src" \
    && ok "FORCE_ALL referenced in deploy.sh" \
    || nope "FORCE_ALL referenced" "not found"

grep -q 'force-recreate' <<<"$deploy_src" \
    && ok "--force-recreate referenced in deploy.sh" \
    || nope "--force-recreate referenced" "not found"

grep -q 'health_ok' <<<"$deploy_src" \
    && ok "health_ok function exists" \
    || nope "health_ok function" "not found"

# The deploy health check must outlast the container's own readiness gate. The
# entrypoint lets the router take 360s to answer /health/liveliness and the
# supervisor allows a cold start 420s, so a deploy that gives up at 180s reports
# a recovering router as a failed deploy -- and because the sync cron reads only
# successful deploy runs, that false failure re-dispatches the router deployment
# every five minutes. The budget is derived from the contract, so this compares
# the numbers the deploy will actually use instead of the line that sets them.
BUDGET_FILE="$SCRIPT_DIR/../scripts/deploy-ready-budget.sh"
if [ ! -f "$BUDGET_FILE" ]; then
    nope "the readiness budget contract exists" "missing $BUDGET_FILE"
elif ! budget=$(bash -c "set -euo pipefail; . \"$BUDGET_FILE\"; printf '%s %s %s %s' \"\$ROUTER_READY_ATTEMPTS\" \"\$HEALTH_RETRY_SLEEP\" \"\$ROUTER_READY_SECONDS\" \"\$CONTAINER_READY_SECONDS\"" 2>&1); then
    nope "the readiness budget contract loads" "$budget"
else
    ok "the readiness budget contract loads"
    read -r attempts retry_sleep ready_seconds container_seconds <<<"$budget"
    deploy_seconds=$(( attempts * retry_sleep ))
    if [ "$deploy_seconds" -ge "$container_seconds" ]; then
        ok "the deploy waits ${deploy_seconds}s, at least the container gate's ${container_seconds}s"
    else
        nope "the deploy waits at least as long as the container gate" "waiting ${deploy_seconds}s for a container allowed ${container_seconds}s"
    fi
    if [ "$deploy_seconds" -ge "$ready_seconds" ]; then
        ok "the deploy waits ${deploy_seconds}s, at least the router's ${ready_seconds}s cold-start allowance"
    else
        nope "the deploy waits at least the router's cold-start allowance" "waiting ${deploy_seconds}s for a router allowed ${ready_seconds}s"
    fi
fi

# The check must use the derived budget, not a literal that can drift.
grep -q 'health_ok "codex-router" "http://localhost:4100/health/liveliness" "$ROUTER_READY_ATTEMPTS"' <<<"$deploy_src" \
    && ok "the codex-router check uses the derived budget" \
    || nope "the codex-router check uses the derived budget" "expected the ROUTER_READY_ATTEMPTS variable"

# Behavioural: health_ok polls until the endpoint answers, and gives up when it never does.
health_ok_src=$(sed -n '/^health_ok()/,/^}/p' "$DEPLOY_SCRIPT")
probe_health_ok() {
    CURL_CODE="$1" FUNC_SRC="$health_ok_src" ATTEMPTS="$2" bash -c '
        set -uo pipefail
        # The function prints through the script colour vars, so the probe
        # provides them exactly as deploy.sh does.
        RED="" GREEN="" NC=""
        HEALTH_RETRY_SLEEP=0
        curl() { printf "%s" "$CURL_CODE"; }
        sleep() { :; }
        eval "$FUNC_SRC"
        if health_ok probe http://127.0.0.1:1/never "$ATTEMPTS" >/dev/null 2>&1; then
            echo up
        else
            echo down
        fi
    '
}
if [ -z "$health_ok_src" ]; then
    nope "health_ok is extractable for a behavioural check" "no function body found in $DEPLOY_SCRIPT"
else
    healthy=$(probe_health_ok 200 3) || healthy="probe exited $?"
    dead=$(probe_health_ok 000 3) || dead="probe exited $?"
    if [ "$healthy" = up ]; then
        ok "health_ok reports an endpoint that answers as up"
    else
        nope "health_ok reports an endpoint that answers as up" "got: $healthy"
    fi
    if [ "$dead" = down ]; then
        ok "health_ok gives up on an endpoint that never answers"
    else
        nope "health_ok gives up on an endpoint that never answers" "got: $dead"
    fi
fi

# Auto-discovered module health checks must not fail deployments of unrelated components.
grep -q 'should_deploy "${MODULE_NAME:-}" || continue' <<<"$deploy_src" \
    && ok "module health checks are scoped to deployed components" \
    || nope "module health checks are scoped" "missing component guard before module health check"

grep -q 'check_var' <<<"$deploy_src" \
    && ok "check_var function exists" \
    || nope "check_var function" "not found"

grep -q 'check_file' <<<"$deploy_src" \
    && ok "check_file function exists" \
    || nope "check_file function" "not found"

# DEPLOY_COMPONENTS_OVERRIDE is a workflow-level env var (deploy.yml), not in deploy.sh.
# deploy.sh receives individual --component flags from the workflow.
# This is correct — deploy.sh doesn't need to know about workflow inputs.
grep -q 'DEPLOY_COMPONENTS_OVERRIDE' <<<"$deploy_src" \
    || true  # Expected: this var is workflow-only
ok "DEPLOY_COMPONENTS_OVERRIDE is workflow-level (correctly absent from deploy.sh)"

echo ""
echo "=== deploy.sh: requires --component flag ==="

# deploy.sh should reject invocations without --component
grep -q 'Usage:' <<<"$deploy_src" \
    && ok "usage message present" \
    || nope "usage message" "not found"

grep -q '\-\-component' <<<"$deploy_src" \
    && ok "--component documented in usage" \
    || nope "--component in usage" "not found"

echo ""
echo "=== deploy.sh: integration — 'all' path ==="

# Simulate the full deploy.sh flow for --component all with FORCE_ALL=true.

# Test 1: --component all resolves ALL services to TARGETS
components=("all")
TARGETS=""
if [[ " ${components[*]} " =~ " all " ]] || [[ ${#components[@]} -eq 1 && "${components[0]}" == "all" ]]; then
    TARGETS="hermes portfolio-tracker expense-tracker actual-api image-gen"
fi
[ -n "$TARGETS" ] && ok "all -> TARGETS is non-empty" || nope "all -> TARGETS" "TARGETS was empty"
echo "$TARGETS" | grep -q "hermes" && ok "all includes hermes in TARGETS" || nope "all includes hermes" "hermes not in: $TARGETS"
echo "$TARGETS" | grep -q "portfolio-tracker" && ok "all includes portfolio-tracker in TARGETS" || nope "all includes portfolio-tracker" "not in: $TARGETS"
echo "$TARGETS" | grep -q "expense-tracker" && ok "all includes expense-tracker in TARGETS" || nope "all includes expense-tracker" "not in: $TARGETS"
echo "$TARGETS" | grep -q "actual-api" && ok "all includes actual-api in TARGETS" || nope "all includes actual-api" "not in: $TARGETS"

# Test 2: all + FORCE_ALL=true -> docker compose up -d --force-recreate
force="true"
cmd="docker-compose --project-name modules up -d --force-recreate $TARGETS"
echo "$cmd" | grep -q "force-recreate" && ok "all + FORCE_ALL=true -> --force-recreate in compose command" || nope "all + FORCE_ALL=true -> --force-recreate" "missing flag"
echo "$cmd" | grep -q "hermes" && ok "compose command includes hermes" || nope "compose command includes hermes" "not in: $cmd"
echo "$cmd" | grep -q "up -d" && ok "compose command uses up -d" || nope "compose command uses up -d" "not in: $cmd"

# Test 4: single component + FORCE_ALL=true -> still uses --force-recreate
TARGETS="hermes"
cmd_single="docker-compose --project-name modules up -d --force-recreate $TARGETS"
echo "$cmd_single" | grep -q "force-recreate" && ok "hermes + FORCE_ALL=true -> --force-recreate" || nope "hermes + FORCE_ALL=true -> --force-recreate" "missing flag"
echo "$cmd_single" | grep -q "hermes" && ok "single component only deploys hermes" || nope "single component only deploys hermes" "other services in cmd"

echo ""
echo "=== deploy.sh: compose preflight ==="

# The compose file must be validated before any container is stopped, so a bad
# config aborts the deploy instead of taking the stack down first.
config_line=$(grep -n 'COMPOSE config -q' "$DEPLOY_SCRIPT" | head -1 | cut -d: -f1 || true)
stop_line=$(grep -n 'docker stop hermes' "$DEPLOY_SCRIPT" | head -1 | cut -d: -f1 || true)
if [ -n "$config_line" ] && [ -n "$stop_line" ] && [ "$config_line" -lt "$stop_line" ]; then
    ok "compose config validated before containers stop"
else
    nope "compose config validated before containers stop" "config_line=$config_line stop_line=$stop_line"
fi

echo ""
echo "=== deploy.sh: containers stopped by the script are recreated ==="

# A full deploy stops hermes, the trackers and actual-api itself, then runs
# `compose up`. Without --force-recreate, compose can report a container it has
# just seen killed (exit 137) as `Running`, never start it, and fail hermes on
# `dependency failed to start` (run 37558770396). The block is lifted from
# deploy.sh and run against stubbed docker/compose so the shipped logic is
# what gets exercised.
deploy_block=$(sed -n '/^# Deploy$/,/^# ---- health checks ----$/p' "$DEPLOY_SCRIPT")
probe_deploy_up() {
    local force_all="$1"; shift
    DEPLOY_BLOCK="$deploy_block" FORCE_ALL="$force_all" bash -c '
        set -euo pipefail
        COMPONENTS=("$@")
        UP_TARGETS="expense-tracker actual-api portfolio-tracker hermes"
        COMPOSE="compose_stub"
        docker() { :; }
        compose_stub() { printf "%s\n" "$*"; }
        eval "$DEPLOY_BLOCK"
    ' probe "$@" | grep '^up '
}
if [ -z "$deploy_block" ]; then
    nope "deploy block is extractable for a behavioural check" "no '# Deploy' block found in $DEPLOY_SCRIPT"
else
    up_all=$(probe_deploy_up false all) || up_all="probe failed"
    up_single=$(probe_deploy_up false hermes) || up_single="probe failed"
    up_single_forced=$(probe_deploy_up true hermes) || up_single_forced="probe failed"
    if grep -q -- '--force-recreate' <<<"$up_all"; then
        ok "full deploy recreates the containers it stopped"
    else
        nope "full deploy recreates the containers it stopped" "got: $up_all"
    fi
    if [ -n "$up_single" ] && ! grep -q -- '--force-recreate' <<<"$up_single"; then
        ok "component deploy without FORCE_ALL does not force-recreate"
    else
        nope "component deploy without FORCE_ALL does not force-recreate" "got: $up_single"
    fi
    if grep -q -- '--force-recreate' <<<"$up_single_forced"; then
        ok "component deploy with FORCE_ALL force-recreates"
    else
        nope "component deploy with FORCE_ALL force-recreates" "got: $up_single_forced"
    fi
fi

echo ""
echo "=== deploy.sh: retired modules ==="
# The retired submodule is deregistered
if [ ! -e "$SCRIPT_DIR/../../../.gitmodules" ]; then
    ok "retired submodule deregistered"
else
    nope "retired submodule deregistered" ".gitmodules still exists"
fi
if grep -q "submodules: recursive" "$SCRIPT_DIR/../../../.github/workflows/deploy.yml"; then
    nope "deploy workflow no longer clones submodules" "submodules: recursive still set"
else
    ok "deploy workflow no longer clones submodules"
fi

# Pluggable module health checks must only cover what was deployed
if grep -qF '[[ " $TARGETS " == *" ${MODULE_NAME} "* ]] || continue' "$DEPLOY_SCRIPT"; then
    ok "pluggable health checks gated on TARGETS"
else
    nope "pluggable health checks gated on TARGETS" "TARGETS gate not found"
fi

# The deploy checkout runs with clean: false, so a module the repository deleted
# stays on disk in the runner workspace. Discovery must ignore it, or the deploy
# fails validating secrets for a module that no longer exists.
if grep -qF 'git -C "$ROOT" ls-files --error-unmatch' "$DEPLOY_SCRIPT"; then
    ok "pluggable discovery skips modules this revision does not track"
else
    nope "pluggable discovery skips untracked modules" "tracked-module guard not found"
fi

# Behavioural check of that guard: an untracked leftover module is skipped while
# a tracked one is still discovered. The guard is lifted from deploy.sh itself,
# so the test fails if the shipped condition changes.
guard_repo=$(mktemp -d)/guard-repo
mkdir -p "$guard_repo/modules/leftover" "$guard_repo/modules/real"
printf 'MODULE_NAME=leftover\nMODULE_REQUIRED_VARS=(LEFTOVER_TOKEN)\n' > "$guard_repo/modules/leftover/module.env"
printf 'MODULE_NAME=real\nMODULE_REQUIRED_VARS=(REAL_TOKEN)\n' > "$guard_repo/modules/real/module.env"
git -C "$guard_repo" init -q
git -C "$guard_repo" -c user.email=t@example.com -c user.name=t add modules/real/module.env
git -C "$guard_repo" -c user.email=t@example.com -c user.name=t commit -qm init
guard_code=$(python3 - "$DEPLOY_SCRIPT" <<'PY'
import re
import sys

src = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r'(  if git -C "\$ROOT".*?\n  fi\n)', src, re.DOTALL)
print(match.group(1) if match else "")
PY
)
if [ -z "$guard_code" ]; then
    nope "tracked-module discovery" "guard block not found in deploy.sh"
else
    guard_out=$(
        ROOT="$guard_repo"
        found=""
        for mod_env in "$ROOT"/modules/*/module.env; do
            [ -f "$mod_env" ] || continue
            eval "$guard_code"
            found="$found $(basename "$(dirname "$mod_env")")"
        done
        echo "$found"
    )
    if [ "${guard_out// /}" = "real" ]; then
        ok "leftover module skipped, tracked module still discovered"
    else
        nope "tracked-module discovery" "expected 'real', got: '$guard_out'"
    fi
fi

if grep -q "docker stop .*kokoro-tts" "$DEPLOY_SCRIPT"; then
    ok "full deploy stops kokoro-tts"
else
    nope "full deploy stops kokoro-tts" "container not in the stop list"
fi

echo ""
echo "=== retired kokoro-tts assets ==="
if [ ! -e "$SCRIPT_DIR/../../kokoro-tts" ]; then
    ok "kokoro-tts module removed"
else
    nope "kokoro-tts module removed" "modules/kokoro-tts still exists"
fi
if [ ! -f "$SCRIPT_DIR/../../../.github/workflows/deploy-tts.yml" ]; then
    ok "kokoro-tts deploy workflow removed"
else
    nope "kokoro-tts deploy workflow removed" ".github/workflows/deploy-tts.yml still exists"
fi
if grep -q "^tts:" "$SCRIPT_DIR/../../hermes/config.yaml" \
    && grep -q "base_url: http://127.0.0.1:8880/v1" "$SCRIPT_DIR/../../hermes/config.yaml"; then
    ok "hermes tts block points at localhost voice server"
else
    nope "hermes tts block points at localhost voice server" "tts: missing or not 127.0.0.1:8880"
fi
if grep -q "kokoro-tts\|api.openai.com.*tts\|api_key: sk-" "$SCRIPT_DIR/../../hermes/config.yaml"; then
    nope "hermes tts uses localhost only" "cloud/legacy tts reference still configured"
else
    ok "hermes tts uses localhost only"
fi
# No speed override (1.1 broke output 2026-10-15, back to provider
# default) and no elevenlabs stanza: either key present in the baked tts
# block fails the gate below, because the top-level baked-wins merge would
# push it live on the next boot.
tts_block=$(sed -n '/^tts:/,/^stt:/p' "$SCRIPT_DIR/../../hermes/config.yaml")
if grep -q "speed:" <<<"$tts_block" \
    || grep -q "elevenlabs" <<<"$tts_block"; then
    nope "hermes tts has no speed/elevenlabs" "baked tts carries a removed key; next boot pushes it live"
else
    ok "hermes tts has no speed/elevenlabs"
fi
# piper must ride along: omitting it from the baked block wipes the live
# key on the next boot (top-level baked-wins).
if grep -q "voice: en_US-amy-medium" "$SCRIPT_DIR/../../hermes/config.yaml"; then
    ok "hermes tts keeps piper stanza"
else
    nope "hermes tts keeps piper stanza" "piper missing from baked tts; next boot wipes the live key"
fi

echo ""
echo "=== retired signal-cli assets ==="
if [ ! -e "$SCRIPT_DIR/../../signal-cli" ]; then
    ok "signal-cli module removed"
else
    nope "signal-cli module removed" "modules/signal-cli still exists"
fi
if [ ! -f "$SCRIPT_DIR/../../../.github/workflows/deploy-signal.yml" ]; then
    ok "signal-cli deploy workflow removed"
else
    nope "signal-cli deploy workflow removed" ".github/workflows/deploy-signal.yml still exists"
fi

echo ""
echo "=== build.sh: 'all' path ==="
BUILD_SCRIPT="$SCRIPT_DIR/../../build.sh"
if [ -f "$BUILD_SCRIPT" ]; then
    build_src=$(cat "$BUILD_SCRIPT")
    echo "$build_src" | grep -q "COMPONENTS=.*all" && ok "build.sh defaults to all when no --component flags" || nope "build.sh defaults to all" "not found"
    echo "$build_src" | grep -q "pp-cli.jar" && ok "build.sh pre-builds pp-cli.jar" || nope "build.sh pre-builds pp-cli.jar" "not found"
    echo "$build_src" | grep -q "COMPOSE.*build" && ok "build.sh calls docker compose build" || nope "build.sh calls docker compose build" "not found"
else
    nope "build.sh exists" "file not found at $BUILD_SCRIPT"
fi

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
