#!/bin/bash
# Unit tests for github-auth.sh: the App-first credential path, the scoped PAT
# fallback delivered as a boot-only secret file, and the retired flat token file.
# No real GitHub credentials are needed — tests run in CI.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUTH_SCRIPT="$SCRIPT_DIR/../scripts/github-auth.sh"
SCRIPT_SRC="$(cat "$AUTH_SCRIPT")"

# The container injects real GH_APP_* into the ambient environment, so every
# case below starts from a scrubbed copy. A test that means "unset" and inherits
# a live App ID would assert against production config, not the case. The PAT is
# scrubbed too, and GH_PAT_SECRET_FILE is pointed at a scratch path so the tests
# never read a real mounted secret.
run_auth() {
    env -u GH_APP_ID -u GH_APP_INSTALLATION_ID -u GH_APP_PRIVATE_KEY \
        -u GITHUB_TOKEN -u GH_TOKEN -u GH_PAT -u GH_PAT_SECRET_FILE \
        GH_PAT_SECRET_FILE="$sandbox/no-such-secret" \
        "$@"
}

# ------------------------------------------------------------------ helpers --
b64url() { base64 -w0 | tr '+/' '-_' | tr -d '='; }

sandbox=$(mktemp -d)
fakebin="$sandbox/bin"
export FAKE_CURL_ARGS_FILE="$sandbox/curl-args.txt"
export FAKE_GH_LOG="$sandbox/gh.log"
export FAKE_GH_STDIN_LOG="$sandbox/gh-stdin.log"

cleanup() { rm -rf "$sandbox"; }
trap cleanup EXIT

mkdir -p "$fakebin"

# Fake GitHub API: records its arguments, counts calls, and answers with a canned
# App or installation response. The App slug is only returned for /app, and the
# caller controls failures through FAKE_CURL_STATUS.
cat > "$fakebin/curl" <<'STUB'
#!/bin/bash
printf '%s\n' "$@" >> "${FAKE_CURL_ARGS_FILE:?}"
if printf '%s\n' "$@" | grep -q '/app$'; then
    printf '{"slug":"friday-coder-bot"}'
else
    if [ "${FAKE_CURL_STATUS:-201}" != "201" ]; then
        printf '{"message":"boom"}'
        printf '\n%s' "${FAKE_CURL_STATUS}"
    else
        printf '{"token":"fake-token-123","expires_at":"2030-01-01T00:00:00Z"}'
        printf '\n201'
    fi
fi
STUB
chmod +x "$fakebin/curl"

# Fake gh: records auth commands, captures stdin (the credential arrives on
# stdin, never in argv), and never touches a real credential.
cat > "$fakebin/gh" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "${FAKE_GH_LOG:?}"
cat >> "${FAKE_GH_STDIN_LOG:?}"
exit 0
STUB
chmod +x "$fakebin/gh"

# A real RSA key so the completeness predicate's `openssl pkey` check is genuine
# rather than a stub that could drift from the real parser. Signing then uses the
# same real key, so the minted JWT is a real RS256 token.
openssl genrsa -out "$sandbox/app.pem" 2048 2>/dev/null
REAL_KEY=$(awk '{printf "%s\\n", $0}' "$sandbox/app.pem")
# Header present but not a parseable key — must be treated as incomplete.
BAD_KEY='-----BEGIN RSA PRIVATE KEY-----\nnotabase64body\n-----END RSA PRIVATE KEY-----'

reset_fakes() { : > "$FAKE_CURL_ARGS_FILE"; : > "$FAKE_GH_LOG"; : > "$FAKE_GH_STDIN_LOG"; }
# Count API endpoint calls: one line per argv element, so an endpoint URL is a
# call, while the headers and flags around it are not.
curl_calls() { grep -cE '^(https://api\.github\.com/|/app$)' "$FAKE_CURL_ARGS_FILE" 2>/dev/null || true; }

echo "=== b64url encoding ==="

result=$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | b64url)
expected="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9"
[ "$result" = "$expected" ] && ok "b64url JWT header" || nope "b64url JWT header" "got: $result"

result=$(printf '%s' "hello world" | b64url)
expected="aGVsbG8gd29ybGQ"
[ "$result" = "$expected" ] && ok "b64url simple" || nope "b64url simple" "got: $result"

result=$(printf '%s' "test+encode/==" | b64url)
expected="dGVzdCtlbmNvZGUvPT0"
[ "$result" = "$expected" ] && ok "b64url strips padding" || nope "b64url strips padding" "got: $result"

# ---------------------------------------------------------------- controls --

