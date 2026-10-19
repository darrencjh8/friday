#!/usr/bin/env bash
# =============================================================================
# Deploy Script — Hermes Agent + Services
# Validates all required environment variables, builds + deploys via Compose.
#
# On GitHub Actions (GITHUB_ACTIONS=true): reads secrets from environment.
# Locally: reads .env files.
#
# Usage: ./modules/deploy.sh --component <name> [--component <name>...] [--non-interactive]
#   --component <name>  Required. One of: all, hermes, portfolio-tracker, expense-tracker, actual-api, image-gen
#   --non-interactive    Skip OneDrive auth prompt
# =============================================================================
set -euo pipefail

NON_INTERACTIVE=false
SKIP_BUILD=false
DOCKER_ARGS=()
COMPONENTS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=true ;;
    --skip-build) SKIP_BUILD=true ;;
    --component) COMPONENTS+=("$2"); shift ;;
    *) DOCKER_ARGS+=("$1") ;;
  esac
  shift
done

if [[ ${#COMPONENTS[@]} -eq 0 ]]; then
  echo "Usage: ./modules/deploy.sh --component <name> [--component <name>...] [--non-interactive]"
  echo ""
  echo "Available components:"
  echo "  all                  Deploy all components"
  echo "  hermes               Hermes agent (MCP, cron, Telegram)"
  echo "  portfolio-tracker    Portfolio tracker + IBKR flex"
  echo "  expense-tracker      Expense tracker"
  echo "  actual-api           Actual Budget API"
  echo "  image-gen            Image generation"
  echo "  codex-router         LiteLLM proxy (ChatGPT/DeepSeek router)"
  echo ""
  echo "Example:"
  echo "  ./modules/deploy.sh --component portfolio-tracker --component hermes --non-interactive"
  echo "  ./modules/deploy.sh --component all"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The readiness budgets the health checks below derive from. The deploy must not
# give up on the router before the container itself is allowed to give up; see
# that file for the two gates it has to cover and why a false failure loops.
# shellcheck source=modules/hermes/scripts/deploy-ready-budget.sh
. "$ROOT/modules/hermes/scripts/deploy-ready-budget.sh"
MODULES_DIR="$ROOT/modules"
PT_DIR="$ROOT/modules/portfolio-tracker"
ET_DIR="$ROOT/modules/expense-tracker"
HERMES_DIR="$ROOT/modules/hermes"
HERMES_ENV="$HERMES_DIR/.env"

# Auto-detect: GitHub Actions uses secrets via environment;
# local dev reads .env files.
GITHUB_MODE=false
[[ "${GITHUB_ACTIONS:-}" == "true" ]] && GITHUB_MODE=true

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

missing=0

env_get() {
  local key="$1" file="$2"
  grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null | head -1 | sed "s/^[[:space:]]*${key}=//" | sed 's/^"//;s/"$//;s/^'"'"'//;s/'"'"'$//'
}

check_var() {
  local name="$1"
  local val
  if $GITHUB_MODE; then
    val="${!name:-}"
  else
    local file="$2"
    val=$(env_get "$name" "$file")
    # Fall back to shell environment
    if [ -z "$val" ]; then
      val="${!name:-}"
    fi
  fi
  if [ -z "$val" ]; then
    echo -e "  ${RED}✗ MISSING: $name${NC}"
    missing=$((missing + 1))
  else
    echo -e "  ${GREEN}✓ $name${NC}"
  fi
}

check_var_optional() {
  local name="$1"
  local val
  if $GITHUB_MODE; then
    val="${!name:-}"
  else
    local file="$2"
    val=$(env_get "$name" "$file")
    # Fall back to shell environment (e.g. exported from secrets manager)
    if [ -z "$val" ]; then
      val="${!name:-}"
    fi
  fi
  if [ -z "$val" ]; then
    echo -e "  ${YELLOW}○ $name (not set)${NC}"
  else
    echo -e "  ${GREEN}✓ $name${NC}"
  fi
}

# True when platforms.slack.enabled is truthy in the seeded Hermes config.
# A missing, unreadable, or unparseable config counts as ENABLED: a required
# token must never be silently skipped because detection failed.
slack_platform_enabled() {
  local config="$HERMES_DIR/config.yaml"
  [ -f "$config" ] && [ -r "$config" ] || return 0

  # A missing interpreter must not read as "Slack disabled".
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi

  local rc=0
  python3 - "$config" <<'PY' || rc=$?
"""Read only platforms.slack.enabled, using the standard library.

The deploy host is not guaranteed to have PyYAML. Importing it and falling back
to "enabled" when the import fails aborts production deployment, so the single
boolean this gate needs is read directly instead of pulling in a YAML package.

Fail-closed contract: only a value that is DEFINITELY false may disable the
gate. Missing, unreadable, non-UTF8, malformed, empty, unrecognised, or
ambiguous input always resolves to enabled, because the caller treats "enabled"
as "require the tokens". Every exception is caught for the same reason.
"""
import re
import sys

# Key lines only; deliberately does not match "- item" or continuation text.
KEY_RE = re.compile(r"^([ \t]*)([A-Za-z0-9_.-]+):[ \t]*(.*)$")
# Like KEY_RE but also accepts a quoted key, so a block scalar under `"prompt":`
# is recognised and its body masked out.
MASK_KEY_RE = re.compile(
    r"""^([ \t]*)(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+):[ \t]*(.*)$"""
)
QUOTES = "\"'"
FALSEY = ("false", "no", "off", "0")


class Quoted(str):
    """A scalar written in quotes: always a string, never a YAML boolean."""


# Typed tokens, so stripped quotes can never be confused with YAML null.
MISSING = object()  # no usable scalar (empty / comment / nested block)
NULL = object()  # YAML null: null, Null, NULL, ~

# Result codes for the line walk.
FOUND = "found"
ABSENT = "absent"  # no definite answer yet; keep scanning
AMBIGUOUS = "ambiguous"


def scalar(raw):
    """Return MISSING, NULL, a Quoted string, or a bare token.

    Quote handling precedes comment stripping: `"false # x"` is the truthy
    string `false # x`, not the value `false` plus a comment.
    """
    raw = raw.strip()
    if not raw:
        return MISSING
    if raw[0] in QUOTES:
        end = raw.find(raw[0], 1)
        return Quoted(raw[1:] if end < 0 else raw[1:end])
    raw = raw.split(" #", 1)[0].split("\t#", 1)[0].strip()
    if not raw or raw.startswith("#"):
        return MISSING
    if raw.lower() in ("null", "~"):
        return NULL
    return raw


def normalized(value):
    """Map a parsed value to True (enabled/require) or False (disabled)."""
    if value is MISSING or value is NULL:
        return True
    if isinstance(value, Quoted):
        return str(value).strip().lower() not in FALSEY
    if isinstance(value, str):
        return str(value).strip().lower() not in FALSEY
    return bool(value)


def value_end(text, start):
    """Index just past the value beginning at `start` (flow-aware)."""
    i = start
    level = 0
    n = len(text)
    while i < n:
        char = text[i]
        if char in QUOTES:
            i += 1
            while i < n and text[i] != char:
                i += 1
            i += 1
            continue
        if char in "[{":
            level += 1
        elif char in "]}":
            if level == 0:
                break
            level -= 1
        elif char == "," and level == 0:
            break
        i += 1
    return i


def flow_value(text, key, depth):
    """Value text of `key` at `depth` in a flow mapping, or None.

    Only a sibling at `depth` matches, so a `slack` key nested deeper (for
    example `platforms.webhook.routes.slack`) is ignored.
    """
    i = 0
    level = 0
    n = len(text)
    while i < n:
        char = text[i]
        if char in "[{":
            level += 1
            i += 1
            continue
        if char in "]}":
            level -= 1
            i += 1
            continue
        if char in QUOTES:
            i += 1
            while i < n and text[i] != char:
                i += 1
            i += 1
            continue
        if level == depth:
            match = re.match(r"([A-Za-z0-9_.-]+)\s*:", text[i:])
            if match:
                if match.group(1) != key:
                    # Skip this entry's value and continue with the next key.
                    i = value_end(text, i + match.end()) + 1
                    continue
                start = i + match.end()
                return text[start:value_end(text, start)].strip()
        i += 1
    return None


def flow_key_seen(text, key, depth):
    """Count occurrences of `key` at `depth` in a flow mapping."""
    count = 0
    i = 0
    level = 0
    n = len(text)
    while i < n:
        char = text[i]
        if char in "[{":
            level += 1
            i += 1
            continue
        if char in "]}":
            level -= 1
            i += 1
            continue
        if char in QUOTES:
            i += 1
            while i < n and text[i] != char:
                i += 1
            i += 1
            continue
        if level == depth:
            match = re.match(r"([A-Za-z0-9_.-]+)\s*:", text[i:])
            if match:
                if match.group(1) == key:
                    count += 1
                i = value_end(text, i + match.end()) + 1
                continue
        i += 1
    return count


def flow_enabled(raw):
    """Handle `platforms: {slack: {enabled: true}}` on one line."""
    inner = raw.strip()
    if inner.startswith("{") and inner.endswith("}"):
        inner = inner[1:-1]
    # Duplicate keys in a flow mapping are as ambiguous as in block style.
    if flow_key_seen(inner, "slack", 0) > 1:
        return True
    slack_value = flow_value(inner, "slack", 0)
    if slack_value is None or not slack_value.startswith("{"):
        return True
    slack_inner = slack_value[1:-1]
    if flow_key_seen(slack_inner, "enabled", 0) > 1:
        return True
    enabled_value = flow_value(slack_inner, "enabled", 0)
    if enabled_value is None:
        return True
    return normalized(scalar(enabled_value))


def quote_closes(line, quote):
    """True when `line` contains the quote character that ends an open scalar.

    Backslash escapes count only in double-quoted scalars, and a doubled single
    quote is an escaped apostrophe rather than a terminator.
    """
    i = 0
    n = len(line)
    while i < n:
        char = line[i]
        if quote == '"' and char == "\\":
            i += 2
            continue
        if char == quote:
            if quote == "'" and i + 1 < n and line[i + 1] == "'":
                i += 2
                continue
            return True
        i += 1
    return False


def mask_opaque(text):
    """Blank out region types whose body text is not configuration.

    Removes comments, literal/folded block scalars (the webhook route prompt is
    one, and deliberately precedes the `slack` block), and multi-line quoted
    scalars, so their contents can never be mistaken for keys. Non-UTF8 bytes
    are replaced rather than rejected, so surrounding keys are still read.
    """
    out = []
    block_indent = None
    quote = None
    for line in text.splitlines():
        stripped = line.lstrip()
        if block_indent is not None:
            if line.strip() and len(line) - len(stripped) > block_indent:
                out.append("")
                continue
            block_indent = None
        if quote is not None:
            if quote_closes(line, quote):
                quote = None
            out.append("")
            continue
        if not stripped or stripped.startswith("#"):
            out.append("")
            continue

        # The scalar value is everything after the first key colon. A
        # multi-line quote can only open there, so an apostrophe or a `" #"`
        # inside a plain or double-quoted value cannot start one.
        key_match = MASK_KEY_RE.match(line)
        value = "" if key_match is None else key_match.group(2).strip()
        for ch in QUOTES:
            if value.startswith(ch) and value.count(ch) % 2 == 1:
                quote = ch
                break
        if key_match is not None and value[:1] in ("|", ">"):
            block_indent = len(key_match.group(1))
        out.append(line)
    return "\n".join(out)


def duplicate_top_level_key(text, name):
    """True when `name` occurs more than once as a top-level mapping key.

    Duplicate keys are invalid YAML and parsers disagree on which one wins, so
    the gate must not pick either. Called on masked text, so prompt bodies
    cannot contribute a phantom key.
    """
    seen = 0
    for line in text.splitlines():
        if not line.strip():
            continue
        match = KEY_RE.match(line)
        if not match:
            continue
        indent, key = match.group(1), match.group(2)
        if "\t" in indent or len(indent) != 0:
            continue
        if key == name:
            seen += 1
            if seen > 1:
                return True
    return False


def scan_lines(text):
    """Walk the masked text once and return (state, value).

    Nothing is decided until the whole document has been read, because a
    duplicate `slack` or `enabled` key appearing later makes an earlier one
    untrustworthy.
    """
    count_platforms = 0
    count_slack = 0
    count_enabled = 0
    enabled = MISSING
    platforms_indent = None
    platforms_child_indent = None
    slack_indent = None
    child_indent = None

    for line in text.splitlines():
        match = KEY_RE.match(line)
        if not match:
            continue
        indent, key, raw = match.group(1), match.group(2), match.group(3)

        # Only space indentation can start a YAML block mapping.
        if "\t" in indent:
            continue
        width = len(indent)
        value = raw.strip()

        # A top-level key ends whatever block was open beneath it.
        if width == 0:
            if key == "platforms":
                count_platforms += 1
                platforms_indent = width
                platforms_child_indent = None
                slack_indent = None
                if value.startswith("{"):
                    enabled = flow_enabled(value)
                    count_enabled += 1
                continue
            platforms_indent = None
            slack_indent = None
            continue

        if platforms_indent is None:
            continue

        # Leaving the slack block must still allow a second `slack` sibling to
        # be seen (a duplicate key), so this does not `continue`.
        if slack_indent is not None and width <= slack_indent:
            slack_indent = None

        if width <= platforms_indent:
            continue

        # `slack` is the platform only as a direct child of `platforms`.
        if slack_indent is None:
            if platforms_child_indent is None:
                platforms_child_indent = width
            if width == platforms_child_indent and key == "slack":
                count_slack += 1
                slack_indent = width
                child_indent = None
                if value.startswith("{"):
                    enabled = flow_enabled(value)
                    count_enabled += 1
            continue

        # `enabled` is the flag only as a direct child of `slack`.
        if child_indent is None:
            child_indent = width
        if width == child_indent and key == "enabled":
            count_enabled += 1
            enabled = normalized(scalar(raw))

    # Any duplicate along the path makes the document ambiguous.
    if count_platforms > 1 or count_slack > 1 or count_enabled > 1:
        return AMBIGUOUS, None
    if count_enabled == 0:
        return ABSENT, None
    return FOUND, enabled


def main(path):
    # errors="replace" so a stray non-UTF8 byte cannot abort the gate.
    with open(path, encoding="utf-8", errors="replace") as handle:
        text = handle.read()
    masked = mask_opaque(text)
    # Ambiguous documents are never trusted to disable the gate.
    if duplicate_top_level_key(masked, "platforms"):
        return True
    state, value = scan_lines(masked)
    if state == FOUND:
        return bool(value)
    # ABSENT (no flag) and AMBIGUOUS (duplicate keys) both mean "enabled".
    return True


try:
    result = main(sys.argv[1])
except Exception:
    # Any unexpected failure must fail CLOSED (require tokens), never open.
    result = True

sys.exit(0 if result else 1)
PY

  # The probe only ever exits 0 (enabled/require) or 1 (disabled/skip). Any
  # other code means the interpreter failed, which must fail closed.
  if [ "$rc" -eq 1 ]; then
    return 1
  fi
  return 0
}

check_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    echo -e "  ${RED}✗ FILE NOT FOUND: $path${NC}"
    missing=$((missing + 1))
    return 1
  fi
  return 0
}

# Check if a component should be deployed
should_deploy() {
  for c in "${COMPONENTS[@]}"; do
    [[ "$c" == "all" || "$c" == "$1" ]] && return 0
  done
  return 1
}

echo "========================================"
echo " Environment Validation"
echo "========================================"

# ---- Hermes ----

if should_deploy "hermes" || should_deploy "all"; then
echo ""
echo "--- Hermes (.env) ---"
if $GITHUB_MODE || check_file "$HERMES_ENV"; then
  # LLM
  echo "  [LLM Providers]"
  check_var "DEEPSEEK_API_KEY" "$HERMES_ENV"
  check_var "GEMINI_API_KEY" "$HERMES_ENV"

  # Telegram
  echo "  [Telegram]"
  check_var "TELEGRAM_BOT_TOKEN" "$HERMES_ENV"
  check_var "TELEGRAM_ALLOWED_USERS" "$HERMES_ENV"
  check_var "TELEGRAM_HOME_CHANNEL" "$HERMES_ENV"

  # Slack (Socket Mode). Validated only while platforms.slack.enabled is true,
  # so the wiring could merge before the Slack app existed. The allowlist is a
  # hard requirement: free response makes it the only authorization gate, and an
  # empty one yields a bot that connects but answers nobody.
  if slack_platform_enabled; then
    echo "  [Slack]"
    check_var "SLACK_BOT_TOKEN" "$HERMES_ENV"
    check_var "SLACK_APP_TOKEN" "$HERMES_ENV"
    check_var "SLACK_ALLOWED_USERS" "$HERMES_ENV"
    check_var_optional "SLACK_HOME_CHANNEL" "$HERMES_ENV"
    check_var_optional "SLACK_HOME_CHANNEL_NAME" "$HERMES_ENV"
  else
    echo "  [Slack] disabled in config.yaml — skipping token validation"
  fi

  # Webhook
  echo "  [Webhook]"
  check_var "HERMES_WEBHOOK_SECRET" "$HERMES_ENV"

  # GitHub App
  echo "  [GitHub App]"
  check_var "MEMORY_REPO_URL" "$HERMES_ENV"
  check_var "GH_APP_ID" "$HERMES_ENV"
  check_var "GH_APP_INSTALLATION_ID" "$HERMES_ENV"
  check_var "GH_APP_PRIVATE_KEY" "$HERMES_ENV"

  # Persona
  echo "  [Persona]"
  check_var "IDENTITY_NAME" "$HERMES_ENV"
  check_var "IDENTITY_EMOJI" "$HERMES_ENV"
  check_var "IDENTITY_VIBE" "$HERMES_ENV"
  check_var "SOUL_VOICE_TONE" "$HERMES_ENV"
  check_var "SOUL_VOICE_STYLE" "$HERMES_ENV"
  check_var "SOUL_VOICE_RULES" "$HERMES_ENV"
  check_var "SOUL_DELEGATION" "$HERMES_ENV"

  # Dashboard (basic auth, LAN-only; gate fails closed without a provider)
  echo "  [Dashboard]"
  check_var "HERMES_DASHBOARD_BASIC_AUTH_USERNAME" "$HERMES_ENV"
  check_var "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD" "$HERMES_ENV"

  # Optional
  echo "  [Optional]"
  check_var_optional "FRIDAY_PAT" "$HERMES_ENV"
  check_var_optional "BRAVE_SEARCH_API_KEY" "$HERMES_ENV"
  check_var_optional "FIRECRAWL_API_KEY" "$HERMES_ENV"
  check_var_optional "NOTION_API_KEY" "$HERMES_ENV"
  check_var_optional "OPENCODE_SERVER_PASSWORD" "$HERMES_ENV"
  check_var_optional "BWS_ACCESS_TOKEN" "$HERMES_ENV"
  check_var_optional "BWS_PROJECT" "$HERMES_ENV"
  check_var_optional "JEV_API_KEY" "$HERMES_ENV"
fi
fi

# ---- portfolio-tracker ----

if should_deploy "portfolio-tracker" || should_deploy "all"; then
echo ""
echo "--- Portfolio Tracker (.env) ---"
PT_ENV="$PT_DIR/.env"
if $GITHUB_MODE || check_file "$PT_ENV"; then
  for v in DEEPSEEK_API_KEY ACTUAL_BUDGET_URL ACTUAL_BUDGET_PASSWORD \
           ACTUAL_PRIMARY_BUDGET_FILE ACTUAL_SECONDARY_BUDGET_FILE \
           ONEDRIVE_CLIENT_ID \
           IBKR_FLEX_TOKEN IBKR_FLEX_QUERY_ID \
           IBKR_PP_SGD_ACCOUNT IBKR_PP_USD_ACCOUNT \
           GOOGLE_SERVICE_ACCOUNT_JSON GOOGLE_SHEET_ID \
           TAXONOMY_SHEET_MAPPING TAXONOMY_NAMES PP_OFFSET_MAP; do
    check_var "$v" "$PT_ENV"
  done
  # Validate service account JSON exists
  if $GITHUB_MODE; then
    sa_json="${GOOGLE_SERVICE_ACCOUNT_JSON:-}"
  else
    sa_json=$(env_get "GOOGLE_SERVICE_ACCOUNT_JSON" "$PT_ENV")
  fi
  if [ -n "$sa_json" ]; then
    sa_host_path="/home/runner/data/portfolio-tracker/google-service-account.json"
    # In GitHub mode, write the secret to the file so Docker can mount it
    if $GITHUB_MODE; then
      mkdir -p "$(dirname "$sa_host_path")"
      echo "$sa_json" > "$sa_host_path"
      chmod 600 "$sa_host_path"
      echo -e "  ${GREEN}✓ google-service-account.json (from secret)${NC}"
    elif [ -f "$sa_host_path" ]; then
      echo -e "  ${GREEN}✓ google-service-account.json${NC}"
    else
      echo -e "  ${RED}✗ google-service-account.json NOT FOUND at $sa_host_path${NC}"
      missing=$((missing + 1))
    fi
  fi
fi
fi

# ---- expense-tracker ----

if should_deploy "expense-tracker" || should_deploy "all"; then
echo ""
echo "--- Expense Tracker (.env) ---"
ET_ENV="$ET_DIR/.env"
if $GITHUB_MODE || check_file "$ET_ENV"; then
  # DEEPSEEK_API_KEY is only required for the final fallback when LiteLLM is primary.
  if $GITHUB_MODE; then
    et_llm_provider="${LLM_PROVIDER:-litellm}"
  else
    et_llm_provider=$(env_get "LLM_PROVIDER" "$ET_ENV")
    [ -z "$et_llm_provider" ] && et_llm_provider="litellm"
  fi
  if [ "$et_llm_provider" = "deepseek" ]; then
    check_var "DEEPSEEK_API_KEY" "$ET_ENV"
  else
    check_var_optional "DEEPSEEK_API_KEY" "$ET_ENV"
  fi
  for v in ACTUAL_BUDGET_URL ACTUAL_BUDGET_PASSWORD \
           ACTUAL_PRIMARY_BUDGET_FILE ACTUAL_SECONDARY_BUDGET_FILE \
           ACTUAL_PRIMARY_CURRENCY ACTUAL_SECONDARY_CURRENCY \
           NOTIFY_URL HERMES_WEBHOOK_SECRET \
           IMAP_HOST IMAP_USERNAME IMAP_PASSWORD; do
    check_var "$v" "$ET_ENV"
  done
  echo "  [Optional]"
  check_var_optional "BRAVE_SEARCH_API_KEY" "$ET_ENV"
  check_var_optional "JEV_API_KEY" "$ET_ENV"
  check_var_optional "FIRECRAWL_API_KEY" "$ET_ENV"
  check_var_optional "LLM_PROVIDER" "$ET_ENV"
  check_var_optional "LLM_BASE_URL" "$ET_ENV"
  check_var_optional "LLM_MODEL" "$ET_ENV"
  check_var_optional "LLM_API_KEY" "$ET_ENV"
  check_var_optional "LLM_REASONING_EFFORT" "$ET_ENV"
  check_var_optional "LLM_FALLBACK_MODEL" "$ET_ENV"
  check_var_optional "LLM_FINAL_FALLBACK_PROVIDER" "$ET_ENV"
  check_var_optional "LLM_FINAL_FALLBACK_MODEL" "$ET_ENV"
fi
fi

# ---- actual-api (uses portfolio-tracker .env for budget credentials) ----

if should_deploy "actual-api" || should_deploy "all"; then
echo ""
echo "--- actual-api (.env) ---"
PT_ENV="$PT_DIR/.env"
if $GITHUB_MODE || check_file "$PT_ENV"; then
  for v in ACTUAL_BUDGET_PASSWORD ACTUAL_PRIMARY_BUDGET_FILE ACTUAL_BUDGET_URL; do
    check_var "$v" "$PT_ENV"
  done
elif ! $GITHUB_MODE; then
  echo -e "  ${YELLOW}(portfolio-tracker/.env not found — cannot validate actual-api vars)${NC}"
fi
fi

# ---- codex-router ----

# A colour name is an internal detail of the router, not a component. Accept it
# and deploy the router, rather than building an image for a component that
# should_deploy then refuses and nothing ever starts. This runs before the
# preflight below, which is keyed on the component: rewriting it afterwards let
# `--component codex-router-a` through with the router's required secrets unset.
for i in "${!COMPONENTS[@]}"; do
  case "${COMPONENTS[$i]}" in
    codex-router-a|codex-router-b) COMPONENTS[$i]="codex-router" ;;
  esac
done

if should_deploy "codex-router" || should_deploy "all"; then
echo ""
echo "--- Codex Router ---"
  check_var "CODEX_ROUTER_AUTH_PASSWORD" ""
  echo "  [LLM Provider]"
  check_var_optional "LLM_PROVIDER" ""
  check_var_optional "LLM_BASE_URL" ""
  check_var_optional "LLM_MODEL" ""
  check_var_optional "LLM_API_KEY" ""
  check_var_optional "LLM_REASONING_EFFORT" ""
  check_var_optional "LLM_FALLBACK_MODEL" ""
  check_var_optional "LLM_FINAL_FALLBACK_PROVIDER" ""
  check_var_optional "LLM_FINAL_FALLBACK_MODEL" ""
  echo "  [External Providers]"
  # Optional, like the ClinePass lane below: discovery skips the meta/ lane
  # while this key is absent, so an unset value simply leaves those models
  # unpublished.
  check_var_optional "MODEL_API_KEY" ""
  check_var_optional "OPENCODE_GO_API_KEY" ""
  check_var_optional "OPENCODE_ZEN_API_KEY" ""
  check_var_optional "OPENCODE_API_KEY" ""
  check_var_optional "CLINE_API_KEY" ""
  check_var_optional "CODEX_ROUTER_OPENCODE_ZEN_MODELS" ""
fi

# ---- pluggable modules (auto-discover from modules/*/module.env) ----

echo ""
echo "--- Pluggable Modules ---"
MODULE_COUNT=0
for mod_env in "$ROOT"/modules/*/module.env; do
  [ -f "$mod_env" ] || continue
  # The deploy checkout runs with clean: false, so a module directory removed
  # from the repository (the retired ktmb-booking submodule) lingers in the
  # runner workspace and would keep demanding secrets nobody sets. Validate only
  # modules this revision tracks.
  if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 \
    && ! git -C "$ROOT" ls-files --error-unmatch "${mod_env#"$ROOT"/}" >/dev/null 2>&1; then
    continue
  fi
  source "$mod_env"
  MODULE_COUNT=$((MODULE_COUNT + 1))
  mod_dir="$(dirname "$mod_env")"
  echo -e "  ${GREEN}✓ Found: ${MODULE_NAME:-unknown} ($mod_dir)${NC}"
  if $GITHUB_MODE; then
    for v in "${MODULE_REQUIRED_VARS[@]}"; do
      check_var "$v" ""
    done
  else
    mod_env_file="${mod_dir}/${MODULE_ENV_FILE:-.env}"
    if [ -f "$mod_env_file" ]; then
      for v in "${MODULE_REQUIRED_VARS[@]}"; do
        check_var "$v" "$mod_env_file"
      done
    else
      echo -e "  ${RED}✗ Module .env not found at $mod_env_file${NC}"
      missing=$((missing + 1))
    fi
  fi
done
if [ "$MODULE_COUNT" -eq 0 ]; then
  echo "  (none — no modules/*/module.env found)"
