#!/usr/bin/env bash
# check-docs-drift.sh — fail CI when a live doc no longer matches the code.
#
# Compares mechanically checkable facts (compose services/ports/mem_limit,
# skills/profiles listings, seeded cron jobs, tool-surface counts, test.yml
# jobs, deploy.sh components, deploy.yml detection, retired strings, spec
# numbering) against the docs that state them. Docs only; never writes.
# Usage: bash scripts/check-docs-drift.sh   (exit 0 = in step, 1 = drift)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

status=0
fail() { echo "FAIL: $1"; status=1; }

# Exact-name match: the name must be bounded by something that is not a
# name character, so `codex-router` never matches `codex-router-a`.
has_name() { # has_name <line> <name>
    printf '%s' "$1" | grep -qE "(^|[^A-Za-z0-9_-])$2([^A-Za-z0-9_-]|$)"
}

# ---------------------------------------------------------------- check 1
# Compose service list/count vs README.md, design.md, docs/repository-layout.md.
services=$(awk '/^services:/{f=1; next} f && /^    [a-z][a-z0-9_-]*: *$/{print $1} f && /^[^ ]/{exit}' modules/docker-compose.yml | tr -d ':')
n_services=$(printf '%s\n' "$services" | grep -c .)
[ "$n_services" -eq 9 ] || fail "check 1: compose defines $n_services services, expected 9"
for doc in README.md design.md docs/repository-layout.md; do
    line=$(grep -m1 '├── docker-compose.yml' "$doc" || true)
    [ -n "$line" ] || { fail "check 1: $doc has no service list line"; continue; }
    for svc in $services; do
        has_name "$line" "$svc" || fail "check 1: $doc service list is missing $svc"
    done
done

# ---------------------------------------------------------------- check 2
# Compose mem_limit per service vs design.md §4 table (row-scoped: each
# service's own row must state its limit and its human-readable size).
# Effective limits: a service's own `mem_limit`, or the shared
# x-codex-router-color anchor it merges (codex-router-a/b: 1536m).
mem_limits=$(python3 - <<'PYEOF'
import re
text = open("modules/docker-compose.yml").read()
anchor = re.search(r"x-codex-router-color:.*?(?:^|\n)    mem_limit: (\S+)", text, re.S)
anchor_limit = anchor.group(1) if anchor else ""
lines = text.splitlines()
in_services = False
cur = None
for line in lines:
    if line == "services:":
        in_services = True
        continue
    if not in_services:
        continue
    m = re.match(r"    ([a-z][a-z0-9_-]*):\s*$", line)
    if m:
        cur = m.group(1)
        continue
    if line and not line.startswith(" "):
        break
    if re.match(r"        mem_limit: (\S+)", line):
        print(f"{cur}|{line.strip().split(': ', 1)[1]}")
    elif re.match(r"        <<: \*codex-router-color", line) and anchor_limit:
        print(f"{cur}|{anchor_limit}")
PYEOF
)
size_text() { # size_text <limit>
    case "$1" in
        128m) echo "~128 MB" ;;
        512m) echo "~512 MB" ;;
        1500m) echo "~1.5 GB" ;;
        4g) echo "~4 GB" ;;
        *) echo "$1" ;;
    esac
}
table4=$(awk '/^## 4\. Hosting Topology/,/^### Production Server Setup/' design.md)
while IFS='|' read -r svc limit; do
    [ -n "$svc" ] || continue
    case "$svc" in
        hermes) row=$(printf '%s\n' "$table4" | grep -F '| **Hermes Agent** |' || true) ;;
        codex-router-a|codex-router-b) row=$(printf '%s\n' "$table4" | grep -F '| **codex-router** |' || true) ;;
        *) row=$(printf '%s\n' "$table4" | grep -F "| **$svc** |" || true) ;;
    esac
    [ -n "$row" ] || { fail "check 2: design.md §4 has no row for $svc"; continue; }
    case "$svc" in
        codex-router-a|codex-router-b)
            printf '%s' "$row" | grep -q "inherit $limit" || fail "check 2: design.md §4 does not say the codex-router colours inherit $limit"
            ;;
        *)
            size=$(size_text "$limit")
            printf '%s' "$row" | grep -qF "$size" || fail "check 2: design.md §4 row for $svc does not say $size"
            printf '%s' "$row" | grep -q "mem_limit: $limit" || fail "check 2: design.md §4 row for $svc does not say mem_limit $limit"
            ;;
    esac
