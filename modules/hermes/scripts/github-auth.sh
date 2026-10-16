#!/bin/bash
# Configure gh CLI auth for the hermes runtime user.
#
# App-first: when the GitHub App configuration is complete, mint a short-lived
# installation token and log gh in as the App. Only when that configuration is
# incomplete does the scoped fallback PAT apply. Neither usable = skip.
#
# Exit contract: 0 when the credential was installed OR the configuration is
# incomplete/skipped (log only, no alert); non-zero only after a valid App
# configuration was selected and mint/auth/parse failed.
#
# Idempotent — safe to run on every boot and every cron tick.
#
# --check-app-config prints `complete` or `incomplete` and exits 0. It exposes
# the App-completeness test so the same rule can be reused.
# ponytail: boot does not call it. Boot runs once per container start, so the
# extra `su` round-trip buys nothing; boot gates on coarse variable presence and
# lets this helper make the real App-vs-fallback decision. If the completeness
# rule ever changes, keep boot's presence check in sync.
set -euo pipefail

log() { echo "[github-auth] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Installation credentials must win over any ambient PAT-style override.
unset GH_TOKEN GITHUB_TOKEN

# The legacy flat token file is retired: gh owns hosts.yml, and this helper
# feeds the minted token through stdin only, so nothing reads that path. Clear
# it at entry and again on every exit path, including signals, so a failure at
# any stage cannot leave a stale installation credential on disk.
LEGACY_TOKEN_FILE="${GH_APP_TOKEN_FILE:-/opt/data/.gh_token}"
cleanup_legacy_token() { rm -f "$LEGACY_TOKEN_FILE" 2>/dev/null || true; }
cleanup_legacy_token
trap cleanup_legacy_token EXIT INT TERM

# The fallback PAT is delivered as a boot-only secret file, never as an ambient
# service environment variable.
PAT_SECRET_FILE="${GH_PAT_SECRET_FILE:-/run/secrets/friday_pat}"

# ---- one shared completeness predicate ------------------------------------
# Complete means: both IDs are non-empty decimal integers and the private key is
# a cryptographically parseable PEM key. A header-only or otherwise unparsable
# value is incomplete, so it falls back to the PAT instead of failing the mint.
app_config_complete() {
    case "${GH_APP_ID:-}" in
        ''|*[!0-9]*) return 1 ;;
    esac
    case "${GH_APP_INSTALLATION_ID:-}" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ -n "${GH_APP_PRIVATE_KEY:-}" ] || return 1
    # Env vars carry \n escapes; decode before asking openssl to parse the key.
    printf '%s' "$(printf '%s' "$GH_APP_PRIVATE_KEY" | sed 's/\\n/\n/g')" \
        | openssl pkey -noout >/dev/null 2>&1
}

if [ "${1:-}" = "--check-app-config" ]; then
    if app_config_complete; then echo complete; else echo incomplete; fi
    exit 0
fi

# ---- fallback PAT: read the boot-only secret file --------------------------
fallback_pat() {
    # An explicit GH_PAT (scoped to this one invocation by the boot hook) wins;
    # otherwise read the root-only secret file when it is a readable, non-empty
    # regular file. A directory or an empty file counts as "no PAT".
    if [ -n "${GH_PAT:-}" ]; then
        printf '%s' "$GH_PAT"
        return 0
    fi
    if [ -f "$PAT_SECRET_FILE" ] && [ -s "$PAT_SECRET_FILE" ] && [ -r "$PAT_SECRET_FILE" ]; then
        cat "$PAT_SECRET_FILE"
        return 0
    fi
    return 1
}

# ---- auth gh CLI as the hermes runtime user --------------------------------
# The boot hook and the cron scheduler both run as hermes. Pin HOME because the
# root boot hook invokes this through su, which otherwise preserves /root.
# HERMES_HOME is the mounted data root; gh's config lives in its home subdir.
export HOME="${GH_HOME:-/opt/data/home}"
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-$HOME/.config/gh}"