fi

# ---- result ----

echo ""
echo "========================================"
if [ "$missing" -gt 0 ]; then
  echo -e "  ${RED}$missing variable(s) missing or empty.${NC}"
  if $GITHUB_MODE; then
    echo "  Ensure all required secrets are set in GitHub → Settings → Secrets."
  else
    echo "  Fill them in the corresponding .env files and re-run."
  fi
  echo "========================================"
  exit 1
fi

echo -e "  ${GREEN}All required variables present.${NC}"
echo "========================================"
echo ""

# ---- onedrive ----

if should_deploy "portfolio-tracker"; then

ONEDRIVE_CONF_DIR="$ROOT/modules/onedrive-sync/config/onedrive"
ONEDRIVE_TOKEN="$ONEDRIVE_CONF_DIR/refresh_token"

if [ "$NON_INTERACTIVE" != true ] && [ ! -f "$ONEDRIVE_TOKEN" ]; then
  echo ""
  echo "----------------------------------------"
  echo " OneDrive Auth Setup"
  echo "----------------------------------------"
  echo ""
  echo "OneDrive authorization is required to sync the Portfolio file."
  echo ""

  cd "$ROOT/modules/onedrive-sync"
  mkdir -p "$ONEDRIVE_CONF_DIR"

  # Construct the Microsoft OAuth URL
  ONEDRIVE_CLIENT_ID=$(env_get ONEDRIVE_CLIENT_ID "$PT_ENV")
  AUTH_URL="https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${ONEDRIVE_CLIENT_ID}&scope=Files.ReadWrite%20Files.ReadWrite.All%20Sites.ReadWrite.All%20offline_access&response_type=code&prompt=login&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient"

  echo "Open this URL in your browser, log in, and after the redirect to a blank"
  echo "page, paste the ENTIRE URL from the address bar back here:"
  echo ""
  echo "$AUTH_URL"
  echo ""
  echo -n "Paste redirect URI: "
  read -r REDIRECT_URI

  if [ -z "$REDIRECT_URI" ]; then
    echo "✗ No redirect URI provided. Skipping OneDrive setup."
  else
    # Feed the redirect URI to complete OAuth and sync
    echo "$REDIRECT_URI" | docker run --rm -i \
      -v "$ONEDRIVE_CONF_DIR:/onedrive/conf" \
      -v gateway_onedrive_data:/onedrive/data \
      driveone/onedrive:latest --sync --verbose --confdir /onedrive/conf --syncdir /onedrive/data 2>&1

    if [ -f "$ONEDRIVE_TOKEN" ]; then
      echo -e "  ${GREEN}✓ OneDrive authorized and synced. Token saved.${NC}"
    else
      echo -e "  ${RED}✗ OneDrive authorization may have failed. Token not found.${NC}"
      echo "  You can rerun deploy.sh to retry, or skip for now."
    fi
  fi
  echo ""