done <<EOF
$mem_limits
EOF
grep -q "expense-tracker.*no \`mem_limit\`" design.md || fail "check 2: design.md §4 does not say expense-tracker has no mem_limit"
# The constitution §2.5 repeats the mem_limit table for three services; it
# must agree with compose too (a wrong value here once shipped as 1536m for
# expense-tracker, which has no mem_limit at all — 1536m is the
# x-codex-router-color anchor, inherited only by codex-router-a/b).
const25=$(awk '/^### 2.5 Memory Budget/,/^### 2.6/' .specify/memory/constitution.md)
printf '%s\n' "$const25" | grep -q '| hermes | 4g |' || fail "check 2: constitution §2.5 does not say hermes mem_limit 4g"
printf '%s\n' "$const25" | grep -q '| portfolio-tracker | 512m |' || fail "check 2: constitution §2.5 does not say portfolio-tracker mem_limit 512m"
printf '%s\n' "$const25" | grep -q '| expense-tracker | no `mem_limit` |' || fail "check 2: constitution §2.5 does not say expense-tracker has no mem_limit"

# ---------------------------------------------------------------- check 3
# Compose published ports per service vs SETUP.md and docs/operations.md.
# Emits "<service> <host-port>" per published port; whisper publishes none.
ports=$(python3 - <<'PYEOF'
import re
lines = open("modules/docker-compose.yml").read().splitlines()
in_services = False
cur = None
in_ports = False
for line in lines:
    if line == "services:":
        in_services = True
        continue
    if not in_services:
        continue
    m = re.match(r"    ([a-z][a-z0-9_-]*):\s*$", line)
    if m:
        cur = m.group(1)
        in_ports = False
        continue
    if line and not line.startswith(" "):
        break
    if re.match(r"        ports:\s*$", line):
        in_ports = True
        continue
    if in_ports:
        if re.match(r"        \S", line):
            in_ports = False
            continue
        pm = re.match(r'\s+- "([^"]+)"', line)
        if pm:
            parts = pm.group(1).split(":")
            host = parts[-2] if len(parts) >= 2 else ""
            if host and host != "0.0.0.0":
                print(f"{cur} {host}")
            elif host == "0.0.0.0":
                print(f"{cur} {parts[-2] if len(parts) >= 3 else parts[-1]}")
PYEOF
)
# Doc display names for the ports tables (SETUP.md uses titles, operations.md
# uses compose service names).
display_name() { # display_name <doc> <service>
    case "$1:$2" in
        SETUP.md:expense-tracker) echo "Expense Tracker" ;;
        SETUP.md:portfolio-tracker) echo "Portfolio Tracker" ;;
        SETUP.md:actual-api) echo "Actual API" ;;
        SETUP.md:dots-web) echo "Dots Web" ;;
        SETUP.md:codex-router) echo "Codex Router (front)" ;;
        SETUP.md:hermes) echo "Hermes" ;;
        SETUP.md:whisper) echo "Whisper" ;;
        *) echo "$2" ;;
    esac
}
for doc in SETUP.md docs/operations.md; do
    case "$doc" in
        SETUP.md) table=$(awk '/^## Docker Services/,/^## Named Volumes/' "$doc"); col=4 ;;
        docs/operations.md) table=$(awk '/^## Ports/,/^## Tailnet/' "$doc"); col=3 ;;
    esac
    while IFS=' ' read -r svc port; do
        [ -n "$svc" ] || continue
        disp=$(display_name "$doc" "$svc")
        row=$(printf '%s\n' "$table" | grep -F "$disp" | head -1 || true)
        [ -n "$row" ] || { fail "check 3: $doc has no ports row for $svc"; continue; }
        cell=$(printf '%s\n' "$row" | awk -F'|' -v c="$col" '{print $c}')
        printf '%s' "$cell" | grep -q "$port" || fail "check 3: $doc ports row for $svc is missing port $port"
    done <<EOF
