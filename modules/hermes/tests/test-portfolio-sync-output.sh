#!/bin/bash
# Regression test for the round-trip status lines in portfolio-sync.sh.
#
# The defect this covers: a dead OneDrive grant was reported as a successful pull,
# so the daily job printed a clean summary and the spreadsheet was written from a
# stale local portfolio file. Its output was indistinguishable from a healthy run.
#
# This test runs the SHIPPED script with a stubbed curl and asserts on its stdout.
# It deliberately does NOT extract the parse block and run it separately: a test
# that reads the block off disk and feeds it to its own `python3 -c` bypasses
# bash's parse-time quote removal, which is the only step that mangles the text.
# Such a test passes on a script that prints nothing at all, so it certifies the
# defect instead of catching it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SYNC_SCRIPT="$REPO_ROOT/modules/hermes/scripts/portfolio-sync.sh"

[ -f "$SYNC_SCRIPT" ] || { echo "FAIL: missing $SYNC_SCRIPT" >&2; exit 1; }

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

# Stub curl, first on PATH. It emits the body the real endpoint would return and
# appends the HTTP status the script splits off with `tail -1`.
mkdir -p "$TMPDIR_TEST/bin"
cat > "$TMPDIR_TEST/bin/curl" <<'STUB'
#!/bin/bash
printf '%s\n%s' "$STUB_BODY" "$STUB_CODE"
STUB
chmod +x "$TMPDIR_TEST/bin/curl"

# Run the real script and capture its stdout only. stderr carries the log lines,
# which are not under test.
run_sync() {
    PATH="$TMPDIR_TEST/bin:$PATH" \
        STUB_BODY="$1" \
        STUB_CODE="${2:-200}" \
        bash "$SYNC_SCRIPT" 2>/dev/null || true
}

FAILURES=0
check() {
    local label="$1" body="$2" expected="$3" unexpected="${4:-}"
    local out
    out="$(run_sync "$body")"
    if [ -n "$unexpected" ] && grep -qF -- "$unexpected" <<<"$out"; then
        echo "FAIL: $label — output unexpectedly contains: $unexpected" >&2
        printf '%s\n' "$out" >&2
        FAILURES=$((FAILURES + 1))
        return
    fi
    if grep -qF -- "$expected" <<<"$out"; then
        echo "ok: $label"
    else
        echo "FAIL: $label — expected output to contain: $expected" >&2
        printf 'actual stdout:\n%s\n' "$out" >&2
        FAILURES=$((FAILURES + 1))
    fi
}

HEALTHY='{"sync_targets":[{"name":"Deposit Account","status":"updated","delta":0}],"pull":{"status":"ok","detail":"downloaded"},"push":{"status":"ok","detail":"uploaded"}}'
DEAD_GRANT='{"sync_targets":[{"name":"Deposit Account","status":"unchanged","delta":0}],"pull":{"status":"error","detail":"Token HTTP 400"},"push":{"status":"error","detail":"Token HTTP 400"}}'
NO_LEG_KEYS='{"sync_targets":[{"name":"Deposit Account","status":"unchanged","delta":0}]}'
NULL_LEG='{"sync_targets":[{"name":"Deposit Account","status":"unchanged","delta":0}],"pull":null,"push":{"status":"ok","detail":"uploaded"}}'
# Review round 2, M1: the payload carries four remote legs but only pull and push
# were rendered, so an expired IBKR token produced a log identical to a healthy run.
FLEX_DEAD='{"sync_targets":[{"name":"Warchest","status":"updated","delta":0}],"pull":{"status":"ok","detail":"downloaded"},"flex_pull":{"success":false,"error":"IBKR Flex error 1012: Token has expired"},"flex_import":null,"push":{"status":"ok","detail":"uploaded"}}'
# Review round 2, M2: the AB budget fetch throws, so the payload is never assembled
# and the legs are absent entirely. The abort reason must still reach the log.
AB_ABORT='{"error":"Budget SGD Budget: HTTP 500: boom","sync_targets":[{"name":"Warchest","status":"skipped","delta":0,"error":"OneDrive not synced"}]}'
# Review round 2, M1: an explicit null status must render the placeholder, not the
# Python repr `None`, which reads as a parsing artifact rather than a missing value.
NULL_STATUS='{"sync_targets":[{"name":"Deposit Account","status":"unchanged","delta":0}],"pull":{"status":null,"detail":"x"},"push":{"status":"ok","detail":"uploaded"}}'

# A failed round trip must be visible rather than silent.
check "dead grant reports the failed pull" "$DEAD_GRANT" "pull: error (Token HTTP 400)"
check "dead grant reports the failed push" "$DEAD_GRANT" "push: error (Token HTTP 400)"