fi
fi  # should_deploy portfolio-tracker

# ---- hermes workspace ----

if should_deploy "hermes" || should_deploy "all"; then
  # Hermes workspace: use HERMES_WORKSPACE env var if set (GitHub mode),
  # otherwise default to $HOME/workspace/hermes (local dev).
  if [ -n "${HERMES_WORKSPACE:-}" ]; then
    HERMES_WS="$HERMES_WORKSPACE"
  else
    HERMES_WS="$HOME/workspace/hermes"
  fi
  mkdir -p "$HERMES_WS"
  if [ "$(stat -c '%u' "$HERMES_WS" 2>/dev/null)" != "10000" ]; then
    echo ""
    echo "--- Hermes Workspace ---"
    echo "  Setting ownership of $HERMES_WS to UID 10000 (hermes user)..."
    sudo chown 10000:10000 "$HERMES_WS"
    echo -e "  ${GREEN}✓ hermes workspace ready${NC}"
  fi
fi

# ---- pull latest code ----

if ! $SKIP_BUILD; then

echo ""
echo "--- Git Pull ---"
cd "$ROOT"
git stash push -m "auto-deploy-stash-$(date +%s)" 2>/dev/null || true

# Configure private repository access
if [ -n "${SUBMODULE_PAT:-}" ]; then
  git config --local url."https://x-access-token:${SUBMODULE_PAT}@github.com/".insteadOf "https://github.com/"