$ports
EOF
done
for doc in SETUP.md docs/operations.md; do
    case "$doc" in
        SETUP.md) table=$(awk '/^## Docker Services/,/^## Named Volumes/' "$doc") ;;
        docs/operations.md) table=$(awk '/^## Ports/,/^## Tailnet/' "$doc") ;;
    esac
    row=$(printf '%s\n' "$table" | grep -i "whisper" | head -1 || true)
    case "$row" in
        *"no published port"*) ;;
        *) fail "check 3: $doc does not say whisper has no published port" ;;
    esac
done

# ---------------------------------------------------------------- check 4
# skills/ and profiles/ listings vs the doc lists.
skills=$(ls modules/hermes/skills/)
profiles=$(ls modules/hermes/profiles/)
for doc in README.md docs/README.md docs/repository-layout.md; do
    line=$(grep -m1 '├── skills/' "$doc" || grep -m1 'skills/' "$doc" || true)
    [ -n "$line" ] || { fail "check 4: $doc has no skills list"; continue; }
    for sk in $skills; do
        has_name "$line" "$sk" || fail "check 4: $doc skills list is missing $sk"
    done
done
for doc in README.md design.md; do
    line=$(grep -m1 '├── profiles/' "$doc" || true)
    [ -n "$line" ] || { fail "check 4: $doc has no profiles list"; continue; }
    for prof in $profiles; do
        has_name "$line" "$prof" || fail "check 4: $doc profiles list is missing $prof"
    done
done