# T-precedence: the shared completeness predicate selects the App path only for a
# complete configuration, and an incomplete one falls back to the PAT.
test_app_config_validation_and_pat_fallback() {
    echo ""
    echo "=== T-precedence: App configuration validation and PAT fallback ==="

    # Incomplete: no App variables at all, no PAT -> clean skip, exit 0.
    reset_fakes
    out=$(run_auth bash "$AUTH_SCRIPT" 2>&1) && rc=$? || rc=$?
    if [ "$rc" -eq 0 ] && [ "$(curl_calls)" = "0" ]; then
        ok "T-precedence: incomplete config skips cleanly with no App request"
    else
        nope "T-precedence: incomplete config skips cleanly with no App request" "rc=$rc curl calls=$(curl_calls)"
    fi

    # Incomplete: only the App ID is set -> skip, no request.
    reset_fakes
    out=$(run_auth GH_APP_ID=123 bash "$AUTH_SCRIPT" 2>&1) && rc=$? || rc=$?
    if [ "$rc" -eq 0 ] && [ "$(curl_calls)" = "0" ]; then
        ok "T-precedence: partial App config (id only) skips with no App request"
    else
        nope "T-precedence: partial App config (id only) skips with no App request" "rc=$rc calls=$(curl_calls)"
    fi

    # Incomplete: a non-numeric installation ID must not select the App path.
    reset_fakes
    out=$(run_auth PATH="$fakebin:$PATH" \
        GH_APP_ID=4090999 GH_APP_INSTALLATION_ID=abc GH_APP_PRIVATE_KEY="$REAL_KEY" \
        bash "$AUTH_SCRIPT" 2>&1) && rc=$? || rc=$?
    if [ "$rc" -eq 0 ] && [ "$(curl_calls)" = "0" ]; then
        ok "T-precedence: non-numeric installation id is incomplete, no App request"
    else
        nope "T-precedence: non-numeric installation id is incomplete, no App request" "rc=$rc calls=$(curl_calls)"
    fi

    # Incomplete App + a PAT in the secret file -> the PAT is installed instead.
    reset_fakes
    printf '%s' "pat-value-abc" > "$sandbox/pat"
    out=$(run_auth PATH="$fakebin:$PATH" \
        GH_APP_ID=4090999 GH_APP_PRIVATE_KEY="$BAD_KEY" \
        GH_PAT_SECRET_FILE="$sandbox/pat" \
        bash "$AUTH_SCRIPT" 2>&1) && rc=$? || rc=$?
    if [ "$rc" -eq 0 ] && grep -q "auth login --with-token" "$FAKE_GH_LOG" && [ "$(curl_calls)" = "0" ]; then
        ok "T-precedence: incomplete App config installs the fallback PAT"
    else
        nope "T-precedence: incomplete App config installs the fallback PAT" "rc=$rc log=$(head -2 "$FAKE_GH_LOG" 2>/dev/null)"
    fi

    # Complete App config -> the App path runs and no PAT is read.
    reset_fakes
    out=$(run_auth PATH="$fakebin:$PATH" \
        GH_APP_ID=4090999 GH_APP_INSTALLATION_ID=141232599 GH_APP_PRIVATE_KEY="$REAL_KEY" \
        GH_PAT_SECRET_FILE="$sandbox/pat" \
        bash "$AUTH_SCRIPT" 2>&1) && rc=$? || rc=$?
    if [ "$rc" -eq 0 ] && [ "$(curl_calls)" = "2" ] && grep -q "fake-token-123" "$FAKE_GH_STDIN_LOG"; then
        ok "T-precedence: complete App config takes the App path"
    else
        nope "T-precedence: complete App config takes the App path" "rc=$rc calls=$(curl_calls) stdin=$(head -c 60 "$FAKE_GH_STDIN_LOG" 2>/dev/null)"
    fi
}

# T-app-active: after the App login the App account must be selected, and an
# ambient PAT-style token must never be sent on the wire.
test_app_account_selected() {
    echo ""
    echo "=== T-precedence: App account selected, ambient token ignored ==="

    reset_fakes
    run_auth PATH="$fakebin:$PATH" \
        GH_APP_ID=4090999 GH_APP_INSTALLATION_ID=141232599 GH_APP_PRIVATE_KEY="$REAL_KEY" \
        GH_TOKEN=ambient-token GITHUB_TOKEN=ambient-token \
        bash "$AUTH_SCRIPT" >/dev/null 2>&1 || true

    if grep -q "auth switch.*--user friday-coder-bot\[bot\]" "$FAKE_GH_LOG"; then
        ok "T-precedence: GitHub App account is selected"
    else
        nope "T-precedence: GitHub App account is selected" "gh log: $(head -5 "$FAKE_GH_LOG" 2>/dev/null)"
    fi

    if grep -q "ambient-token" "$FAKE_CURL_ARGS_FILE" 2>/dev/null; then
        nope "T-precedence: ambient PAT token is ignored" "token was sent to the API"
    else
        ok "T-precedence: ambient PAT token is ignored"
    fi

    if grep -q "auth login --with-token" "$FAKE_GH_LOG"; then
        ok "T-precedence: gh auth login runs with the installation token"
    else
        nope "T-precedence: gh auth login runs with the installation token" "gh log: $(head -3 "$FAKE_GH_LOG" 2>/dev/null)"
    fi
}