fi

if git pull; then
  echo -e "  ${GREEN}✓ code updated${NC}"
else
  echo -e "  ${RED}✗ git pull failed${NC}"
fi
git stash drop 2>/dev/null || true
fi  # SKIP_BUILD

# ---- deploy ----

cd "$MODULES_DIR"

echo ""
echo "--- Building & Deploying ---"

# Ensure shared network exists (idempotent — hermes and codex-router join it)
docker network create hermes_shared --driver bridge 2>/dev/null || true

export COMPOSE_DOCKER_CLI_BUILD=1 DOCKER_BUILDKIT=1

# ---- scoped fallback PAT secret ----
# The Hermes service must not receive FRIDAY_PAT as an ambient environment
# variable: gh gives an ambient token precedence over the stored App credential.
# It is delivered instead as a root-only 0400 file bind-mounted read-only into
# the container, and the file is materialized before any compose config/up call.
# The deploy user cannot write $SECRET_DIR (it belongs to the container's hermes
# uid 10000) and the self-hosted runner has no passwordless sudo, so a one-shot
# root container writes the file. The PAT reaches that container on stdin only:
# never in argv, never in the environment, and never in the build log. The
# hermes container runs as root and reads the 0400 file through the mount.
# The path must always stay a regular file: Docker materializes a bind mount
# whose source is missing as a directory, which would then break the rotation
# from empty back to a set PAT.
SECRET_FILE="/home/runner/data/hermes/friday_pat.secret"
SECRET_DIR="$(dirname "$SECRET_FILE")"
printf '%s' "${FRIDAY_PAT:-}" | docker run --rm -i --network none \
  -v "$SECRET_DIR:/secrets" \
  alpine:3 sh -c '
    umask 077
    if [ -d /secrets/friday_pat.secret ]; then
      rmdir /secrets/friday_pat.secret 2>/dev/null || rm -rf /secrets/friday_pat.secret
    fi
    tmp="$(mktemp /secrets/.friday_pat.XXXXXX)"
    cat > "$tmp"
    chmod 0400 "$tmp"
    mv -f "$tmp" /secrets/friday_pat.secret
  '

