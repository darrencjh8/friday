#!/bin/bash
# Portfolio sync — deterministic REST call, zero LLM tokens.
# curl → pp-sync-all → done. Cron runs this via no_agent: true.
set -euo pipefail

log()  { echo "[portfolio-sync] $(date -Iseconds) $*" >&2; }

ENDPOINT="http://portfolio-tracker:8081/tools/pp-sync-all"

log "triggering sync via $ENDPOINT"

RESP=$(curl -s -w "\n%{http_code}" -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d '{}' \
    --max-time 300 2>&1)

HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

log "HTTP $HTTP_CODE"

if [ "$HTTP_CODE" != "200" ]; then
    log "ERROR: sync failed — HTTP $HTTP_CODE"
    echo "$BODY" >&2
    exit 1
fi

# Log a compact summary.
# The program is read by a QUOTED heredoc, so bash performs no expansion and no
# quote removal on it, and it reaches python3 byte-identical. Passing the same
# text through `python3 -c "..."` mangles every quote inside it: double-quoted
# dict keys arrive as bare identifiers and raise SyntaxError, which the
# `2>/dev/null || true` below swallows, so the script would exit 0 having
# printed nothing at all. Keep the quoting out of bash's reach.
read -r -d '' PARSE_PROG <<'PARSE_EOF' || true
import sys, json
try:
    data = json.load(sys.stdin)
    # The sync can abort before it assembles a payload (an Actual Budget outage
    # throws out of fetchBudget). Report that reason first: without it the log
    # showed only placeholders and the aborting cause was lost entirely.
    if data.get('error'):
        print(f'  error: {data["error"]}')
    targets = data.get('sync_targets', [])
    for t in targets:
        name = t.get('name', '?')
        status = t.get('status', '?')
        delta = t.get('delta', 0)
        print(f'  {name}: {status} (delta={delta})')
        if t.get('error'):
            print(f'    {t["error"]}')
    # Every remote leg, not just pull/push: the IBKR flex legs fail silently
    # the same way and on their own token expiry. `or '?'` and `or ''` cover an
    # explicit null as well as a missing key, so a null never prints `None`.
    for leg in ('pull', 'push', 'flex_pull', 'flex_import', 'taxonomy_export',
                'portfolio_status'):
        r = data.get(leg)
        if leg == 'portfolio_status' and isinstance(r, dict) and r.get('error'):
            # tools.js stores a failed status fetch as {error: msg} and no other
            # leg or consumer reads it, so surface it here too or the run is clean.
            print(f'  {leg}: error ({r["error"]})')
            continue
        if not isinstance(r, dict):
            # Absent, or an explicit null: render the placeholder. For
            # taxonomy_export this means the deployment does not export taxonomies.
            print(f'  {leg}: ? ()')
            continue
        status = r.get('status') or r.get('success')
        detail = r.get('detail') or r.get('error') or ''
        # A flex leg this deployment never configured is not a failure. The MCP
        # surface skips it via the `skipped` flag set by pullFlexXml; match that
        # here, and also accept the bare error string so both surfaces agree.
        if r.get('skipped') or detail == 'Not configured':
            continue
        # taxonomy_export reports "skipped" per configuration gap, which is
        # configuration absence rather than a failed write, so it must not warn
        # on every run. Its "partial" shape carries the real problem in errors[].
        if leg == 'taxonomy_export' and status == 'skipped':
            continue
        if leg.startswith('flex') and status is True:
            status = 'ok'
        elif leg.startswith('flex') and status is False:
            status = 'error'
        # PpClient.importIbkr always sets status:"ok" and reports per-item
        # failures in a separate errors[] list, so a dropped import looks like a
        # success here unless the list itself is surfaced.
        item_errors = r.get('errors') or []
        if leg in ('flex_import', 'taxonomy_export') and item_errors:
            # flex_import: PpClient always sets status:"ok" and reports per-item
            # failures in errors[]. taxonomy_export: status "partial" carries the
            # per-cell failures there. Both render as an error, not a success.
            n = len(item_errors)
            noun = 'cell' if leg == 'taxonomy_export' else 'item'
            verb = 'to write' if leg == 'taxonomy_export' else 'to import'
            print(f'  {leg}: error ({n} {noun}{"" if n == 1 else "s"} failed {verb} - '
                  f'{"; ".join(str(e) for e in item_errors)})')
            continue
        # The silent-drop route: PpClient skips items at four sites that never
        # touch errors[] (PpClient.java), so {0 imported, N skipped, errors: []}
        # rendered byte-identical to a healthy run. Only flag a total drop, since
        # skipping some items alongside a real import is normal.
        if leg == 'flex_import' and not item_errors:
            # Parenthesised, not backslash-continued: the heredoc is quoted so the
            # backslash would reach Python as a literal continuation character.
            imported = ((r.get('trades_imported') or 0)
                        + (r.get('dividends_imported') or 0)
                        + (r.get('other_imported') or 0))
            skipped = r.get('items_skipped') or 0
            if imported == 0 and skipped > 0:
                print(f'  {leg}: error (nothing imported - all {skipped} item{"" if skipped == 1 else "s"} skipped)')
                continue
        print(f'  {leg}: {status if status is not None else "?"} ({detail})')
except Exception as e:
    print(f'  (parse error: {e})')
PARSE_EOF

echo "$BODY" | python3 -c "$PARSE_PROG" 2>/dev/null || true

log "sync complete"