# A healthy round trip reports success and keeps the pre-existing target lines,
# so the new lines did not replace the summary that already worked.
check "healthy run reports the pull" "$HEALTHY" "pull: ok (downloaded)"
check "healthy run reports the push" "$HEALTHY" "push: ok (uploaded)"
check "healthy run still lists sync targets" "$HEALTHY" "Deposit Account: updated (delta=0)"

# Absent and explicit-null legs must degrade to the placeholder, not raise: a
# raise lands in the block's except and prints "(parse error: ...)", which hides
# every target line above it.
check "absent leg keys render a placeholder" "$NO_LEG_KEYS" "pull: ? ()"
check "absent leg keys keep the target lines" "$NO_LEG_KEYS" "Deposit Account: unchanged (delta=0)"
check "explicit null leg renders a placeholder" "$NULL_LEG" "pull: ? ()"
check "explicit null leg keeps the target lines" "$NULL_LEG" "Deposit Account: unchanged (delta=0)"

# A parse failure must never masquerade as a clean run.
check "dead grant does not print a parse error" "$DEAD_GRANT" "" "parse error"
check "absent keys do not print a parse error" "$NO_LEG_KEYS" "" "parse error"

# Review round 2, M1: a dead IBKR flex leg must be visible. This is the same defect
# class as #627 one leg over, and it reproduced on a healthy OneDrive grant.
check "dead flex pull is reported" "$FLEX_DEAD" "flex_pull: error (IBKR Flex error 1012: Token has expired)"
check "dead flex pull keeps the target lines" "$FLEX_DEAD" "Warchest: updated (delta=0)"
check "dead flex pull does not print a parse error" "$FLEX_DEAD" "" "parse error"

# Review round 2, M2: when the AB fetch aborts the sync the legs are absent, so the
# only signal left is the abort reason. It must not vanish.
check "aborted sync reports the reason" "$AB_ABORT" "error: Budget SGD Budget: HTTP 500: boom"
check "aborted sync does not print a parse error" "$AB_ABORT" "" "parse error"

# Review round 2, L4: an explicit null status renders the placeholder, not `None`.
check "explicit null status renders the placeholder" "$NULL_STATUS" "pull: ? (x)"
check "explicit null status never prints None" "$NULL_STATUS" "" "pull: None"

# Review round 3, M3: PpClient.importIbkr always sets status:"ok" and reports
# per-item failures in a separate errors[] list, so a dropped import is an "ok"
# with a populated list. Printing it as ok loses every trade for the period.
FLEX_IMPORT_DROPPED='{"sync_targets":[{"name":"Warchest","status":"updated","delta":0}],
  "pull":{"status":"ok","detail":"downloaded"},
  "push":{"status":"ok","detail":"uploaded"},
  "flex_import":{"status":"ok","trades_imported":0,"dividends_imported":0,
    "other_imported":0,"securities_created":0,"items_skipped":0,
    "errors":["Failed to insert item: CONID mismatch"]}}'
check "dropped flex import is reported" "$FLEX_IMPORT_DROPPED" "flex_import: error (1 item failed to import - Failed to insert item: CONID mismatch)"
check "dropped flex import is never reported as ok" "$FLEX_IMPORT_DROPPED" "" "flex_import: ok"
check "dropped flex import keeps the target lines" "$FLEX_IMPORT_DROPPED" "Warchest: updated (delta=0)"

FLEX_IMPORT_CLEAN='{"sync_targets":[{"name":"Warchest","status":"updated","delta":0}],
  "pull":{"status":"ok","detail":"downloaded"},
  "push":{"status":"ok","detail":"uploaded"},
  "flex_import":{"status":"ok","trades_imported":2,"dividends_imported":0,
    "other_imported":0,"securities_created":0,"items_skipped":0,
    "errors":[]}}'
check "clean flex import stays a success" "$FLEX_IMPORT_CLEAN" "flex_import: ok ()"
check "clean flex import is not reported as an error" "$FLEX_IMPORT_CLEAN" "" "flex_import: error"

# Review round 3, M4: "not configured" is the steady state of a deployment that
# does not use IBKR flex (config.js defaults both tokens to ""). It must not be
# logged as a failing leg on every run, or the operator stops reading the line.
FLEX_UNCONFIGURED='{"sync_targets":[{"name":"Warchest","status":"updated","delta":0}],
  "pull":{"status":"ok","detail":"downloaded"},
  "push":{"status":"ok","detail":"uploaded"},
  "flex_pull":{"success":false,"skipped":true,"error":"Not configured"}}'