COMPOSE="docker-compose --project-name modules"

if [[ " ${COMPONENTS[*]} " =~ " all " ]] || [[ ${#COMPONENTS[@]} -eq 1 && "${COMPONENTS[0]}" == "all" ]]; then
  # Always resolve the full service list — never leave TARGETS empty.
  # An empty TARGETS causes docker compose to silently ignore --force-recreate
  # and only touch services with changed images/configs.
  TARGETS=$($COMPOSE config --services | tr '\n' ' ')
else
  TARGETS="${COMPONENTS[*]}"
fi

# codex-router is one service to callers and three containers underneath: the
# caddy front `codex-router` plus the two router colours `codex-router-a` and
# `codex-router-b`. The generic lists below are split by token so that a build
# compiles the colours (never the front, which is a stock caddy image the build
# has nothing to add to) and `up` leaves all three to the rolling update.
# Both lists are derived per token rather than by matching the whole line:
# TARGETS is one space-separated line, so a line-anchored match finds nothing.
# A TARGETS that names the front and a colour already (every `all` deploy does)
# would otherwise repeat that colour, because the front expands to both; awk
# drops the repeats and keeps the order.
# shellcheck disable=SC2086  # the loop splits TARGETS on purpose
BUILD_TARGETS=$(for TARGET in $TARGETS; do
  case "$TARGET" in
    codex-router) printf 'codex-router-a\ncodex-router-b\n' ;;
    *) printf '%s\n' "$TARGET" ;;
  esac
done | awk '!seen[$0]++' | tr '\n' ' ')
# shellcheck disable=SC2086  # the loop splits TARGETS on purpose
UP_TARGETS=$(for TARGET in $TARGETS; do
  case "$TARGET" in
    codex-router|codex-router-a|codex-router-b) ;;
    *) printf '%s\n' "$TARGET" ;;
  esac
done | awk '!seen[$0]++' | tr '\n' ' ')

# Validate the compose config before stopping or rebuilding anything: a bad
# config used to take the stack down first and only fail at `up`.
$COMPOSE config -q >/dev/null

# Build (skip if --skip-build)
if ! $SKIP_BUILD; then
  echo "  Building $BUILD_TARGETS..."
  # A component list naming only the front has nothing to build; a bare
  # `$COMPOSE build` would build every service in the file instead.
  if [ -n "$BUILD_TARGETS" ]; then
    $COMPOSE build $BUILD_TARGETS
  fi
fi

# Deploy
FORCE_RECREATE="${FORCE_ALL:-false}"
if [[ " ${COMPONENTS[*]} " =~ " all " ]]; then
  # `|| true` rather than `; true`: under `set -e` a command followed by `; true`
  # still ends the script before the guard runs. Both stops are best-effort —
  # the gateway and kokoro-tts containers come from other projects and are absent
  # on some hosts, which aborted three deploys before `compose up` ran.
  docker ps -q --filter name=gateway | xargs -r docker stop 2>/dev/null || true
  docker stop hermes modules-portfolio-tracker-1 modules-expense-tracker-1 modules-actual-api-1 kokoro-tts 2>/dev/null || true
  # The containers stopped above must be recreated, not merely started: compose
  # can still report a container it has just seen stopped as `Running`, skip
  # starting it, and fail hermes with `dependency failed to start ... exited
  # (137)`. Recreating does not depend on that state.
  FORCE_RECREATE=true
fi

# --remove-orphans retires the container of a service this revision deleted.
# Without it, `up` leaves the old container running forever: compose only ever
# adds and updates services, it never sweeps one that left the file.
# The codex-router front and colours are excluded from UP_TARGETS: the rolling
# update below brings them up in the order that keeps 4100 served. When only
# they are left, skip the generic `up` entirely — `up -d` with no service
# argument reconciles the whole project, which is not what a router deploy is
# asking for.
if [ -n "$UP_TARGETS" ]; then
    if [ "$FORCE_RECREATE" = "true" ]; then
        $COMPOSE up -d --remove-orphans --force-recreate $UP_TARGETS
    else
        $COMPOSE up -d --remove-orphans $UP_TARGETS
    fi
fi

# ---- health checks ----

echo ""
echo "--- Health Checks ---"

health_ok() {
  local name="$1" url="$2" max_attempts="${3:-10}"
  local code attempt=0
  # Give the container a moment to bind the port
  sleep 2
  while [ "$attempt" -lt "$max_attempts" ]; do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null)
    [ -z "$code" ] && code="000"
    if [[ "$code" =~ ^[23][0-9][0-9]$ ]]; then
      echo -e "  ${GREEN}✓ $name${NC}"
      return 0
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -lt "$max_attempts" ] && sleep "$HEALTH_RETRY_SLEEP"
  done
  echo -e "  ${RED}✗ $name (HTTP $code)${NC}"
  return 1
}

failed=0