# ---------------------------------------------------------------- check 5
# Seeded cron jobs vs the design.md / SETUP.md tables.
# Emits "name|expr|display": expr empty for interval jobs.
jobs=$(python3 - <<'PYEOF'
import re
text = open("modules/hermes/50-seed-defaults").read()
lines = text.splitlines()
found = {}

def add(name, expr, display):
    if name and name not in found:
        found[name] = (expr or "", display or "")

# SEEDS dict: "name": ("script", "expr", "display")
m = re.search(r"SEEDS\s*=\s*\{(.*?)\n\}", text, re.S)
if m:
    for name, expr, disp in re.findall(r'"([a-z0-9-]+)":\s*\("[^"]*",\s*"([^"]*)",\s*"([^"]*)"\)', m.group(1)):
        add(name, expr, disp)

# Every "name": "X" dict entry: the schedule lives in the job's own
# jobs.append({...}) literal, either inline as a "schedule" dict or via a
# **DEFAULTS spread whose DEFAULTS block sits just above the append. A
# character window around the name is NOT enough: neighbouring jobs' blocks
# sit within a few hundred lines, so a window mis-associates schedules
# (gtasks-clear-completed once got finance-portfolio-sync's expr,
# memory-mnemosyne-vacuum got memory-backup's interval values,
# skills-merge-proposals got proactive-tick's expr).
def brace_block(s, open_idx):
    # Text of the balanced {...} starting at open_idx; string literals
    # (which may contain braces) are skipped.
    depth = 0
    i = open_idx
    quote = None
    while i < len(s):
        c = s[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
        else:
            if c in "\"'":
                quote = c
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return s[open_idx:i + 1]
        i += 1
    return ""

def schedule_of(block):
    # (expr, display) from a dict literal's own "schedule" dict, or None.
    # Interval jobs carry a display but no expr.
    m = re.search(r'"schedule":\s*\{', block)
    if not m:
        return None
    sched = brace_block(block, m.end() - 1)
    kind = re.search(r'"kind":\s*"([^"]+)"', sched)
    expr = re.search(r'"expr":\s*"([^"]+)"', sched)
    disp = re.search(r'"display":\s*"([^"]+)"', sched)
    if kind and kind.group(1) == "interval":
        return ("", disp.group(1) if disp else "")
    return (expr.group(1) if expr else "", disp.group(1) if disp else "")

for nm in re.finditer(r'"name":\s*"([a-z0-9-]+)"', text):
    name = nm.group(1)
    if name in found:
        continue
    # The job dict is a jobs.append({...}) literal, except
    # ops-github-token-refresh, which is a `wanted = {...}` literal.
    app = max(text.rfind("jobs.append({", 0, nm.start()),
              text.rfind("wanted = {", 0, nm.start()))
    if app < 0:
        continue
    block = brace_block(text, text.index("{", app))
    sched = schedule_of(block)
    if sched is None and "**DEFAULTS" in block:
        dflt = text.rfind("DEFAULTS = {", 0, app)
        if dflt >= 0:
            sched = schedule_of(brace_block(text, text.index("{", dflt)))
    if sched is None:
        continue
    add(name, sched[0], sched[1])
for name in sorted(found):
    expr, disp = found[name]
    print(f"{name}|{expr}|{disp}")
PYEOF
)
n_jobs=$(printf '%s\n' "$jobs" | grep -c .)
[ "$n_jobs" -eq 15 ] || fail "check 5: seed defines $n_jobs cron jobs, expected 15"
for doc in design.md SETUP.md; do
    case "$doc" in
        design.md) table=$(awk '/^### 6.4 Cron Jobs/,/^### 6.5/' "$doc") ;;
        SETUP.md) table=$(awk '/^## Cron Jobs/,/^```/' "$doc") ;;
    esac
    while IFS='|' read -r name expr disp; do
        [ -n "$name" ] || continue
        # Row-scoped: the expr/display must sit on this job's own table
        # row. A grep-anywhere check passes while the row itself is wrong.
        row=$(printf '%s\n' "$table" | grep -F "$name" | head -1 || true)
        [ -n "$row" ] || { fail "check 5: $doc cron table is missing job $name"; continue; }
        if [ -n "$expr" ]; then
            printf '%s' "$row" | grep -qF "$expr" || fail "check 5: $doc cron table row for $name does not say expr $expr"
        else
            printf '%s' "$row" | grep -qF "$disp" || fail "check 5: $doc cron table row for $name does not say $disp"
        fi
    done <<EOF
$jobs
EOF
    # And the tables must not list a job the seed does not define.
    while read -r tname; do
        printf '%s\n' "$jobs" | cut -d'|' -f1 | grep -qx "$tname" || fail "check 5: $doc cron table lists $tname, which the seed does not define"
    done < <(printf '%s\n' "$table" | awk -F'|' '$2 ~ /`[a-z][a-z0-9-]+`/ {gsub(/[` ]/, "", $2); print $2}' | sort -u)
done