check "skipped flex pull is not logged as an error" "$FLEX_UNCONFIGURED" "" "flex_pull: error"
# Also assert the leg line is gone entirely, not merely free of the word "error":
# without the skip guard it renders as "flex_pull: skipped (...)".
check "skipped flex pull renders no leg line at all" "$FLEX_UNCONFIGURED" "" "flex_pull:"
check "skipped flex pull is not logged as not configured" "$FLEX_UNCONFIGURED" "" "Not configured"
check "skipped flex pull keeps the healthy pull line" "$FLEX_UNCONFIGURED" "pull: ok (downloaded)"

# A pre-`skipped` payload carrying only the sentinel string must behave the same,
# so both surfaces agree regardless of which produced the body.
FLEX_UNCONFIGURED_LEGACY='{"sync_targets":[],"pull":{"status":"ok","detail":"downloaded"},
  "flex_pull":{"success":false,"error":"Not configured"}}'
check "legacy unconfigured sentinel is not logged as an error" "$FLEX_UNCONFIGURED_LEGACY" "" "flex_pull: error"

# Review round 3, M1: PpClient skips items at four sites that never touch errors[]
# (unmapped account, null portfolio, null account key, unhandled item type), so
# {0 imported, N skipped, errors: []} is the dominant drop mode. It rendered
# byte-identical to a healthy run on both surfaces.
FLEX_IMPORT_ALL_SKIPPED='{"sync_targets":[{"name":"Warchest","status":"updated","delta":0}],
  "pull":{"status":"ok","detail":"downloaded"},
  "push":{"status":"ok","detail":"uploaded"},
  "flex_import":{"status":"ok","trades_imported":0,"dividends_imported":0,
    "other_imported":0,"securities_created":0,"items_skipped":37,"errors":[]}}'
check "a total drop is reported" "$FLEX_IMPORT_ALL_SKIPPED" "flex_import: error (nothing imported - all 37 items skipped)"
check "a total drop is never reported as ok" "$FLEX_IMPORT_ALL_SKIPPED" "" "flex_import: ok"
check "a total drop keeps the target lines" "$FLEX_IMPORT_ALL_SKIPPED" "Warchest: updated (delta=0)"

# The other side of the boundary: skipping some items alongside a real import is
# normal (duplicates, already-held positions) and must stay a success.
FLEX_IMPORT_PARTIAL_SKIP='{"sync_targets":[],
  "pull":{"status":"ok","detail":"downloaded"},
  "flex_import":{"status":"ok","trades_imported":2,"dividends_imported":0,
    "other_imported":0,"securities_created":0,"items_skipped":5,"errors":[]}}'
check "a partial skip alongside a real import stays a success" "$FLEX_IMPORT_PARTIAL_SKIP" "flex_import: ok ()"
check "a partial skip is not reported as an error" "$FLEX_IMPORT_PARTIAL_SKIP" "" "flex_import: error"

# Nothing skipped and nothing imported is a no-op statement, not a failure.
FLEX_IMPORT_EMPTY='{"sync_targets":[],
  "flex_import":{"status":"ok","trades_imported":0,"dividends_imported":0,
    "other_imported":0,"securities_created":0,"items_skipped":0,"errors":[]}}'
check "an empty statement is not a total drop" "$FLEX_IMPORT_EMPTY" "flex_import: ok ()"
check "an empty statement is not reported as an error" "$FLEX_IMPORT_EMPTY" "" "flex_import: error"

# Review round 3, M2: the shell parser retypes the sentinel literal because bash
# cannot import it, so nothing tied the two sides together. Rewording
# NOT_CONFIGURED_ERROR left all 67 vitest tests and this file green, because both
# test files import the real constant while the check above compares a literal to
# a literal. The one line that closes it: this file is the JS side's view of the
# same string, so assert the JS constant equals the literal the parser matches on.
# If the wording ever changes, this fails instead of the M4 regression going green.
# Read the real constant out of the JS module. The module (and its node_modules)
# may be absent from a staged tree — the dev-loop mutation control runs this file
# against a tree that contains only the two files it cares about — so this is
# guarded and degrades to skipping rather than aborting the whole suite. The
# coupling assertion below is what the review round 3 fix is pinned on; it is
# enforced wherever the JS module is actually present, which is CI and every
# ordinary run.
SENTINEL_FROM_JS=""
if [ -f "$REPO_ROOT/modules/portfolio-tracker/src/ibkr_flex.js" ]; then
    SENTINEL_FROM_JS="$(cd "$REPO_ROOT/modules/portfolio-tracker" 2>/dev/null && node --input-type=module -e '
    import { NOT_CONFIGURED_ERROR } from "./src/ibkr_flex.js";
    process.stdout.write(NOT_CONFIGURED_ERROR);