# ---- codex-router skill payload ----
# codex-router owns the skills it publishes (dev-loop, code-reviewer, ...). The
# deploy.yml checkout always provides modules/codex-router, so stage its
# canonical tree onto the Hermes volume and reconcile every runtime skill root
# on any deploy that touches either side. The same script runs at boot
# (50-seed-defaults), so a restart cannot resurrect a stale copy.
if should_deploy "codex-router" || should_deploy "hermes"; then
  SKILLS_SRC="$ROOT/modules/codex-router/codex/skills"
  SKILLS_SYNC="$ROOT/modules/hermes/scripts/sync-codex-router-skills.sh"
  # In CI the codex-router checkout and this script are asserted to exist, so a
  # missing one is a hard failure rather than a green deploy with stale skills.
  if [ ! -d "$SKILLS_SRC" ]; then
    echo "  (codex-router skills not checked out; skipping skill sync)" >&2
    [ -n "${GITHUB_ACTIONS:-}" ] && failed=$((failed + 1))
  elif [ ! -f "$SKILLS_SYNC" ]; then
    echo "  (skill reconciler missing; skipping skill sync)" >&2
    [ -n "${GITHUB_ACTIONS:-}" ] && failed=$((failed + 1))
  elif ! docker inspect hermes >/dev/null 2>&1; then
    echo "  (hermes container not present; skipping skill sync)" >&2
    [ -n "${GITHUB_ACTIONS:-}" ] && failed=$((failed + 1))
  else
    ready=false
    for _ in $(seq 1 15); do
      if docker exec hermes true 2>/dev/null; then ready=true; break; fi
      sleep 2
    done
    echo ""
    echo "--- Codex Router Skills ---"
    sync_ok=false
    if [ "$ready" = true ]; then
      docker exec hermes rm -rf /opt/data/.codex-router-skills.new 2>/dev/null || true
      # The reconciler owns the staged swap and the reconcile under one lock, so
      # the boot hook and this run can never race on the same tree.
      if docker cp "$SKILLS_SRC/." hermes:/opt/data/.codex-router-skills.new \
          && docker cp "$SKILLS_SYNC" hermes:/tmp/sync-codex-router-skills.sh \
          && docker exec hermes sh /tmp/sync-codex-router-skills.sh /opt/data/.codex-router-skills /opt/data/.codex-router-skills.new; then
        sync_ok=true
      fi
      # Always clear the staged copies, including after a failure that left the
      # tmp script or an unconsumed staging tree behind.
      docker exec hermes rm -f /tmp/sync-codex-router-skills.sh 2>/dev/null || true
      docker exec hermes rm -rf /opt/data/.codex-router-skills.new 2>/dev/null || true
    fi
    if [ "$sync_ok" = true ]; then
      echo -e "  ${GREEN}✓ codex-router skills reconciled into the Hermes roots${NC}"
    else
      echo -e "  ${RED}✗ codex-router skill sync failed${NC}"
      failed=$((failed + 1))
    fi
  fi
fi

# ---- Hermes container codex-router checkout ----
# Dev-loop sessions in the container drive the gate from the container's own
# codex-router checkout (`codex/skills/dev-loop/scripts/loop.py`), so the skill
# roots alone do not change which driver runs: the checkout has to advance too.
# Measured 2026-09-25: the reconciled roots were current while
# /workspace/codex-router sat six commits behind origin/main, so the deployed
# driver never reached a session. Two arms are enough here: should_deploy returns 0
# as soon as any component is `all`, so a full deploy reaches this block as well.
if should_deploy "codex-router" || should_deploy "hermes"; then
  CHECKOUT_SCRIPT="$ROOT/modules/hermes/scripts/refresh-codex-router-checkout.sh"
  if [ ! -d "$ROOT/modules/codex-router" ]; then
    echo "  (codex-router checkout not present; skipping container checkout refresh)" >&2
    [ -n "${GITHUB_ACTIONS:-}" ] && failed=$((failed + 1))
  elif [ ! -f "$CHECKOUT_SCRIPT" ]; then
    echo "  (checkout refresh script missing; skipping container checkout refresh)" >&2
    [ -n "${GITHUB_ACTIONS:-}" ] && failed=$((failed + 1))
  elif ! docker inspect hermes >/dev/null 2>&1; then
    echo "  (hermes container not present; skipping container checkout refresh)"
  else
    CHECKOUT_READY=false
    for _ in $(seq 1 15); do
      if docker exec hermes true 2>/dev/null; then CHECKOUT_READY=true; break; fi
      sleep 2
    done
    CHECKOUT_TARGET=$(git -C "$ROOT/modules/codex-router" rev-parse HEAD 2>/dev/null || true)
    echo ""
    echo "--- Hermes Codex Router Checkout ---"
    CHECKOUT_OUTPUT=""
    if [ "$CHECKOUT_READY" != true ]; then
      echo -e "  ${RED}✗ hermes container did not become ready for the checkout refresh${NC}"
      failed=$((failed + 1))
    elif docker cp "$CHECKOUT_SCRIPT" hermes:/tmp/refresh-codex-router-checkout.sh \
        && [ -n "$CHECKOUT_TARGET" ] \
        && CHECKOUT_OUTPUT=$(docker exec -e CODEX_ROUTER_LOCK_WAIT_SECONDS=300 -e GH_TOKEN="${FRIDAY_PAT:-}" -u hermes hermes sh /tmp/refresh-codex-router-checkout.sh "$CHECKOUT_TARGET" 2>&1); then
      printf '%s\n' "$CHECKOUT_OUTPUT"
      # The success line comes from the script's own report, not from the exit
      # code: four outcomes exit 0 without advancing anything, and reporting those
      # as current is the failure this block exists to prevent.
      if printf '%s' "$CHECKOUT_OUTPUT" | grep -q "is at "; then
        echo -e "  ${GREEN}✓ hermes codex-router checkout is at this deploy's revision${NC}"
      else
        echo -e "  ${YELLOW}⏭ hermes codex-router checkout left alone${NC}"
      fi
    else
      printf '%s\n' "$CHECKOUT_OUTPUT"
      echo -e "  ${RED}✗ hermes codex-router checkout could not be advanced${NC}"
      failed=$((failed + 1))
    fi
    docker exec hermes rm -f /tmp/refresh-codex-router-checkout.sh 2>/dev/null || true
  fi
fi

# Hermes gateway (the dashboard needs basic auth, so the gate stays on the supervised service, never a port probe)
# Needs extra wait: config migration + profile seeding registers the supervised
# gateway service after container start, so poll it with the same bounded budget
# the HTTP health checks use instead of checking once. Measured 2026-10-09: the
# gateway took 2.5 minutes to come up (integrity check after an unclean exit), so
# the budget is 5 minutes, not the 90 seconds that failed deploy 585.
if should_deploy "hermes" || should_deploy "all"; then
  sleep 30
  gateway_up=false
  for _ in $(seq 1 45); do
    if docker exec hermes /package/admin/s6/command/s6-svstat -o up /run/service/gateway-default 2>/dev/null | grep -qx true; then
      gateway_up=true
      break
    fi
    sleep 6
  done
  if $gateway_up; then
    echo -e "  ${GREEN}✓ hermes gateway${NC}"
  else
    echo -e "  ${RED}✗ hermes gateway (s6 service not up)${NC}"
    failed=$((failed + 1))
  fi

  # Hermes WebUI: the s6 service starts with the container and listens inside it,
  # so poll its health endpoint with the same bounded budget the gateway check
  # uses. A WebUI that never answers must fail the deploy, not hang the runner.
  webui_up=false
  for _ in $(seq 1 10); do
    if docker exec hermes curl -fsS --max-time 10 http://127.0.0.1:8787/health >/dev/null 2>&1; then
      webui_up=true
      break
    fi
    sleep 6
  done
  if $webui_up; then
    echo -e "  ${GREEN}✓ hermes webui${NC}"
  else
    echo -e "  ${RED}✗ hermes webui (health endpoint not answering)${NC}"
    failed=$((failed + 1))
  fi
fi

if should_deploy "actual-api" || should_deploy "all"; then
  health_ok "actual-api" "http://localhost:3000/health" || failed=$((failed + 1))
fi

if should_deploy "expense-tracker" || should_deploy "all"; then
  health_ok "expense-tracker" "http://localhost:8080/health" || failed=$((failed + 1))
fi

if should_deploy "portfolio-tracker" || should_deploy "all"; then
  health_ok "portfolio-tracker" "http://localhost:8081/health" || failed=$((failed + 1))
fi