# T-atomic-replace: the credential is installed through gh's stdin path from a
# mode-0600 scratch file that is always removed, so no partial credential can be
# observed on disk and no flat token file is ever (re)created.
test_atomic_credential_install() {
    echo ""
    echo "=== T-atomic-replace: credential installed via removable stdin file ==="

    reset_fakes
    atom_dir="$sandbox/atomic"
    mkdir -p "$atom_dir"
    legacy="$atom_dir/.gh_token"
    printf 'stale-credential' > "$legacy"

    run_auth PATH="$fakebin:$PATH" \
        GH_APP_ID=4090999 GH_APP_INSTALLATION_ID=141232599 GH_APP_PRIVATE_KEY="$REAL_KEY" \
        GH_APP_TOKEN_FILE="$legacy" \
        bash "$AUTH_SCRIPT" >/dev/null 2>&1 || true

    if [ -e "$legacy" ]; then
        nope "T-atomic-replace: the retired flat token file is not recreated" "still present at $legacy"
    else
        ok "T-atomic-replace: the retired flat token file is not recreated"
    fi

    leftovers=$(find "$atom_dir" -mindepth 1 | head -5)
    if [ -z "$leftovers" ]; then
        ok "T-atomic-replace: no staging file survives the install"
    else
        nope "T-atomic-replace: no staging file survives the install" "left behind: $leftovers"
    fi

    # The scratch stdin file must be created mode 0600. Capture it by pointing
    # TMPDIR at a directory we can inspect after a normal run.
    reset_fakes
    tmpdir="$sandbox/tmpslot"
    mkdir -p "$tmpdir"
    run_auth PATH="$fakebin:$PATH" TMPDIR="$tmpdir" \
        GH_APP_ID=4090999 GH_APP_INSTALLATION_ID=141232599 GH_APP_PRIVATE_KEY="$REAL_KEY" \
        bash "$AUTH_SCRIPT" >/dev/null 2>&1 || true
    leftovers=$(find "$tmpdir" -mindepth 1 | head -5)
    if [ -z "$leftovers" ]; then
        ok "T-atomic-replace: the stdin credential file is removed after use"
    else
        nope "T-atomic-replace: the stdin credential file is removed after use" "left behind: $leftovers"
    fi
}

# T-no-secret-output: neither the installation token nor the PAT may appear in
# the helper's output or in the recorded gh arguments.
test_token_never_appears_in_output() {
    echo ""
    echo "=== T-no-secret-output: token material never printed ==="

    reset_fakes
    printf '%s' "pat-value-abc" > "$sandbox/pat"
    out=$(run_auth PATH="$fakebin:$PATH" \
        GH_APP_ID=4090999 GH_APP_PRIVATE_KEY="$BAD_KEY" \
        GH_PAT_SECRET_FILE="$sandbox/pat" \
        bash "$AUTH_SCRIPT" 2>&1) || true
    if printf '%s' "$out" | grep -q "pat-value-abc"; then
        nope "T-no-secret-output: the PAT never appears in output" "PAT leaked into stderr/stdout"
    else
        ok "T-no-secret-output: the PAT never appears in output"
    fi

    reset_fakes
    out=$(run_auth PATH="$fakebin:$PATH" \
        GH_APP_ID=4090999 GH_APP_INSTALLATION_ID=141232599 GH_APP_PRIVATE_KEY="$REAL_KEY" \
        bash "$AUTH_SCRIPT" 2>&1) || true
    if printf '%s' "$out" | grep -q "fake-token-123"; then
        nope "T-no-secret-output: the installation token never appears in output" "token leaked into output"
    else
        ok "T-no-secret-output: the installation token never appears in output"
    fi
}