' 2>/dev/null || true)"
fi

if [ -n "$SENTINEL_FROM_JS" ]; then
    check "the shell sentinel and the JS constant are the same string" \
        "{\"sync_targets\":[],\"flex_pull\":{\"success\":false,\"error\":\"$SENTINEL_FROM_JS\"}}" \
        "pull: ? ()" "flex_pull: error"
else
    echo "skip: portfolio-tracker module not present, sentinel coupling not checked"
fi

# The direct form of the same check: the parser's literal and the JS constant must
# be the identical string. The check above proves the behaviour end to end; this
# one names the drift directly, so a reword says which side moved.
PARSER_SENTINEL="$(sed -n "s/.*detail == '\([^']*\)':.*/\1/p" "$SYNC_SCRIPT" | head -1)"
# Review round 4, M1: taxonomy_export is a fifth remote leg in the same payload
# (tools.js returns it alongside the other four) and it is the leg whose job is
# writing the sheet the operator reads. It has three shapes: error, partial with
# an errors[] list, and skipped for a configuration gap.
TAX_ERROR='{"sync_targets":[{"name":"Warchest","status":"updated","delta":0}],
  "pull":{"status":"ok","detail":"downloaded"},
  "push":{"status":"ok","detail":"uploaded"},
  "taxonomy_export":{"status":"error","detail":"Google Sheets API: 401 UNAUTHENTICATED"}}'
check "a failed Sheets export is reported" "$TAX_ERROR" "taxonomy_export: error (Google Sheets API: 401 UNAUTHENTICATED)"
check "a failed Sheets export is never reported as ok" "$TAX_ERROR" "" "taxonomy_export: ok"
check "a failed Sheets export keeps the target lines" "$TAX_ERROR" "Warchest: updated (delta=0)"

TAX_PARTIAL='{"sync_targets":[],
  "pull":{"status":"ok","detail":"downloaded"},
  "taxonomy_export":{"status":"partial","cells_written":[],
    "errors":["No cell mapping for SG","No cell mapping for US"]}}'
check "a partial Sheets export is reported" "$TAX_PARTIAL" "taxonomy_export: error (2 cells failed to write - No cell mapping for SG; No cell mapping for US)"

# A configuration gap is not a failed write, so it must not warn on every run.
# Asserting only that the word "error" is absent is too weak: without the skip
# guard the leg still renders, just as "skipped". The line must be gone entirely.
TAX_SKIPPED='{"sync_targets":[],
  "pull":{"status":"ok","detail":"downloaded"},
  "taxonomy_export":{"status":"skipped","reason":"no GOOGLE_SHEET_ID"}}'
check "a skipped Sheets export is not an error" "$TAX_SKIPPED" "" "taxonomy_export: error"
check "a skipped Sheets export renders no leg line at all" "$TAX_SKIPPED" "" "taxonomy_export:"
check "a skipped Sheets export keeps the healthy pull line" "$TAX_SKIPPED" "pull: ok (downloaded)"

TAX_OK='{"sync_targets":[],
  "pull":{"status":"ok","detail":"downloaded"},
  "taxonomy_export":{"status":"completed","cells_written":42}}'
check "a completed Sheets export is not an error" "$TAX_OK" "" "taxonomy_export: error"
check "a completed Sheets export renders its status" "$TAX_OK" "taxonomy_export: completed ()"

# portfolio_status has no `status` key: tools.js:1025 stores a failed status
# fetch as {error}. Round 4 flagged it as a silently dropped leg.
STATUS_ERR='{"sync_targets":[],
  "pull":{"status":"ok","detail":"downloaded"},
  "portfolio_status":{"error":"Portfolio.app unreachable"}}'
check "a failed status fetch is reported" "$STATUS_ERR" "portfolio_status: error (Portfolio.app unreachable)"

if [ -n "$SENTINEL_FROM_JS" ] && [ "$PARSER_SENTINEL" != "$SENTINEL_FROM_JS" ]; then
    echo "FAIL: the shell parser matches on '$PARSER_SENTINEL' but NOT_CONFIGURED_ERROR is '$SENTINEL_FROM_JS'" >&2
    echo "      the M4 not-configured guard would silently stop working" >&2
    FAILURES=$((FAILURES + 1))
fi

if [ "$FAILURES" -ne 0 ]; then
    echo "FAIL: $FAILURES check(s) failed" >&2
    exit 1
fi

echo "PASS: portfolio-sync.sh reports round-trip status"