if should_deploy "codex-router" || should_deploy "all"; then
  # ---- Claude Pro usage snapshot (codex-router admin UI) ----
  # Host helper polls the Claude subscription usage endpoint every 5 min and
  # publishes a sanitized JSON file the router colours read through the
  # read-only bind mount on the x-codex-router-color anchor. The helper opens
  # ~/.claude/.credentials.json read-only and never refreshes or writes
  # credentials; on any failure it leaves the previous file in place and exits
  # non-zero, so the card goes stale by itself. The mkdir below exists so the
  # directory bind source is present before Docker sees it: at a missing source
  # Docker creates a root-owned directory, which would lock darren's helper
  # out. The placeholder seeds a first read; the bind is on the directory
  # (not the file) so the helper's atomic renames stay visible to the
  # container. Scheduling lives in DARREN's crontab, not runner's: the CLI
  # rewrites its credentials file with chmod 600 on every token refresh,
  # which resets the POSIX ACL mask and silently revokes a runner read
  # grant (observed 2026-10-11: the card went stale hours after the grant
  # while the helper itself was healthy). The file owner is immune to that,
  # so runner cron can never run this reliably. One-time setup as darren
  # (documented in DEPLOY.md):
  #   */5 * * * * /usr/bin/python3 <repo>/modules/fetch-claude-usage.py >/dev/null 2>&1
  USAGE_DIR="/home/runner/data/codex-router"
  USAGE_FILE="$USAGE_DIR/claude-usage.json"
  USAGE_HELPER="$ROOT/modules/fetch-claude-usage.py"
  mkdir -p "$USAGE_DIR"
  if [ ! -e "$USAGE_FILE" ]; then
    printf '{}\n' > "$USAGE_FILE"
  fi
  # The helper runs as darren (see above), so darren needs write access to the
  # output dir. Both runner and darren belong to the docker group, so a
  # group-owned setgid dir grants it with plain modes (no ACLs: nothing then
  # depends on masks). New files inherit group docker; the helper's
  # default 0644 keeps the read-only container mount working. Never fails deploy.
  # Traverse for darren's cron: /home/runner is 700, so without o+x on the
  # parents the leaf grant is unreachable (observed 2026-10-11: namei showed
  # drwx------ on /home/runner while the leaf was already group-writable).
  # Additive traverse-only, no read; mirrors /home/darren itself (711).
  chmod o+x /home/runner /home/runner/data 2>/dev/null || true
  chgrp docker "$USAGE_DIR" 2>/dev/null || true
  chmod 2770 "$USAGE_DIR" 2>/dev/null || true
  # Remove any runner-crontab line left by the earlier scheduling attempt: it
  # can only fail (see above). The rest of the crontab is kept.
  if command -v crontab >/dev/null 2>&1; then
    (crontab -l 2>/dev/null | grep -v "fetch-claude-usage.py" || true) | crontab - 2>/dev/null || true
  fi
  if [ -f "$USAGE_HELPER" ] && command -v python3 >/dev/null 2>&1; then
    # Best-effort first snapshot; a failure keeps the placeholder above.
    python3 "$USAGE_HELPER" >/dev/null 2>&1 || true
    USAGE_PY="$(command -v python3)"
    echo -e "  ${GREEN}✓ claude-usage output ready; ensure '*/5 * * * * $USAGE_PY $USAGE_HELPER' is in darren's crontab (one-time, see DEPLOY.md)${NC}"
    # Freshness gate (warn-only): a snapshot older than the router's 900s
    # staleness rule means the recurring run is not reaching the output —
    # usually darren's crontab line missing, or the helper failing on
    # credentials. Never fails the deploy: right after this merges, the
    # crontab line may not exist yet.
    USAGE_NOW="$(date +%s)"
    USAGE_FETCHED="$(python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get("fetched_at"); print(int(v) if isinstance(v,(int,float)) and not isinstance(v,bool) else 0)' "$USAGE_FILE" 2>/dev/null || echo 0)"
    if [ "$USAGE_FETCHED" -gt 0 ] 2>/dev/null && [ "$USAGE_NOW" -gt 0 ] && [ $((USAGE_NOW - USAGE_FETCHED)) -lt 900 ]; then
      echo -e "  ${GREEN}✓ claude-usage snapshot fresh ($((USAGE_NOW - USAGE_FETCHED))s old)${NC}"
    else
      echo -e "  ${YELLOW}(claude-usage snapshot is stale or missing — card will read stale until darren's every-5-min run succeeds; see DEPLOY.md)${NC}"
    fi
  else
    echo -e "  ${YELLOW}(claude-usage helper not installed; skipping usage snapshot)${NC}"
  fi
  # ---- codex-router rolling update ----
  # One colour serves at all times: start the idle colour, wait until it answers
  # inside its own container, then move the front onto it and stop the old
  # colour with the drain budget its stop_grace_period allows. Stopping the
  # serving colour first would cut every stream in flight, which is the
  # behaviour this roll exists to remove.
  echo ""
  echo "--- codex-router rolling update ---"

  # docker prints "<name> <compose service label>"; the service label plus the
  # project filter keeps this to this stack's own containers, whatever else runs
  # on the host under a lookalike service name. A docker failure prints nothing
  # and returns 2, a genuine no-match prints nothing and returns 0: callers can
  # tell "the daemon did not answer" from "no such container", which is the
  # difference between a probe that proves nothing and one that proves absence.
  colour_container() {
    local listing
    if ! listing="$(docker ps --filter status=running --filter label=com.docker.compose.project=modules \
      --format '{{.Names}} {{.Label "com.docker.compose.service"}}')"; then
      return 2
    fi
    printf '%s\n' "$listing" | awk -v service="$1" '$2 == service {print $1; exit}'
  }

  # The front is this stack's caddy container, identified by the label compose
  # gives only that service: the compose service name is reused by the legacy
  # router container until the cutover replaces it, so the name alone cannot say
  # which one is up. Same error convention as colour_container below: a failed
  # `docker ps` returns 2, so callers can tell it from a front that is not there.
  front_running() {
    local names
    names="$(docker ps --filter status=running \
      --filter label=com.docker.compose.project=modules \
      --filter label=modules.role=codex-router-front -q)" || return 2
    [ -n "$names" ]
  }

  # The front is created when it is absent and otherwise only reconciled by the
  # reload below. `up -d` would recreate a running front whose stanza or image
  # changed, and the front owns the only published listener, so that recreate
  # would interrupt every stream the roll exists to protect. ponytail: the
  # ceiling is a change to the front's own compose stanza (image, memory limit,
  # healthcheck), which now needs an explicit FORCE_ALL=true deploy; the upgrade
  # path is to compare the running container's config hash here and recreate only
  # when it really moved.
  #
  # A failed lookup is not an absent front either: `up -d` would recreate the one
  # container that owns 0.0.0.0:4100 and close every in-flight stream, for a
  # transient `docker ps` failure, and the recreate is silent. So an inconclusive
  # read never starts the front, not even for FORCE_ALL: the reload below still
  # runs and is the check in that case, failing on a front that really is absent
  # while leaving the previously serving colour up. The next deploy retries.
  front_needs_start() {
    local state=0
    front_running || state=$?
    [ "$state" != 2 ] || return 1
    [ "$state" = 1 ] || [ "${FORCE_ALL:-false}" = "true" ]
  }

  # Takes the container name, never the colour: a second lookup here would be a
  # second chance for `docker ps` to fail, and this probe's failure reads as "the
  # colour does not answer", which makes that colour the roll's candidate. The
  # selection below resolves the name once, through its guarded lookup.
  #
  # --max-time/--connect-timeout bound every probe: a colour that holds the
  # connection open without answering would otherwise block the roll forever
  # instead of reaching the readiness budget below.
  colour_ready() {
    docker exec "$1" curl -fsS --max-time 5 --connect-timeout 2 \
      http://127.0.0.1:4100/health/liveliness >/dev/null 2>&1
  }

  # The front prefers codex-router-a, so a running colour is only "serving" if it
  # answers; anything else is the idle half of the pair, reused if this
  # revision's image needs it.
  serving=""
  idle=""
  running_count=0
  colour_probe_failed=false
  for colour in codex-router-a codex-router-b; do
    container="$(colour_container "$colour")" || { colour_probe_failed=true; continue; }
    [ -n "$container" ] || continue
    running_count=$((running_count + 1))
    # One failed probe is not proof a colour is down (#691): the front's own
    # 10s checks disagreed with a single 5s reading minutes before a roll
    # destroyed a healthy colour. Confirm a negative before acting on it.
    colour_answers=false
    if [ -z "$serving" ]; then
      probe_attempts="${ROUTER_PROBE_ATTEMPTS:-3}"
      probe_n=1
      while :; do
        if colour_ready "$container"; then
          colour_answers=true
          break
        fi
        [ "$probe_n" -lt "$probe_attempts" ] || break
        probe_n=$((probe_n + 1))
        sleep "${ROUTER_PROBE_SLEEP:-5}"
      done
    fi
    if $colour_answers; then
      serving="$colour"
    elif [ -z "$idle" ]; then
      idle="$colour"
    fi
  done
  # A probe that failed is not evidence that no colour is running. The default
  # below would otherwise pick the colour it never saw — and in the steady state,
  # where the only colour up is the one the front serves, that is the front's
  # only upstream. Nothing has been started or stopped yet, so the roll stops
  # here and the next deploy retries from this same state.
  if [ "$colour_probe_failed" = true ]; then
    echo -e "  ${RED}✗ could not read this stack's containers; skipping the codex-router roll${NC}"
    failed=$((failed + 1))
  else
    # Nothing answers but exactly one colour is running: that colour is the
    # front's only upstream, serving or wedged, and recreating it would leave the
    # front with nothing to retry against for a whole cold start (#691). Treat it
    # as the old colour: the candidate becomes the other one, and this one is only
    # stopped after the front has moved onto a ready replacement.
    if [ -z "$serving" ] && [ "$running_count" -eq 1 ] && [ -n "$idle" ]; then
      serving="$idle"
      idle=""
    fi
    # The candidate is never the serving colour: recreating that one would leave
    # the front with nothing to retry against. This is the state every second
    # deploy starts in — the cutover deploy starts colour a and has nothing to
    # stop, so a is both the only running colour and the serving one. The equality
    # clause is defensive: the loop above never yields the same value twice.
    if [ -z "$idle" ] || [ "$idle" = "$serving" ]; then
      if [ "$serving" = "codex-router-a" ]; then
        idle="codex-router-b"
      else
        idle="codex-router-a"
      fi
    fi
    echo "  serving: ${serving:-none}; rolling: $idle"

    # --force-recreate, not a plain up: a colour that runs but never answers
    # /health/liveliness is the idle colour on every roll, and `up -d` is a no-op
    # on an unchanged container, so the same wedged candidate would be re-selected
    # and the deploy would fail every time while holding a second router. The
    # selection above guarantees this is never the colour the front is serving.
    $COMPOSE up -d --remove-orphans --force-recreate "$idle"

    ROUTER_DRAIN_SECONDS="${ROUTER_DRAIN_SECONDS:-600}"
    idle_ready=false
    for _ in $(seq 1 "$ROUTER_READY_ATTEMPTS"); do
      # Re-resolved every attempt: `up -d` can return while the colour is still
      # crash-looping, and a name captured once would stay empty for the whole
      # budget even after the container comes up.
      idle_container="$(colour_container "$idle")" || idle_container=""
      if [ -n "$idle_container" ] && docker exec "$idle_container" curl -fsS --max-time 5 --connect-timeout 2 \
        http://127.0.0.1:4100/health/liveliness >/dev/null 2>&1; then
        idle_ready=true
        break
      fi
      sleep "$HEALTH_RETRY_SLEEP"
    done

    if $idle_ready; then
      echo -e "  ${GREEN}✓ $idle ready${NC}"
      # The front exists from this point on. `#675`'s cutover: until its first
      # start the legacy container still owns 4100, so this revision's first
      # deploy is the last one that interrupts a stream. Every later roll finds it
      # running and leaves it alone (see front_needs_start).
      if front_needs_start; then
        $COMPOSE up -d --remove-orphans codex-router
      fi
      # An edit to the Caddyfile is a bind-mounted file change, which compose does
      # not hash: without this reload the front keeps the configuration it booted
      # with, which would leave the role out of the roll. The directory is mounted
      # rather than the file so a checkout that replaces the inode is still read.
      #
      # `up -d` returns when the container starts, not when caddy has bound its
      # admin listener, so on the paths that start the front (the cutover and
      # FORCE_ALL) the first reload can land on a booting front. That is a race,
      # not a broken configuration: the front is reading this same file. Retry
      # before failing the deploy; three attempts bound the extra wait at 96s.
      reload_ok=false
      for _ in 1 2 3; do
        if timeout 30 $COMPOSE exec -T codex-router caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
          reload_ok=true
          break
        fi
        sleep 2
      done
      if [ "$reload_ok" = true ]; then
        if [ -n "$serving" ]; then
          echo "  stopping $serving (drain ${ROUTER_DRAIN_SECONDS}s)"
          $COMPOSE stop -t "$ROUTER_DRAIN_SECONDS" "$serving" || {
            echo -e "  ${RED}✗ stop $serving failed${NC}"
            failed=$((failed + 1))
          }
        fi
      else
        # The reload validates before it swaps, so a failure means the front is
        # still serving the previous configuration: keep the old colour up rather
        # than take down the only upstream it names.
        echo -e "  ${RED}✗ caddy reload failed; keeping ${serving:-no colour}${NC}"
        failed=$((failed + 1))
      fi
    else
      echo -e "  ${RED}✗ $idle did not become ready in ${ROUTER_READY_SECONDS}s; keeping ${serving:-the running front}${NC}"
      failed=$((failed + 1))
    fi
  fi

  health_ok "codex-router" "http://localhost:4100/health/liveliness" "$ROUTER_READY_ATTEMPTS" || failed=$((failed + 1))