# ---------------------------------------------------------------- check 6
# Tool counts: raw and learning-on, vs design.md, glossary.md, specs/002/003.
mcp_raw=$(grep -c 'server\.tool(' modules/expense-tracker/src/mcp-server.js)
rest_raw=$(python3 -c "
import re
t = open('modules/expense-tracker/src/index.js').read()
m = re.search(r'const toolNames = \[(.*?)\];', t, re.S)
print(len(re.findall(r'\"[a-z_]+\"', m.group(1))))")
[ "$mcp_raw" -eq 28 ] || fail "check 6: raw MCP count is $mcp_raw, expected 28"
[ "$rest_raw" -eq 33 ] || fail "check 6: raw REST count is $rest_raw, expected 33"
grep -q 'if (!registry.learningCommandsEnabled)' modules/expense-tracker/src/mcp-server.js || fail "check 6: mcp-server.js no longer gates confirm_learning on learningCommandsEnabled"
grep -q 'if (learningCommandsOn && name === "confirm_learning") continue;' modules/expense-tracker/src/index.js || fail "check 6: index.js no longer skips confirm_learning when learning is on"
mcp_on=$((mcp_raw - 1)); rest_on=$((rest_raw - 1))
grep -q "(with learning commands on; $mcp_raw with learning off)" design.md || fail "check 6: design.md §5.1 does not say MCP $mcp_on on / $mcp_raw off"
grep -q "$rest_on are mounted as REST \`/tools/\*\` endpoints ($rest_raw with learning off)" design.md || fail "check 6: design.md §5.1 does not say REST $rest_on on / $rest_raw off"
grep -q "($mcp_raw when off, since \`confirm_learning\` is registered only then)" design.md || fail "check 6: design.md §5.5 does not say MCP $mcp_raw when off"
grep -q "$rest_on mounted over REST ($rest_raw when off" design.md || fail "check 6: design.md §5.5 does not say REST $rest_on on / $rest_raw off"
mcp_section=$(awk '/^### expense-tracker — MCP surface/,/^### expense-tracker — REST-only/' docs/glossary.md)
printf '%s' "$mcp_section" | grep -q 'search_wiki' || fail "check 6: glossary.md MCP list is missing search_wiki"
printf '%s' "$mcp_section" | grep -q 'confirm_learning' && fail "check 6: glossary.md MCP list still contains confirm_learning (learning-on list)"
grep -q "These eleven, exactly:" docs/glossary.md || fail "check 6: glossary.md does not say eleven REST-only tools"
grep -q 'match_broker_deposit' docs/glossary.md || fail "check 6: glossary.md REST-only list is missing match_broker_deposit"
grep -q "\*\*$rest_on REST" specs/002-expense-tracking/spec.md || fail "check 6: specs/002 does not say REST $rest_on on"
grep -q "\*\*$mcp_on MCP tools\*\*" specs/002-expense-tracking/spec.md || fail "check 6: specs/002 does not say MCP $mcp_on on"
pt_mcp=$(grep -c 'server\.tool(' modules/portfolio-tracker/src/mcp-server.js)
[ "$pt_mcp" -eq 12 ] || fail "check 6: portfolio MCP count is $pt_mcp, expected 12"
grep -q "12 MCP tools" specs/003-portfolio-tracker/CONTEXT.md || fail "check 6: specs/003 CONTEXT.md does not say 12 MCP tools"

# ---------------------------------------------------------------- check 7
# test.yml job names vs docs/testing.md.
test_jobs=$(awk '/^jobs:/{f=1; next} f && /^    [a-z0-9_-]+:/{n=$1; sub(/:/, "", n); print n} f && /^[^ ]/{exit}' .github/workflows/test.yml)
for job in $test_jobs; do
    grep -q "\`$job\`" docs/testing.md || fail "check 7: docs/testing.md does not list test.yml job $job"
done

# ---------------------------------------------------------------- check 8
# deploy.sh component list vs the doc component lists.
components=$(sed -n '10p' modules/deploy.sh | sed 's/.*One of: //; s/, /\n/g' | tr -d ' ' ; grep -oE 'echo "  [a-z-]+ ' modules/deploy.sh | awk '{print $2}' | tr -d '"')
components=$(printf '%s\n' "$components" | sort -u)
for doc in README.md DEPLOY.md SETUP.md docs/setup.md; do
    line=$(grep -m1 'names:' "$doc" || grep -m1 'Available:' "$doc" || grep -m1 'Choices printed by the script:' "$doc" || true)
    [ -n "$line" ] || { fail "check 8: $doc has no component list"; continue; }
    for comp in $components; do
        has_name "$line" "$comp" || fail "check 8: $doc component list is missing $comp"
    done
done

# ---------------------------------------------------------------- check 9
# deploy.yml detection mapping and mkdir line vs DEPLOY.md / SETUP.md.
grep -qF 'grep -q "^modules/fetch-claude-usage.py"' .github/workflows/deploy.yml || fail "check 9: deploy.yml has no fetch-claude-usage.py rule"
grep -qF "COMPONENTS=\"\$COMPONENTS codex-router\"" .github/workflows/deploy.yml || fail "check 9: deploy.yml fetch-claude-usage.py rule does not map to codex-router"
grep -qF '^(\.github/workflows/deploy\.yml|modules/(docker-compose\.yml|deploy\.sh))$' .github/workflows/deploy.yml || fail "check 9: deploy.yml has no deploy.yml-change rule mapping to codex-router"
grep -qF 'modules/(docker-compose\.yml|deploy\.sh)$' .github/workflows/deploy.yml || fail "check 9: deploy.yml override no longer covers modules/docker-compose.yml and modules/deploy.sh"
grep -qF 'expense-tracker/state' .github/workflows/deploy.yml || fail "check 9: deploy.yml mkdir line does not create expense-tracker/state"
grep -qF 'expense-tracker/state' DEPLOY.md || fail "check 9: DEPLOY.md mkdir list omits expense-tracker/state"
grep -qF 'expense-tracker/state' SETUP.md || fail "check 9: SETUP.md mkdir list omits expense-tracker/state"
grep -q 'fetch-claude-usage.py.*codex-router' DEPLOY.md || fail "check 9: DEPLOY.md step 3 does not document the fetch-claude-usage.py rule"

# --------------------------------------------------------------- check 10
# Absence of retired strings, scoped to named live files only.
grep -qi 'commandcode' modules/hermes/config.yaml && fail "check 10: modules/hermes/config.yaml still mentions commandcode"
grep -q 'commandcode\|COMMANDCODE' modules/deploy.sh && fail "check 10: modules/deploy.sh still mentions commandcode"
grep -q 'COMMANDCODE_API_KEY' docs/troubleshooting.md && fail "check 10: docs/troubleshooting.md still mentions COMMANDCODE_API_KEY"
for doc in design.md modules/expense-tracker/docs/design.md; do
    # A true denial ("There is no `.speckit/` directory") is allowed: count
    # `.speckit/` mentions and subtract the denial sentence's one mention.
    total=$(grep -o '\.speckit/' "$doc" | wc -l)
    allowed=$(grep -o "There is no \`.speckit/\` directory" "$doc" | wc -l)
    [ "$((total - allowed))" -eq 0 ] || fail "check 10: $doc presents a .speckit/ path as an existing location"
done
grep -q 'db\.sqlite' AGENTS.md && fail "check 10: AGENTS.md still cites db.sqlite"
# The constitution's one allowed mention is its denial sentence
# ("There is no `openclaw` service and no `tools_api.py` ...").
const_openclaw=$(grep -io 'openclaw' .specify/memory/constitution.md | wc -l)
const_denial=$(grep -o "There is no \`openclaw\` service" .specify/memory/constitution.md | wc -l)
[ "$((const_openclaw - const_denial))" -eq 0 ] || fail "check 10: constitution.md still has OpenClaw-gateway claims"
grep -q '18789' .specify/memory/constitution.md && fail "check 10: constitution.md still mentions port 18789"
const_tools=$(grep -o 'tools_api.py' .specify/memory/constitution.md | wc -l)
[ "$((const_tools - const_denial))" -eq 0 ] || fail "check 10: constitution.md still mentions tools_api.py"

# --------------------------------------------------------------- check 11
# SPECKIT.md next spec number = max specs/NNN + 1.
max_spec=$(for d in specs/[0-9]*/; do basename "$d"; done | grep -oE '^[0-9]+' | sort -n | tail -1 | sed 's/^0*//')
next_spec=$((max_spec + 1))
stated=$(grep -oE 'next is [0-9]+' SPECKIT.md | grep -oE '[0-9]+')
[ "$stated" = "$(printf '%03d' "$next_spec")" ] || fail "check 11: SPECKIT.md says next is $stated, max spec is $(printf '%03d' "$max_spec") so next is $(printf '%03d' "$next_spec")"

if [ "$status" -eq 0 ]; then
    echo "docs-drift: OK"
fi
exit "$status"