# install_token <token> <login>
# Feeds the credential through a mode-0600 stdin file that is removed on every
# exit path, so no credential file survives the call.
install_token() {
    local token="$1" login="$2" init_tmp

    init_tmp=$(mktemp "${TMPDIR:-/tmp}/.gh-auth-init.XXXXXX")
    trap 'rm -f "$init_tmp"; cleanup_legacy_token' EXIT INT TERM
    printf '%s' "$token" > "$init_tmp"
    chmod 600 "$init_tmp"

    if [ "$(id -u)" = "0" ]; then
        chown hermes:hermes "$init_tmp" 2>/dev/null || true
        su -s /bin/sh hermes -c "HOME=$HOME gh auth login --with-token < $init_tmp && HOME=$HOME gh auth switch --hostname github.com --user '$login'" 2>/dev/null \
            || die "gh auth login or switch failed for hermes"
    else
        HOME=$HOME gh auth login --with-token < "$init_tmp" 2>/dev/null \
            || die "gh auth login failed for $(id -un)"
        gh auth switch --hostname github.com --user "$login" 2>/dev/null \
            || die "gh auth switch failed for $(id -un)"
    fi

    rm -f "$init_tmp"
    trap cleanup_legacy_token EXIT INT TERM
}

# ---- App path --------------------------------------------------------------
if app_config_complete; then
    for cmd in openssl curl python3 gh; do
        command -v "$cmd" >/dev/null || die "$cmd not found in PATH"
    done

    PRIVATE_KEY=$(printf '%s' "$GH_APP_PRIVATE_KEY" | sed 's/\\n/\n/g')

    NOW=$(date +%s)
    EXP=$((NOW + 600))
    b64url() { base64 -w0 | tr '+/' '-_' | tr -d '='; }
    HEADER=$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | b64url)
    PAYLOAD=$(printf '%s' "{\"iat\":$NOW,\"exp\":$EXP,\"iss\":\"$GH_APP_ID\"}" | b64url)
    if ! SIGNATURE=$(printf '%s' "$HEADER.$PAYLOAD" | openssl dgst -sha256 -sign <(printf '%s' "$PRIVATE_KEY") -binary 2>&1 | b64url); then
        die "openssl signing failed — is the private key valid?"
    fi
    JWT="$HEADER.$PAYLOAD.$SIGNATURE"

    # The minted JWT goes on the wire; only log output is redacted, never the request.
    AUTHZ="Authorization: Bearer $JWT"
    APP_SLUG=$(curl -s \
        -H "$AUTHZ" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/app" \
        | python3 -c "import sys,json; print(json.load(sys.stdin).get('slug',''))")
    [ -n "$APP_SLUG" ] || die "GitHub API did not return the App slug"
    case "$APP_SLUG" in
        *[!a-zA-Z0-9_-]*) die "GitHub API returned an invalid App slug" ;;
    esac
    APP_LOGIN="${APP_SLUG}[bot]"

    RESP=$(curl -s -w "\n%{http_code}" -X POST \
        -H "$AUTHZ" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/app/installations/$GH_APP_INSTALLATION_ID/access_tokens")
    unset AUTHZ JWT
    HTTP_CODE=$(printf '%s' "$RESP" | tail -1)
    BODY=$(printf '%s' "$RESP" | sed '$d')

    if [ "$HTTP_CODE" != "201" ]; then
        ERR=$(printf '%s' "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message','unknown'))" 2>/dev/null || echo "unknown")
        die "GitHub API returned HTTP $HTTP_CODE: $ERR"
    fi

    TOKEN=$(printf '%s' "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))") || die "failed to parse token from API response"
    [ -n "$TOKEN" ] || die "API returned empty token"
    EXPIRES_AT=$(printf '%s' "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('expires_at','unknown'))")

    install_token "$TOKEN" "$APP_LOGIN"
    unset TOKEN
    log "App auth complete (token expires $EXPIRES_AT)"
    exit 0
fi

# ---- fallback PAT path -----------------------------------------------------
if PAT=$(fallback_pat); then
    command -v gh >/dev/null || die "gh not found in PATH"
    install_token "$PAT" "${GH_PAT_LOGIN:-darrencjh8}"
    unset PAT
    log "App configuration incomplete — installed the fallback PAT credential"
    exit 0
fi

log "App configuration incomplete and no fallback PAT present — skipping (leaving existing credentials untouched)"
exit 0