fi

# Pluggable module health checks (auto-discovered)
for mod_env in "$ROOT"/modules/*/module.env; do
  [ -f "$mod_env" ] || continue
  source "$mod_env"
  should_deploy "${MODULE_NAME:-}" || continue
  # Only health-check what was deployed; a retired module cannot answer.
  [[ " $TARGETS " == *" ${MODULE_NAME} "* ]] || continue
  for port in "${MODULE_HEALTH_PORTS[@]}"; do
    health_ok "${MODULE_NAME:-unknown}" "http://localhost:$port/health" || failed=$((failed + 1))
  done
done

echo ""
echo "========================================"
if [ "$failed" -gt 0 ]; then
  echo -e "  ${RED}$failed service(s) not healthy. Check: docker-compose logs${NC}"
  echo "========================================"
  exit 1
fi

echo -e "  ${GREEN}All services healthy.${NC}"

# ---- MCP reconnect ----
echo ""
echo "--- MCP Reconnect ---"
sleep 5

for mcp_name in expense-tracker portfolio-tracker; do
  if should_deploy "$mcp_name" || should_deploy "all"; then
    echo -n "  $mcp_name ... "
    if docker exec hermes hermes mcp test "$mcp_name" > /dev/null 2>&1; then
      echo -e "${GREEN}connected${NC}"
    else
      echo -e "${YELLOW}failed (retry later)${NC}"
    fi
  fi
done

# ---- onedrive reminder (non-interactive only) ----
if [ "$NON_INTERACTIVE" = true ] && should_deploy "portfolio-tracker"; then
  ONEDRIVE_TOKEN="$ROOT/modules/onedrive-sync/config/onedrive/refresh_token"
  if [ ! -f "$ONEDRIVE_TOKEN" ]; then
    echo ""
    echo "--- OneDrive ---"
    echo -e "  ${YELLOW}⚠ No refresh_token found. OneDrive is not initialized.${NC}"
    echo ""
    echo "  Initialize via MCP (no shell needed):"
    echo "    1. In Telegram: /onedrive setup"
    echo "    2. Hermes will give you a URL to open in your browser"
    echo "    3. After authorizing, paste the redirect URL back in Telegram"
    echo ""
    echo "  Or run deploy.sh interactively:"
    echo "    cd ~/friday && ./modules/deploy.sh --component portfolio-tracker"
    echo ""
  fi
fi

echo "========================================"

echo ""