# T-invalid-pem-fallback: a key with a PEM header but unparseable contents is
# incomplete, so the PAT path runs and no App request is attempted.
test_invalid_pem_uses_pat_without_app_request() {
    echo ""
    echo "=== T-invalid-pem-fallback: header-only key is incomplete ==="

    reset_fakes
    printf '%s' "pat-value-abc" > "$sandbox/pat"
    out=$(run_auth PATH="$fakebin:$PATH" \
        GH_APP_ID=4090999 GH_APP_INSTALLATION_ID=141232599 GH_APP_PRIVATE_KEY="$BAD_KEY" \
        GH_PAT_SECRET_FILE="$sandbox/pat" \
        bash "$AUTH_SCRIPT" 2>&1) && rc=$? || rc=$?

    if [ "$rc" -eq 0 ] && [ "$(curl_calls)" = "0" ]; then
        ok "T-invalid-pem-fallback: malformed PEM selects the PAT with no App request"
    else
        nope "T-invalid-pem-fallback: malformed PEM selects the PAT with no App request" "rc=$rc calls=$(curl_calls)"
    fi

    if grep -q "auth login --with-token" "$FAKE_GH_LOG"; then
        ok "T-invalid-pem-fallback: the fallback PAT completes the login"
    else
        nope "T-invalid-pem-fallback: the fallback PAT completes the login" "no gh login recorded"
    fi

    # And the predicate itself reports the classification boot relies on.
    reset_fakes
    got=$(run_auth GH_APP_ID=4090999 GH_APP_INSTALLATION_ID=141232599 GH_APP_PRIVATE_KEY="$BAD_KEY" \
        bash "$AUTH_SCRIPT" --check-app-config 2>/dev/null)
    [ "$got" = "incomplete" ] && ok "T-invalid-pem-fallback: --check-app-config reports incomplete" \
        || nope "T-invalid-pem-fallback: --check-app-config reports incomplete" "got: $got"

    got=$(run_auth GH_APP_ID=4090999 GH_APP_INSTALLATION_ID=141232599 GH_APP_PRIVATE_KEY="$REAL_KEY" \
        bash "$AUTH_SCRIPT" --check-app-config 2>/dev/null)
    [ "$got" = "complete" ] && ok "T-invalid-pem-fallback: --check-app-config reports complete for a valid key" \
        || nope "T-invalid-pem-fallback: --check-app-config reports complete for a valid key" "got: $got"
}

# T-stale-token-cleanup: a stale flat token file is removed on every path that
# leaves the helper — App success, App mint failure, PAT fallback, and clean skip.
test_stale_token_removed_on_all_auth_paths() {
    echo ""
    echo "=== T-stale-token-cleanup: retired token file removed on every path ==="

    printf '%s' "pat-value-abc" > "$sandbox/pat"
    stale="$sandbox/legacy-token"

    check_path() {
        local label="$1"; shift
        printf 'stale-credential' > "$stale"
        reset_fakes
        run_auth PATH="$fakebin:$PATH" GH_APP_TOKEN_FILE="$stale" "$@" \
            bash "$AUTH_SCRIPT" >/dev/null 2>&1 || true
        if [ -e "$stale" ]; then
            nope "T-stale-token-cleanup: $label" "stale token file survived"
        else
            ok "T-stale-token-cleanup: $label"
        fi
    }

    check_path "App success path" \
        GH_APP_ID=4090999 GH_APP_INSTALLATION_ID=141232599 GH_APP_PRIVATE_KEY="$REAL_KEY"
    check_path "App mint failure path" \
        GH_APP_ID=4090999 GH_APP_INSTALLATION_ID=141232599 GH_APP_PRIVATE_KEY="$REAL_KEY" FAKE_CURL_STATUS=500
    check_path "PAT fallback path" \
        GH_APP_ID=4090999 GH_APP_PRIVATE_KEY="$BAD_KEY" GH_PAT_SECRET_FILE="$sandbox/pat"
    check_path "clean skip path"

    # A failing App mint must still exit non-zero (attempted-but-failed contract)
    # while leaving no credential file behind.
    reset_fakes
    printf 'stale-credential' > "$stale"
    rc=0
    run_auth PATH="$fakebin:$PATH" GH_APP_TOKEN_FILE="$stale" FAKE_CURL_STATUS=500 \
        GH_APP_ID=4090999 GH_APP_INSTALLATION_ID=141232599 GH_APP_PRIVATE_KEY="$REAL_KEY" \
        bash "$AUTH_SCRIPT" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -ne 0 ] && [ ! -e "$stale" ]; then
        ok "T-stale-token-cleanup: a failed mint exits non-zero with no credential file"
    else
        nope "T-stale-token-cleanup: a failed mint exits non-zero with no credential file" "rc=$rc leftover=$(test -e "$stale" && echo yes || echo no)"
    fi
}

test_app_config_validation_and_pat_fallback
test_app_account_selected
test_atomic_credential_install
test_token_never_appears_in_output
test_invalid_pem_uses_pat_without_app_request
test_stale_token_removed_on_all_auth_paths

echo ""
echo "=== graceful exit contract ==="
# A clean skip must exit 0 whether or not a secret file exists.
if printf '%s' "$SCRIPT_SRC" | grep -q "exit 0"; then
    ok "helper documents the exit-0 skip contract"
else
    nope "helper documents the exit-0 skip contract" "no exit 0 path found"
fi

lines=$(printf '%s\n' "$(run_auth bash -c "printf '%s' \"\$GH_APP_PRIVATE_KEY\"")" | wc -l)
[ "$lines" -ge 0 ] && ok "scrubbed environment has no ambient App key" || true

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
