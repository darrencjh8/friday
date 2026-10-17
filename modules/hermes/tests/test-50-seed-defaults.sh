#!/bin/bash
# Unit tests for 50-seed-defaults cron job seeding.
# Tests that jobs are seeded with proper parsed schedule dicts, not raw strings.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SEED_SCRIPT="$SCRIPT_DIR/../50-seed-defaults"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "=== cron job schedule format ==="

# ------------------------------------------------------------------ helpers --
run_seed_python() {
    # Run a Python snippet from the seed script in isolation.
    # Sets up a temp jobs.json, runs the snippet, and returns the resulting jobs.
    local jobs_path="$TMPDIR/cron/jobs.json"
    mkdir -p "$(dirname "$jobs_path")"
    if [ "${SEED_JOBS_PRIMED:-0}" -eq 0 ]; then
        echo '{"jobs": []}' > "$jobs_path"
        export SEED_JOBS_PRIMED=1
    fi
    python3 -c "$1"
    python3 -c "
import json
with open('$jobs_path') as f:
    data = json.load(f)
jobs = data.get('jobs', data) if isinstance(data, dict) else data
for j in jobs:
    sched = j.get('schedule', {})
    name = j.get('name', '?')
    kind = sched.get('kind', type(sched).__name__) if isinstance(sched, dict) else 'raw_string'
    display = j.get('schedule_display', 'missing')
    print(f'{name}|{kind}|{display}')
"
}

# The real seed block is executed from the seed file (never copied): extract the
# ops-github-token-refresh PYEOF block and run it against the temp jobs path.
extract_seed_block() {
    python3 - "$SEED_SCRIPT" "$TMPDIR" "${1:-# Seed ops-github-token-refresh}" <<'PY'
import re
import sys
seed_path, tmpdir, marker = sys.argv[1], sys.argv[2], sys.argv[3]
content = open(seed_path, encoding="utf-8").read()
pos = content.find(marker)
if pos < 0:
    sys.exit("seed block marker missing: " + marker)
start_tag = "python3 <<'PYEOF' || true\n"
start = content.find(start_tag, pos)
if start < 0:
    start_tag = "python3 <<'PYEOF'\n"
    start = content.find(start_tag, pos)
end_tag = "\nPYEOF"
end = content.find(end_tag, start)
if start < 0 or end < 0:
    sys.exit("seed block boundaries missing for: " + marker)
block = content[start + len(start_tag):end]
print(block.replace("/opt/data/cron/jobs.json", tmpdir + "/cron/jobs.json"))
PY
}

prime_seed_jobs() {
    rm -rf "$TMPDIR/cron"
    export SEED_JOBS_PRIMED=0
}

echo "--- ops-github-token-refresh (from real seed) ---"
prime_seed_jobs
export SEED_JOBS_PRIMED=0
github_auth_snippet="$(extract_seed_block)"
[ -n "$github_auth_snippet" ] || { nope "seed block extracted" "ops-github-token-refresh block missing from $SEED_SCRIPT"; github_auth_snippet=":"; }
run_seed_python "$github_auth_snippet" >/dev/null
job_line=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for job in data.get('jobs', []):
    sched = job.get('schedule', {})
    print(f\"{job.get('name', '?')}|{sched.get('kind', type(sched).__name__)}|{job.get('schedule_display', 'missing')}\")
")
[ -n "$job_line" ] || { nope "seeded job is present" "jobs.json contains no jobs"; job_line="||"; }
name=$(echo "$job_line" | cut -d'|' -f1)
kind=$(echo "$job_line" | cut -d'|' -f2)
display=$(echo "$job_line" | cut -d'|' -f3)

[ "$name" = "ops-github-token-refresh" ] && ok "job name is ops-github-token-refresh" || nope "job name" "got: $name"
[ "$kind" = "interval" ] && ok "schedule kind is interval" || nope "schedule kind" "got: $kind"
[ "$display" = "every 15m" ] && ok "schedule_display is every 15m" || nope "schedule_display" "got: $display"

minutes_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('schedule', {}).get('minutes', 'missing'))
")
[ "$minutes_val" = "15" ] && ok "interval is 15 minutes" || nope "interval minutes" "got: $minutes_val"

cron_script_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('script', 'missing'))
")
[ "$cron_script_val" = "github-auth.sh" ] && ok "script is github-auth.sh" || nope "script" "got: $cron_script_val"

cron_no_agent_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('no_agent', 'missing'))
")
[ "$cron_no_agent_val" = "True" ] && ok "no_agent is True" || nope "no_agent" "got: $cron_no_agent_val"

cron_prompt_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('prompt', 'ABSENT'))
")
[ "$cron_prompt_val" = "ABSENT" ] && ok "no prompt field (zero-token cron)" || nope "no prompt field" "got: $cron_prompt_val"

cron_deliver_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('deliver', 'missing'))
")
[ "$cron_deliver_val" = "local" ] && ok "deliver is local" || nope "deliver" "got: $cron_deliver_val"

# Verify schedule is NOT a raw string
raw_check=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
jobs = data.get('jobs', [])
for j in jobs:
    if isinstance(j.get('schedule'), str):
        print('FAIL: raw string')
        exit(1)
print('OK: parsed dict')
")
[ "$raw_check" = "OK: parsed dict" ] && ok "schedule is dict, not raw string" || nope "schedule is dict" "$raw_check"

echo ""
echo "--- idempotent (no duplicate) ---"
# Re-run the real seed block against the already-seeded file: update-in-place must not append.
export SEED_JOBS_PRIMED=1
run_seed_python "$github_auth_snippet" >/dev/null 2>&1 || true
count=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
jobs = data.get('jobs', [])
print(len(jobs))
")
[ "$count" -eq 1 ] && ok "idempotent: exactly 1 job" || nope "idempotent" "got $count jobs"

echo ""
echo "--- migration: legacy github-auth-refresh 50m becomes the 15m job ---"
# Rename the seeded job to the legacy name/schedule, then run the real block:
# it must rename and reschedule in place, never append a second job.
python3 -c "
import json
path = '$TMPDIR/cron/jobs.json'
with open(path) as f:
    data = json.load(f)
jobs = data.get('jobs', [])
jobs[0]['name'] = 'github-auth-refresh'
jobs[0]['schedule'] = {'kind': 'interval', 'minutes': 50, 'display': 'every 50m'}
jobs[0]['schedule_display'] = 'every 50m'
with open(path, 'w') as f:
    json.dump(data, f)
"
run_seed_python "$(extract_seed_block '# Rename seeded cron jobs')" >/dev/null 2>&1 || true
run_seed_python "$github_auth_snippet" >/dev/null 2>&1 || true
mig_name=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
print(data.get('jobs', [])[0].get('name', 'missing'))
")
mig_minutes=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
print(data.get('jobs', [])[0].get('schedule', {}).get('minutes', 'missing'))
")
mig_count=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
print(len(data.get('jobs', [])))
")
[ "$mig_name" = "ops-github-token-refresh" ] && ok "migration renames legacy job" || nope "migration renames legacy job" "got: $mig_name"
[ "$mig_minutes" = "15" ] && ok "migration reschedules to 15m" || nope "migration reschedules" "got: $mig_minutes"
[ "$mig_count" -eq 1 ] && ok "migration keeps exactly 1 job" || nope "migration job count" "got $mig_count jobs"

echo ""
echo "--- boot precedence: App-first, scoped PAT fallback only when incomplete ---"
# The real seed must prefer the App helper and never invoke PAT login when the
# App triple is present. The fallback PAT arrives as the root-only secret file,
# never as an ambient FRIDAY_PAT environment variable.
boot_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import sys
content = open(sys.argv[1], encoding="utf-8").read()
marker = "Configure gh CLI authentication"
pos = content.find(marker)
print(content[pos:pos+2500] if pos >= 0 else "")
PY
)
echo "$boot_block" | grep -q "GH_APP_ID" || nope "boot: App-first branch" "App condition missing from $SEED_SCRIPT"
echo "$boot_block" | grep -q "github-auth.sh" || nope "boot: App helper invoked" "github-auth.sh missing from boot block"
echo "$boot_block" | grep -q "/run/secrets/friday_pat" || nope "boot: PAT fallback retained" "secret file missing from boot block"
echo "$boot_block" | grep -q 'GH_PAT="$PAT"' || nope "boot: PAT passed to helper" "GH_PAT not forwarded from the secret file"
if echo "$boot_block" | grep -q "FRIDAY_PAT"; then
    nope "boot: PAT is not ambient" "FRIDAY_PAT environment fallback is still present in the boot block"
else
    ok "T-precedence: boot prefers App, scoped PAT fallback only when incomplete"
fi

echo ""
echo "=== memory-backup schedule ==="

# Extract the memory-backup seeding snippet
memory_snippet='
import os, json, uuid, datetime
jobs_path = "/'"$TMPDIR"'/cron/jobs.json"
os.makedirs(os.path.dirname(jobs_path), exist_ok=True)
try:
    with open(jobs_path) as f:
        data = json.load(f)
    jobs = data.get("jobs", []) if isinstance(data, dict) else data
except (FileNotFoundError, json.JSONDecodeError):
    jobs = []
if not any(j.get("name") == "memory-backup" for j in jobs if isinstance(j, dict)):
    jobs.append({
        "id": uuid.uuid4().hex[:12],
        "name": "memory-backup",
        "schedule": {"kind": "interval", "minutes": 360, "display": "every 360m"},
        "schedule_display": "every 360m",
        "prompt": "Run /opt/data/scripts/memory-backup.sh to sync memories to git",
        "script": "memory-backup.sh",
        "no_agent": True,
        "enabled": True,
        "deliver": "local",
        "next_run_at": None,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    })
    with open(jobs_path, "w") as f:
        json.dump({"jobs": jobs, "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}, f, indent=2)
'

# Fresh tempdir for memory backup test
rm -rf "$TMPDIR/cron"
export SEED_JOBS_PRIMED=0
output2=$(run_seed_python "$memory_snippet")
name2=$(echo "$output2" | cut -d'|' -f1)
kind2=$(echo "$output2" | cut -d'|' -f2)

[ "$name2" = "memory-backup" ] && ok "job name" || nope "job name" "got: $name2"
[ "$kind2" = "interval" ] && ok "schedule kind is interval" || nope "schedule kind" "got: $kind2"

# Verify minutes=360
minutes=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('schedule', {}).get('minutes', 'missing'))
")
[ "$minutes" = "360" ] && ok "interval minutes is 360" || nope "interval minutes" "got: $minutes"

echo ""
echo "=== finance-portfolio-sync schedule ==="

# Extract the portfolio sync seeding snippet (no_agent + script, cron kind)
portfolio_snippet='
import os, json, uuid, datetime
jobs_path = "/'"$TMPDIR"'/cron/jobs.json"
os.makedirs(os.path.dirname(jobs_path), exist_ok=True)
try:
    with open(jobs_path) as f:
        data = json.load(f)
    jobs = data.get("jobs", []) if isinstance(data, dict) else data
except (FileNotFoundError, json.JSONDecodeError):
    jobs = []
if not any(j.get("name") == "finance-portfolio-sync" for j in jobs if isinstance(j, dict)):
    jobs.append({
        "id": uuid.uuid4().hex[:12],
        "name": "finance-portfolio-sync",
        "schedule": {"kind": "cron", "expr": "0 12 * * *", "display": "0 12 * * *"},
        "schedule_display": "0 12 * * *",
        "script": "portfolio-sync.sh",
        "no_agent": True,
        "enabled": True,
        "deliver": "local",
        "next_run_at": None,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    })
    with open(jobs_path, "w") as f:
        json.dump({"jobs": jobs, "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}, f, indent=2)
'

rm -rf "$TMPDIR/cron"
export SEED_JOBS_PRIMED=0
output3=$(run_seed_python "$portfolio_snippet")
name3=$(echo "$output3" | cut -d'|' -f1)
kind3=$(echo "$output3" | cut -d'|' -f2)
display3=$(echo "$output3" | cut -d'|' -f3)

[ "$name3" = "finance-portfolio-sync" ] && ok "job name" || nope "job name" "got: $name3"
[ "$kind3" = "cron" ] && ok "schedule kind is cron" || nope "schedule kind" "got: $kind3"
[ "$display3" = "0 12 * * *" ] && ok "schedule display correct" || nope "schedule display" "got: $display3"

expr_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('schedule', {}).get('expr', 'missing'))
")
[ "$expr_val" = "0 12 * * *" ] && ok "cron expr is correct" || nope "cron expr" "got: $expr_val"

echo ""
echo "=== finance-portfolio-sync no_agent config ==="

# Verify no_agent is True
no_agent_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('no_agent', 'missing'))
")
[ "$no_agent_val" = "True" ] && ok "no_agent is True" || nope "no_agent" "got: $no_agent_val"

# Verify script is portfolio-sync.sh
script_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('script', 'missing'))
")
[ "$script_val" = "portfolio-sync.sh" ] && ok "script is portfolio-sync.sh" || nope "script" "got: $script_val"

# Verify deliver is local
deliver_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('deliver', 'missing'))
")
[ "$deliver_val" = "local" ] && ok "deliver is local" || nope "deliver" "got: $deliver_val"

# Verify no prompt field (no LLM agent)
prompt_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('prompt', 'ABSENT'))
")
[ "$prompt_val" = "ABSENT" ] && ok "no prompt field (zero-token cron)" || nope "no prompt field" "got: $prompt_val"

# Verify no deliver_extra field
deliver_extra_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('deliver_extra', 'ABSENT'))
")
[ "$deliver_extra_val" = "ABSENT" ] && ok "no deliver_extra field" || nope "no deliver_extra field" "got: $deliver_extra_val"

echo ""
echo "=== finance-portfolio-sync schedule integrity ==="

# Verify schedule is still cron with correct expr
rm -rf "$TMPDIR/cron"
export SEED_JOBS_PRIMED=0
output_ps=$(run_seed_python "$portfolio_snippet")
name_ps=$(echo "$output_ps" | cut -d'|' -f1)
kind_ps=$(echo "$output_ps" | cut -d'|' -f2)
display_ps=$(echo "$output_ps" | cut -d'|' -f3)

[ "$name_ps" = "finance-portfolio-sync" ] && ok "schedule: job name correct" || nope "schedule: job name" "got: $name_ps"
[ "$kind_ps" = "cron" ] && ok "schedule: kind is cron" || nope "schedule: kind" "got: $kind_ps"
[ "$display_ps" = "0 12 * * *" ] && ok "schedule: display correct" || nope "schedule: display" "got: $display_ps"

expr_ps=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('schedule', {}).get('expr', 'missing'))
")
[ "$expr_ps" = "0 12 * * *" ] && ok "schedule: cron expr is 0 12 * * *" || nope "schedule: cron expr" "got: $expr_ps"

# Verify job is enabled
enabled_ps=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('enabled', 'missing'))
")
[ "$enabled_ps" = "True" ] && ok "job is enabled" || nope "job enabled" "got: $enabled_ps"

echo ""
echo "=== finance-portfolio-sync seed script integrity ==="

# Verify the portfolio block specifically rather than the first PYEOF block
# (the first block is now ops-github-token-refresh).
portfolio_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import sys
content = open(sys.argv[1], encoding="utf-8").read()
marker = "# Seed finance-portfolio-sync cron job"
pos = content.find(marker)
start_tag = "python3 <<'PYEOF' || true\n"
start = content.find(start_tag, pos)
end = content.find("\nPYEOF", start)
print(content[start + len(start_tag):end] if pos >= 0 and start >= 0 and end >= 0 else "")
PY
)
[ -n "$portfolio_block" ] && ok "seed: portfolio block found" || nope "seed: portfolio block" "not found"
echo "$portfolio_block" | grep -q '"no_agent": True' && ok "seed: has no_agent field" || nope "seed: has no_agent field" "missing"
echo "$portfolio_block" | grep -q 'portfolio-sync.sh' && ok "seed: has script portfolio-sync.sh" || nope "seed: has script portfolio-sync.sh" "missing"
portfolio_prompt=$(printf '%s\n' "$portfolio_block" | grep -E '^[[:space:]]+"prompt"[[:space:]]*:' || true)
if [ -n "$portfolio_prompt" ]; then
    nope "seed: no prompt (zero-token)" "prompt present"
else
    ok "seed: no prompt (zero-token)"
fi
echo "$portfolio_block" | grep -q '"deliver": "local"' && ok "seed: deliver is local" || nope "seed: deliver is local" "missing"

echo ""
echo "=== retired profile migration ==="
retired_profiles=$(python3 -c "
import re
with open('$SEED_SCRIPT') as f:
    content = f.read()
match = re.search(r'for retired_profile in (.*?); do(.*?)done', content, re.DOTALL)
if not match:
    print('missing')
else:
    names = match.group(1) + match.group(2)
    expected = ('static-analyst', 'qa-engineer', 'quality-assurance')
    print('present' if all(name in names for name in expected) else 'incomplete')
")
[ "$retired_profiles" = "present" ] && ok "retired profiles are removed on startup" || nope "retired profile migration" "got: $retired_profiles"

code_reviewer_seed=$(python3 -c "
import re
with open('$SEED_SCRIPT') as f:
    content = f.read()
print('present' if 'hermes profile create \$name --no-alias' in content else 'missing')
")
[ "$code_reviewer_seed" = "present" ] && ok "remaining profiles are registered on startup" || nope "profile registration" "got: $code_reviewer_seed"

# `hermes profile create` raises "A profile named ... already exists" for any directory that
# already carries an identity marker, and the seed copies write config.yaml/SOUL.md/profile.yaml
# before this call, so registration must be guarded by that same predicate.
profile_registration_guard=$(python3 -c "
import re
with open('$SEED_SCRIPT') as f:
    content = f.read()
guard = re.search(
    r'for marker in config\.yaml \.env SOUL\.md profile\.yaml auth\.json state\.db; do'
    r'.*?if \[ \"[$]identity\" -eq 0 \]; then\s*\n\s*su -s /bin/sh hermes -c \"hermes profile create [$]name --no-alias\"',
    content, re.DOTALL)
print('present' if guard else 'missing')
")
[ "$profile_registration_guard" = "present" ] && ok "profile registration is skipped when the profile already exists" || nope "profile registration guard" "got: $profile_registration_guard"

managed_routing_migration=$(python3 -c "
with open('$SEED_SCRIPT') as f:
    content = f.read()
profiles = 'managed_routing_profiles = (\"code-reviewer\",)' in content
fields = 'for key in (\"providers\", \"model\", \"fallback_providers\")' in content
reviewer_isolation = 'if not isinstance(memory, dict):' in content and 'memory[\"memory_enabled\"] = False' in content and 'memory[\"user_profile_enabled\"] = False' in content
print('present' if profiles and fields and reviewer_isolation else 'missing')
")
[ "$managed_routing_migration" = "present" ] && ok "managed profile routing and reviewer isolation migrate on startup" || nope "managed profile migration" "got: $managed_routing_migration"

echo ""
echo "=== default profile display name ==="

# `default` is the implicit root profile (its home IS HERMES_HOME=/opt/data), and
# every path, cron profile field, and skills dir keys off that canonical id — so
# it must never be renamed. The friendly label is profile.yaml display_name, which
# is presentation-only. Seeded on boot, but an operator-set name wins.
display_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import sys
content = open(sys.argv[1], encoding="utf-8").read()
marker = "SEED_DEFAULT_PROFILE_DISPLAY_NAME"
pos = content.find(marker)
if pos < 0:
    print(""); raise SystemExit
start_tag = "python3 <<'PYEOF' || true\n"
start = content.rfind(start_tag, 0, pos)
if start < 0:
    print(""); raise SystemExit
body = content[start + len(start_tag):]
end = body.find("\nPYEOF")
print(body[:end] if end >= 0 else "")
PY
)
[ -n "$display_block" ] && ok "seed has a default profile display-name block" || nope "display-name block" "not found"

# The id must stay 'default': a rename would break every stored path and cron
# profile field, so the seed must not invoke the rename path for the id itself.
if printf '%s\n' "$display_block" | grep -qE 'hermes profile rename default'; then
    nope "default id is not renamed" "seed renames the default profile id"
else
    ok "default id is not renamed (display name only)"
fi

rm -rf "$TMPDIR/profhome"
mkdir -p "$TMPDIR/profhome"
display_block_tmp=${display_block//\/opt\/data\/profile.yaml/$TMPDIR\/profhome\/profile.yaml}
display_run=$(python3 -c "$display_block_tmp" 2>&1)

display_meta=$(python3 - "/tmp/unused" "$TMPDIR/profhome/profile.yaml" <<'PY'
import sys
path = sys.argv[2]
try:
    import yaml
    data = yaml.safe_load(open(path).read()) or {}
except FileNotFoundError:
    data = None
print("missing" if data is None else str(data.get("display_name") or ""))
PY
)
[ "$display_meta" = "friday" ] && ok "fresh host: display name seeded as 'friday'" || nope "display name seed" "got: $display_meta"

# Idempotent: a second boot must not churn the file.
python3 -c "$display_block_tmp" >/dev/null 2>&1
display_meta2=$(python3 - "$TMPDIR/profhome/profile.yaml" <<'PY'
import sys, yaml
try:
    data = yaml.safe_load(open(sys.argv[1]).read()) or {}
except FileNotFoundError:
    data = {}
print(str(data.get("display_name") or ""))
PY
)
[ "$display_meta2" = "friday" ] && ok "idempotent: display name still 'friday' on re-seed" || nope "display name idempotent" "got: $display_meta2"

# An operator-set name is a user decision, not a managed default.
python3 - "$TMPDIR/profhome/profile.yaml" <<'PY'
import sys, yaml
p = sys.argv[1]
data = yaml.safe_load(open(p).read()) or {}
data["display_name"] = "not-friday"
open(p, "w").write(yaml.safe_dump(data, sort_keys=False))
PY
python3 -c "$display_block_tmp" >/dev/null 2>&1
display_meta3=$(python3 - "$TMPDIR/profhome/profile.yaml" <<'PY'
import sys, yaml
try:
    data = yaml.safe_load(open(sys.argv[1]).read()) or {}
except FileNotFoundError:
    data = {}
print(str(data.get("display_name") or ""))
PY
)
[ "$display_meta3" = "not-friday" ] && ok "operator-set display name is preserved" || nope "display name preserved" "got: $display_meta3"

# Other profile.yaml fields must survive the seed.
python3 - "$TMPDIR/profhome/profile.yaml" <<'PY'
import sys, yaml
p = sys.argv[1]
data = yaml.safe_load(open(p).read()) or {}
data["description"] = "operator description"
data["display_name"] = ""
open(p, "w").write(yaml.safe_dump(data, sort_keys=False))
PY
python3 -c "$display_block_tmp" >/dev/null 2>&1
display_kept=$(python3 - "$TMPDIR/profhome/profile.yaml" <<'PY'
import sys, yaml
data = yaml.safe_load(open(sys.argv[1]).read()) or {}
print("ok" if data.get("description") == "operator description" and data.get("display_name") == "friday" else "fail")
PY
)
[ "$display_kept" = "ok" ] && ok "seed fills an empty display name and keeps other fields" || nope "display name merge" "got: $display_kept"


echo "=== wiki-finance-refresh cron seeding ==="

# The wiki job must be seeded with MANAGED prompt/skills and telegram delivery
# for new installs; existing installs receive prompt/skill migration only.
wiki_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import sys
content = open(sys.argv[1], encoding="utf-8").read()
marker = "\"name\": \"wiki-finance-refresh\""
pos = content.find(marker)
if pos < 0:
    print(""); raise SystemExit
start_tag = "python3 <<'PYEOF' || true\n"
# Anchor on the "name" assignment INSIDE the block (unique), then walk BACK to
# the block start. (The bare job name also appears in the comment line above the
# block and four more times inside the block itself.)
start = content.rfind(start_tag, 0, pos)
block = content[start + len(start_tag):]
end = block.find("\nPYEOF")
print(block[:end] if end >= 0 else "")
PY
)
[ -n "$wiki_block" ] && ok "seed has a wiki-finance-refresh PYEOF block" || nope "wiki block" "not found"

rm -rf "$TMPDIR/wikicron"
mkdir -p "$TMPDIR/wikicron"
echo '{"jobs": []}' > "$TMPDIR/wikicron/jobs.json"
wiki_block_tmp=${wiki_block//\/opt\/data\/cron\/jobs.json/$TMPDIR\/wikicron\/jobs.json}
python3 -c "$wiki_block_tmp" >/dev/null 2>&1

wiki_fields=$(python3 - "$TMPDIR/wikicron/jobs.json" <<'PY'
import json, sys
jobs = json.load(open(sys.argv[1]))["jobs"]
if len(jobs) != 1:
    print("fail count=%d" % len(jobs)); sys.exit()
j = jobs[0]
sched = j.get("schedule", {})
prompt = j.get("prompt") or ""
checks = {
    "name": j.get("name") == "wiki-finance-refresh",
    "kind": sched.get("kind") == "cron",
    "expr": sched.get("expr") == "0 4 * * 1",
    "display": j.get("schedule_display") == "every monday 4am",
    "enabled": j.get("enabled") is True,
    "deliver": j.get("deliver") == "telegram",
    "skills": j.get("skills") == ["llm-wiki", "expense-tracker", "notion", "notion-pitfalls", "cron-job-inspection", "portfolio-tracker"],
    "skill": j.get("skill") == "llm-wiki",
    "prompt_len": len(prompt) > 500,
    "raw_snapshot": "dated raw file" in prompt,
    "sha": "SHA-256" in prompt,
    "telegram_report": "Telegram" in prompt,
    "wiki_path_env": "WIKI_PATH" in prompt,
    "notion_accounts": "a21b499b-79ae-497b-9221-0ad59a75e812" in prompt,
    "notion_plans": "fb21acfd-b555-4a99-8b54-54ed43d4b020" in prompt,
    "portfolio_readonly": "portfolio_taxonomy" in prompt and "portfolio_sync" in prompt,
    "mnemosyne": "Mnemosyne" in prompt,
    # Regression: the prompt must not require MCP recall for memory (GH #764).
    # skip_contexts cron makes the recall tools answer `memory_unavailable` in
    # every cron session, so the run degraded every week. The prompt must point
    # at the read-only DB projection instead.
    "mnemosyne_cron_design": "skip_contexts" in prompt and "mnemosyne.db" in prompt,
    "completeness": "has_more" in prompt,
    "field_authority": "user correction" in prompt.lower(),
    "audit_artifact": "audit" in prompt.lower(),
    # Sources are captured by the pre-run script, not one tool call per turn.
    "snapshot_script": j.get("script") == "wiki-source-snapshot.py",
    "only_changed": "Read only the files marked changed" in prompt,
    "digest_table": "| Area | Change | Since |" in prompt,
    # Weekly digest carries only actionable lines, never "all good" reassurances.
    "digest_actionable_only": "leave out passing checks" in prompt and "ending with the lint result" not in prompt,
    # Repos and GitHub issues moved to wiki-repo-docs.
    "repos_split": "wiki-repo-docs" in prompt and "git fetch" not in prompt and "Fetch (do not checkout" not in prompt,
}
bad = [k for k, v in checks.items() if not v]
print("pass" if not bad else "fail " + repr(bad))
PY
)
case "$wiki_fields" in
    pass) ok "job: cron 0 4 * * 1 monday · telegram · llm-wiki skill set · full refresh prompt" ;;
    *) nope "wiki fields" "$wiki_fields" ;;
esac

# Idempotency: re-running the block must not duplicate the job.
python3 -c "$wiki_block_tmp" >/dev/null 2>&1
wiki2=$(python3 -c "import json;print(len(json.load(open('$TMPDIR/wikicron/jobs.json'))['jobs']))")
[ "$wiki2" = "1" ] && ok "idempotent: still 1 job on re-seed" || nope "wiki idempotent" "got $wiki2"

# Migration: an existing install keeps schedule/enabled/deliver and only
# receives the MANAGED prompt/skill update.
rm -rf "$TMPDIR/wikicron-legacy"
mkdir -p "$TMPDIR/wikicron-legacy"
python3 - "$TMPDIR/wikicron-legacy/jobs.json" <<'PY'
import json, sys
json.dump({"jobs": [{
    "id": "wikilegacy1",
    "name": "wiki-finance-refresh",
    "prompt": "legacy wiki prompt",
    "skills": ["llm-wiki"],
    "skill": "llm-wiki",
    "schedule": {"kind": "cron", "expr": "0 10 * * 2", "display": "custom"},
    "schedule_display": "custom",
    "enabled": False,
    "deliver": "origin",
    "context_from": ["self"],
    "created_at": "2026-01-01T00:00:00+00:00",
    "user_note": "keep me",
}]}, open(sys.argv[1], "w"))
PY
wiki_legacy_tmp=${wiki_block//\/opt\/data\/cron\/jobs.json/$TMPDIR\/wikicron-legacy\/jobs.json}
wiki_migrate_out=$(python3 -c "$wiki_legacy_tmp" 2>&1)
wiki_migrate=$(python3 - "$TMPDIR/wikicron-legacy/jobs.json" <<'PY'
import json, sys
jobs = json.load(open(sys.argv[1]))["jobs"]
if len(jobs) != 1:
    print("fail count=%d" % len(jobs)); sys.exit()
j = jobs[0]
prompt = j.get("prompt") or ""
checks = {
    "id_preserved": j.get("id") == "wikilegacy1",
    "user_field_preserved": j.get("user_note") == "keep me",
    "prompt_updated": "dated raw file" in prompt,
    "skills_updated": j.get("skills") == ["llm-wiki", "expense-tracker", "notion", "notion-pitfalls", "cron-job-inspection", "portfolio-tracker"],
    "schedule_not_reverted": j.get("schedule_display") == "custom",
    "disabled_stays_disabled": j.get("enabled") is False,
    "deliver_not_reverted": j.get("deliver") == "origin",
}
bad = [k for k, v in checks.items() if not v]
print("pass" if not bad else "fail " + repr(bad))
PY
)
case "$wiki_migrate" in
    pass) ok "existing job migrated in place (prompt/skills only; schedule/enabled/deliver/user fields preserved)" ;;
    *) nope "wiki migration" "$wiki_migrate" ;;
esac
case "$wiki_migrate_out" in
    *migrated*) ok "wiki migration is reported" ;;
    *) nope "wiki migration report" "got: $wiki_migrate_out" ;;
esac

echo "=== wiki-repo-docs cron seeding ==="

repos_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import sys
content = open(sys.argv[1], encoding="utf-8").read()
pos = content.find("\"name\": \"wiki-repo-docs\"")
start_tag = "python3 <<'PYEOF' || true\n"
start = content.rfind(start_tag, 0, pos) if pos >= 0 else -1
block = content[start + len(start_tag):] if start >= 0 else ""
end = block.find("\nPYEOF")
print(block[:end] if end >= 0 else "")
PY
)
rm -rf "$TMPDIR/reposcron"; mkdir -p "$TMPDIR/reposcron"
echo '{"jobs": []}' > "$TMPDIR/reposcron/jobs.json"
python3 -c "${repos_block//\/opt\/data\/cron\/jobs.json/$TMPDIR\/reposcron\/jobs.json}" >/dev/null 2>&1
repos_fields=$(python3 - "$TMPDIR/reposcron/jobs.json" <<'PY'
import json, sys
jobs = json.load(open(sys.argv[1]))["jobs"]
if len(jobs) != 1:
    print("fail count=%d" % len(jobs)); sys.exit()
j = jobs[0]
prompt = j.get("prompt") or ""
checks = {
    "name": j.get("name") == "wiki-repo-docs",
    # Must finish before the 04:00 maintenance run reads its snapshot.
    "expr": j.get("schedule", {}).get("expr") == "30 3 * * 1",
    "deliver": j.get("deliver") == "telegram",
    "skills": j.get("skills") == ["llm-wiki", "github-issues", "docs-accuracy-verification"],
    "repos": all(r in prompt for r in ("friday", "codex-router", "friday-memory")),
    "issue_dedupe": "Do not file duplicates" in prompt,
    "silent": "reply exactly [SILENT]" in prompt,
}
bad = [k for k, v in checks.items() if not v]
print("pass" if not bad else "fail " + repr(bad))
PY
)
case "$repos_fields" in
    pass) ok "repos job: monday 03:30 · telegram · silent unless an issue was filed or a fetch failed" ;;
    *) nope "repos fields" "$repos_fields" ;;
esac

echo "=== wiki-due-reminders cron seeding ==="

# A weekly cadence cannot honour lead-time reminders (e.g. claim miles ~2 months
# before renewal), so a daily notifier is seeded alongside the weekly audit.
daily_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import sys
content = open(sys.argv[1], encoding="utf-8").read()
marker = "\"name\": \"wiki-due-reminders\""
pos = content.find(marker)
if pos < 0:
    print(""); raise SystemExit
start_tag = "python3 <<'PYEOF' || true\n"
# Same anchor rule as the weekly extractor: the "name" assignment is unique to
# the block body; walk BACK to the block start.
start = content.rfind(start_tag, 0, pos)
block = content[start + len(start_tag):]
end = block.find("\nPYEOF")
print(block[:end] if end >= 0 else "")
PY
)
[ -n "$daily_block" ] && ok "seed has a wiki-due-reminders PYEOF block" || nope "daily block" "not found"

rm -rf "$TMPDIR/wikidaily"
mkdir -p "$TMPDIR/wikidaily"
echo '{"jobs": []}' > "$TMPDIR/wikidaily/jobs.json"
daily_block_tmp=${daily_block//\/opt\/data\/cron\/jobs.json/$TMPDIR\/wikidaily\/jobs.json}
python3 -c "$daily_block_tmp" >/dev/null 2>&1

daily_fields=$(python3 - "$TMPDIR/wikidaily/jobs.json" <<'PY'
import json, sys
jobs = json.load(open(sys.argv[1]))["jobs"]
if len(jobs) != 1:
    print("fail count=%d" % len(jobs)); sys.exit()
j = jobs[0]
sched = j.get("schedule", {})
prompt = j.get("prompt") or ""
checks = {
    "name": j.get("name") == "wiki-due-reminders",
    "kind": sched.get("kind") == "cron",
    "expr": sched.get("expr") == "15 8 * * *",
    "enabled": j.get("enabled") is True,
    "deliver": j.get("deliver") == "telegram",
    "prompt_len": len(prompt) > 300,
    "lead_time": "lead_days" in prompt,
    "dedupe": "already-notified" in prompt,
    "planned_list": "Planned" in prompt,
    "helper": "wiki-reminder-tasks.py" in prompt,
    "marker": "wiki-reminder-marker:" in prompt,
    "stale_close": "auto-closes stale open daily-habit tasks" in prompt,
    "snapshot": "--snapshot-out" in prompt,
    "habits": "daily-habits" in prompt,
    "silent_rule": "[SILENT]" in prompt,
    "skills": "gtasks-cli" in (j.get("skills") or []),
}
bad = [k for k, v in checks.items() if not v]
print("pass" if not bad else "fail " + repr(bad))
PY
)
case "$daily_fields" in
    pass) ok "job: cron 15 8 * * * daily · telegram · lead-time reminders" ;;
    *) nope "daily fields" "$daily_fields" ;;
esac

# Idempotency: re-running the daily block must not duplicate the job.
python3 -c "$daily_block_tmp" >/dev/null 2>&1
daily2=$(python3 -c "import json;print(len(json.load(open('$TMPDIR/wikidaily/jobs.json'))['jobs']))")
[ "$daily2" = "1" ] && ok "idempotent: still 1 daily job on re-seed" || nope "daily idempotent" "got $daily2"

# Migration: an existing install keeps its schedule/enabled/deliver.
rm -rf "$TMPDIR/wikidaily-legacy"
mkdir -p "$TMPDIR/wikidaily-legacy"
python3 - "$TMPDIR/wikidaily-legacy/jobs.json" <<'PY'
import json, sys
json.dump({"jobs": [{
    "id": "wikidailylegacy1",
    "name": "wiki-due-reminders",
    "prompt": "legacy daily prompt",
    "skills": ["llm-wiki"],
    "schedule": {"kind": "cron", "expr": "0 12 * * *", "display": "custom"},
    "schedule_display": "custom",
    "enabled": False,
    "deliver": "local",
    "context_from": ["self"],
    "created_at": "2026-01-01T00:00:00+00:00",
    "user_note": "keep me too",
}]}, open(sys.argv[1], "w"))
PY
daily_legacy_tmp=${daily_block//\/opt\/data\/cron\/jobs.json/$TMPDIR\/wikidaily-legacy\/jobs.json}
daily_migrate_out=$(python3 -c "$daily_legacy_tmp" 2>&1)
daily_migrate=$(python3 - "$TMPDIR/wikidaily-legacy/jobs.json" <<'PY'
import json, sys
jobs = json.load(open(sys.argv[1]))["jobs"]
if len(jobs) != 1:
    print("fail count=%d" % len(jobs)); sys.exit()
j = jobs[0]
prompt = j.get("prompt") or ""
checks = {
    "id_preserved": j.get("id") == "wikidailylegacy1",
    "user_field_preserved": j.get("user_note") == "keep me too",
    "prompt_updated": "lead_days" in prompt,
    "schedule_not_reverted": j.get("schedule_display") == "custom",
    "disabled_stays_disabled": j.get("enabled") is False,
    "deliver_not_reverted": j.get("deliver") == "local",
}
bad = [k for k, v in checks.items() if not v]
print("pass" if not bad else "fail " + repr(bad))
PY
)
case "$daily_migrate" in
    pass) ok "existing daily job migrated in place (prompt/skills only; schedule/enabled/deliver/user fields preserved)" ;;
    *) nope "daily migration" "$daily_migrate" ;;
esac

echo ""

if ! python3 -c 'import yaml' >/dev/null 2>&1; then
    echo "  SKIP YAML-backed seed merge tests (PyYAML unavailable)"
    echo ""
    echo "========================================="
    echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
    echo "========================================="
    [ "$fail" -eq 0 ]
    exit $?
fi

migration_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import re
import sys

content = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"# Migrate only routing fields.*?python3 - <<'PY'\n(.*?)\nPY\n", content, re.DOTALL)
print(match.group(1) if match else "")
PY
)
migration_defaults="$TMPDIR/hermes-defaults/profiles/code-reviewer"
migration_target="$TMPDIR/data/profiles/code-reviewer"
mkdir -p "$migration_defaults" "$migration_target"
cp "$SCRIPT_DIR/../profiles/code-reviewer/config.yaml" "$migration_defaults/config.yaml"
cat > "$migration_target/config.yaml" <<'YAML'
model:
  provider: stale
  default: stale
fallback_providers:
  - provider: stale
agent:
  reasoning_effort: low
  disabled_toolsets:
    - user-owned
    - moa
memory:
  memory_enabled: true
  user_profile_enabled: true
approvals:
  mode: custom-preserved
platforms:
  email_intake:
    enabled: true
  telegram:
    enabled: true
mcp_servers:
  ktmb-booking:
    url: http://ktmb-booking:8082/mcp
  expense-tracker:
    url: http://expense-tracker:8080/mcp
YAML
migration_block=${migration_block//\/opt\/data/$TMPDIR/data}
migration_block=${migration_block//\/opt\/hermes-defaults/$TMPDIR/hermes-defaults}
python3 -c "$migration_block"
migration_result=$(python3 - "$migration_target/config.yaml" <<'PY'
import sys
import yaml

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
isolated = config["memory"]["memory_enabled"] is False and config["memory"]["user_profile_enabled"] is False
preserved = config["approvals"]["mode"] == "custom-preserved"
routed = config["model"] == {
    "provider": "custom:codex-router",
    "default": "auto-thinking",
}
escalating = config["fallback_providers"] == [
    {"provider": "deepseek", "model": "deepseek-flash"}
]
# The stale profile carries reasoning_effort low; the baked profile pins high. The
# effort must migrate, and the profile's own agent keys must survive it, or a
# bumped effort stays on disk at its old value and the change never takes effect.
effort = config["agent"]["reasoning_effort"] == "high"
# moa is no longer disabled anywhere: the migration drops it from the live
# profile while the operator's own entry survives.
agent_preserved = config["agent"]["disabled_toolsets"] == ["user-owned"]
# A retired MCP server (ktmb-booking) must leave the live profile file, or its
# connection fails on every boot; a server the profile still ships must stay.
servers = config.get("mcp_servers") or {}
retired_dropped = "ktmb-booking" not in servers
live_kept = "expense-tracker" in servers
# Email intake is env-enabled in every profile scope, so the stale live file
# carries it enabled; the migration must pin it off while leaving a sibling
# platform entry the operator owns untouched.
platforms = config.get("platforms") or {}
intake = platforms.get("email_intake") or {}
intake_off = intake.get("enabled") is False
sibling_kept = (platforms.get("telegram") or {}).get("enabled") is True
print("pass" if isolated and preserved and routed and escalating and effort and agent_preserved and retired_dropped and live_kept and intake_off and sibling_kept else "fail")
PY
)
if [ "$migration_result" = "pass" ]; then
    ok "existing reviewer profile migrates to isolated round routing"
else
    nope "reviewer isolation fixture" "got: $migration_result"
fi
cat > "$migration_target/config.yaml" <<'YAML'
model:
  provider: stale
  default: stale
fallback_providers:
  - provider: stale
agent:
  reasoning_effort: low
memory:
approvals:
  mode: custom-preserved
YAML
null_memory_output=$(python3 -c "$migration_block" 2>&1) || null_memory_status=$?
null_memory_status=${null_memory_status:-0}
null_memory_result=$(python3 - "$migration_target/config.yaml" <<'PY'
import sys
import yaml

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
memory = config.get("memory")
isolated = isinstance(memory, dict) and memory.get("memory_enabled") is False and memory.get("user_profile_enabled") is False
preserved = config["approvals"]["mode"] == "custom-preserved"
routed = config["model"] == {
    "provider": "custom:codex-router",
    "default": "auto-thinking",
}
escalating = config["fallback_providers"] == [
    {"provider": "deepseek", "model": "deepseek-flash"}
]
effort = config["agent"]["reasoning_effort"] == "high"
print("pass" if isolated and preserved and routed and escalating and effort else "fail")
PY
)
if [ "$null_memory_status" -eq 0 ] && [ "$null_memory_result" = "pass" ]; then
    ok "null reviewer memory migrates safely"
else
    nope "null reviewer memory migration" "status=$null_memory_status result=$null_memory_result output=$null_memory_output"
fi

# moa is no longer disabled anywhere: the migration drops it from a live
# profile's disabled_toolsets. A lone moa leaves no empty key behind; a moa
# beside an operator-owned entry keeps that entry.
cat > "$migration_target/config.yaml" <<'YAML'
model:
  provider: stale
  default: stale
fallback_providers:
  - provider: stale
agent:
  reasoning_effort: low
  disabled_toolsets:
    - moa
memory:
  memory_enabled: true
YAML
moa_status=0
moa_output=$(python3 -c "$migration_block" 2>&1) || moa_status=$?
moa_result=$(python3 - "$migration_target/config.yaml" <<'PY'
import sys
import yaml

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
agent = config.get("agent") or {}
print("pass" if "disabled_toolsets" not in agent and agent.get("reasoning_effort") == "high" else "fail")
PY
)
if [ "$moa_status" -eq 0 ] && [ "$moa_result" = "pass" ]; then
    ok "lone moa disable is dropped without leaving an empty key"
else
    nope "lone moa disable migration" "status=$moa_status result=$moa_result output=$moa_output"
fi

# A scalar, null, list or absent `agent` block must not crash the boot migration
# (the isinstance(agent, dict) guard) and must still end up pinned to high.
for agent_shape in 'agent: scalar-string' 'agent:' 'agent: [a, b]' 'unrelated: true'; do
    cat > "$migration_target/config.yaml" <<YAML
model:
  provider: stale
$agent_shape
YAML
    agent_status=0
    agent_output=$(python3 -c "$migration_block" 2>&1) || agent_status=$?
    agent_result=$(python3 - "$migration_target/config.yaml" <<'PY'
import sys
import yaml

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
agent = config.get("agent")
print("pass" if isinstance(agent, dict) and agent.get("reasoning_effort") == "high" else "fail")
PY
)
    if [ "$agent_status" -eq 0 ] && [ "$agent_result" = "pass" ]; then
        ok "malformed agent block migrates safely ($agent_shape)"
    else
        nope "malformed agent block ($agent_shape)" "status=$agent_status result=$agent_result output=$agent_output"
    fi
done

echo ""
echo "=== hermes config seeding ==="

# The seed script merges the baked canonical config into the live data dir: the
# baked file owns every key it defines, and a runtime-installed top-level key it
# does not define (codex-router's `hooks:`) survives. Run the real merge block
# against fixtures and parse the MERGED file, so the assertions fail if the
# seeded output loses either the compaction keys or a runtime-installed hook.
seed_merge_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import re
import sys

with open(sys.argv[1]) as f:
    content = f.read()
match = re.search(r"<<'PYCONFIG'[^\n]*\n(.*?)\nPYCONFIG", content, re.DOTALL)
print(match.group(1) if match else "")
PY
)
[ -n "$seed_merge_block" ] \
    && ok "seed: has a config merge block" \
    || nope "seed: config merge block" "PYCONFIG block missing from $SEED_SCRIPT"

mkdir -p "$TMPDIR/seed/hermes-defaults" "$TMPDIR/seed/data"
cp "$SCRIPT_DIR/../config.yaml" "$TMPDIR/seed/hermes-defaults/config.yaml"
seed_config="$TMPDIR/seed/data/config.yaml"

# Live fixture: runtime-installed and hand-added top-level keys the baked config
# does not define, plus a drifted managed key the baked config must override.
cat > "$seed_config" <<'EOF'
hooks:
  pre_llm_call:
    - event: pre_llm_call
      command: /opt/data/agent-hooks/remind-worktree.sh
hooks_auto_accept: true
compression:
    threshold: 0.50
    threshold_tokens: 1
EOF

seed_ran=missing
if [ -n "$seed_merge_block" ]; then
    printf '%s\n' "$seed_merge_block" > "$TMPDIR/seed/merge.py"
    if python3 - "$TMPDIR/seed/hermes-defaults/config.yaml" "$seed_config" < "$TMPDIR/seed/merge.py"; then
        seed_ran=ok
    else
        seed_ran=failed
    fi
fi
[ "$seed_ran" = "ok" ] \
    && ok "seed: config merge block runs against a live config" \
    || nope "seed: config merge block runs" "status=$seed_ran"

seeded_hook=$(python3 - "$seed_config" <<'PY'
import sys
import yaml

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
hooks = config.get("hooks") or {}
entries = hooks.get("pre_llm_call") or []
command = entries[0].get("command", "") if entries and isinstance(entries[0], dict) else ""
print(command)
PY
)
if [ "$seed_ran" = "ok" ] && [ "$seeded_hook" = "/opt/data/agent-hooks/remind-worktree.sh" ]; then
    ok "config: runtime-installed hooks.pre_llm_call survives the seed"
else
    nope "seed preserves hooks.pre_llm_call" "status=$seed_ran got '$seeded_hook'"
fi

seeded_auto_accept=$(python3 - "$seed_config" <<'PY'
import sys

try:
    import yaml
except ModuleNotFoundError:
    print("SKIP_PYYAML")
    raise SystemExit(0)

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
print(config.get("hooks_auto_accept"))
PY
)
if [ "$seed_ran" = "ok" ] && [ "$seeded_auto_accept" = "True" ]; then
    ok "config: other unknown top-level keys survive the seed"
else
    nope "seed preserves unknown top-level keys" "status=$seed_ran got '$seeded_auto_accept'"
fi

# A failing merge must never fall back to the raw copy that caused #461: an
# existing live config stays untouched, and only a missing file is bootstrapped.
seed_fallback=$(python3 - "$SEED_SCRIPT" <<'PY'
import re
import sys

with open(sys.argv[1]) as f:
    content = f.read()
match = re.search(
    r"(if \[ -f /opt/data/config\.yaml \]; then\n    su -s /bin/sh hermes -c '(?:PYTHONPATH=\S+ )?python3 - /opt/hermes-defaults/config\.yaml /opt/data/config\.yaml' <<'PYCONFIG'.*?\nPYCONFIG\nelse\n    cp /opt/hermes-defaults/config\.yaml /opt/data/config\.yaml\nfi)",
    content,
    re.DOTALL,
)
print(match.group(1) if match else "")
PY
)
mkdir -p "$TMPDIR/fallback/bin" "$TMPDIR/fallback/data"
printf '#!/bin/sh\nexit 1\n' > "$TMPDIR/fallback/bin/python3"
chmod +x "$TMPDIR/fallback/bin/python3"
if [ -n "$seed_fallback" ]; then
    seed_fallback=${seed_fallback//\/opt\/data/$TMPDIR/fallback/data}
    seed_fallback=${seed_fallback//\/opt\/hermes-defaults/$TMPDIR/seed/hermes-defaults}
    cp "$seed_config" "$TMPDIR/fallback/data/config.yaml"
    PATH="$TMPDIR/fallback/bin:$PATH" sh -c "$seed_fallback" 2>/dev/null
    cmp -s "$TMPDIR/fallback/data/config.yaml" "$seed_config" \
        && ok "seed: a failed merge leaves the live config untouched" \
        || nope "seed failure path preserves the live config" "live config was rewritten"

    # A first boot has no live config: the failure path must still bootstrap one.
    rm -f "$TMPDIR/fallback/data/config.yaml"
    PATH="$TMPDIR/fallback/bin:$PATH" sh -c "$seed_fallback" 2>/dev/null
    cmp -s "$TMPDIR/fallback/data/config.yaml" "$TMPDIR/seed/hermes-defaults/config.yaml" \
        && ok "seed: a failed merge still bootstraps a missing live config" \
        || nope "seed failure path bootstraps a missing config" "baked config was not copied"
else
    nope "seed failure path preserves the live config" "merge block not found in $SEED_SCRIPT"
fi

# Unparseable live YAML must not lose the carried keys without trace: the
# broken file is kept as config.yaml.invalid before the reseed overwrites it.
if [ -n "$seed_merge_block" ]; then
    printf 'hooks:\n  pre_llm_call:\n    - command: /x\n  bad: [unclosed\n' > "$TMPDIR/seed/data/config.yaml"
    cp "$TMPDIR/seed/data/config.yaml" "$TMPDIR/seed/data/broken.expected"
    # `|| true` keeps a merge regression from aborting the suite under set -e;
    # the cmp below then reports it as a named failure.
    python3 - "$TMPDIR/seed/hermes-defaults/config.yaml" "$TMPDIR/seed/data/config.yaml" \
        < "$TMPDIR/seed/merge.py" 2>/dev/null || true
    cmp -s "$TMPDIR/seed/data/config.yaml.invalid" "$TMPDIR/seed/data/broken.expected" \
        && ok "seed: an unparseable live config is backed up before reseeding" \
        || nope "seed backs up unparseable live config" "config.yaml.invalid missing or wrong"
else
    nope "seed backs up unparseable live config" "merge block not found in $SEED_SCRIPT"
fi

seeded_threshold_tokens=$(python3 - "$seed_config" <<'PY'
import sys

try:
    import yaml
except ModuleNotFoundError:
    print("SKIP_PYYAML")
    raise SystemExit(0)

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
print((config.get("compression") or {}).get("threshold_tokens"))
PY
)
if [ "$seeded_threshold_tokens" = "300000" ]; then
    ok "config: compression.threshold_tokens is 300000 (seeded copy inherits 300k)"
else
    nope "compression.threshold_tokens" "expected 300000, got $seeded_threshold_tokens"
fi

seeded_threshold=$(python3 - "$seed_config" <<'PY'
import sys

try:
    import yaml
except ModuleNotFoundError:
    print("SKIP_PYYAML")
    raise SystemExit(0)

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
print((config.get("compression") or {}).get("threshold"))
PY
)
if [ "$seeded_threshold" = "0.9" ]; then
    ok "config: compression.threshold is 0.90"
else
    nope "compression.threshold" "expected 0.9, got $seeded_threshold"
fi

# The merge must write the baked bytes unchanged, not re-serialise the parsed
# config: comments in the baked file are not round-tripped by PyYAML.
grep -q 'Keep this block AFTER `webhook`' "$seed_config" \
    && ok "config: seeded file keeps the baked file's comments" \
    || nope "seed keeps baked comments" "baked comment missing from seeded config"

# The memory core limit and session retention are the knobs the tier-2 design
# depends on: the judge prompt quotes the cap and retention decides how long the
# un-filed episodic record survives. Assert the seeded copy, not the repo file.
seeded_memory_limits=$(python3 - "$seed_config" <<'PY'
import sys

try:
    import yaml
except ModuleNotFoundError:
    print("SKIP_PYYAML")
    raise SystemExit(0)

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
sessions = config["sessions"]
print(
    config["memory"]["memory_char_limit"],
    sessions["retention_days"],
    sessions["auto_prune"],
    sessions["auto_archive"],
    sessions["auto_archive_days"],
)
PY
)
if [ "$seeded_memory_limits" = "2800 30 True True 14" ]; then
    ok "config: memory 2800 + retention 30 + prune/archive enabled (14d)"
else
    nope "memory/sessions config" "expected '2800 30 True True 14', got '$seeded_memory_limits'"
fi

seeded_disk_cleanup=$(python3 - "$seed_config" <<'PY'
import sys
import yaml

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
enabled = (config.get("plugins") or {}).get("enabled") or []
print("disk-cleanup" in enabled)
PY
)
[ "$seeded_disk_cleanup" = "True" ] \
    && ok "config: disk-cleanup remains enabled in merged config" \
    || nope "merged plugin config" "disk-cleanup is not enabled"

echo ""
echo "=== compaction trigger derivation ==="

# threshold_tokens is a cap applied AFTER derivation, and Hermes floors the
# ratio to 0.75 for windows under its small-context limit (512000). Assert the
# derived trigger for stubbed windows, not just the literals: a cap that stops
# binding, or a threshold that no longer parses, must fail here. The compressor
# lives in the Hermes image, so this mirrors the documented formula rather than
# importing it and cannot see Hermes-side drift; that is the tradeoff #466 asked
# for over a literal restatement.
derived_trigger=$(python3 - "$seed_config" <<'PY'
import sys
import yaml

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
compression = config.get("compression") or {}
cap = compression.get("threshold_tokens")
ratio = compression.get("threshold")
# Mirrors agent/context_compressor.py in the Hermes image:
# _SMALL_CTX_WINDOW_LIMIT and the 0.75 floor applied by
# _effective_threshold_percent() below that limit.
HERMES_SMALL_CTX_WINDOW_LIMIT = 512_000
HERMES_SMALL_CTX_FLOOR_RATIO = 0.75


def trigger(window):
    if not isinstance(cap, (int, float)) or not isinstance(ratio, (int, float)):
        raise ValueError("compression.threshold_tokens={!r} compression.threshold={!r}".format(cap, ratio))
    effective = max(ratio, HERMES_SMALL_CTX_FLOOR_RATIO) if window < HERMES_SMALL_CTX_WINDOW_LIMIT else ratio
    return min(int(effective * window), int(cap))


failures = []
for window, expected in ((272_000, 244_800), (400_000, 300_000), (1_048_576, 300_000)):
    try:
        got = trigger(window)
    except ValueError as exc:
        failures.append(str(exc))
        continue
    if got != expected:
        failures.append("window {}: expected {}, got {}".format(window, expected, got))
print("pass" if not failures else "; ".join(failures))
PY
)
if [ "$derived_trigger" = "pass" ]; then
    ok "config: derived compaction trigger is min(floor_ratio x window, 300000)"
else
    nope "compaction trigger derivation" "$derived_trigger"
fi

echo ""
echo "=== opencode config seeding is retired ==="

# The image no longer installs the opencode CLI, so the seed script must not
# write an opencode config into either runtime home and must not seed the
# opencode log-triage agent. A leftover seed would recreate state for a runtime
# that no longer exists.
opencode_leftovers=$(python3 - "$SEED_SCRIPT" <<'PY'
import sys
with open(sys.argv[1]) as f:
    content = f.read()
markers = (
    "PYOPENCODE",
    "/opt/data/home/.config/opencode/opencode.json",
    "/opt/data/.config/opencode/opencode.json",
    "log-triage-worker.md",
)
found = [m for m in markers if m in content]
print("clean" if not found else "found " + repr(found))
PY
)
[ "$opencode_leftovers" = "clean" ] \
    && ok "seed script no longer writes opencode config or agents" \
    || nope "opencode seeding retired" "$opencode_leftovers"

echo ""
echo "=== memory-approve-queue cron seeding (survives reinstall) ==="

# The memory-approve-queue job drains the memory write-approval queue. It must be seeded
# so it survives a reinstall, along with the scripts + skill it depends on.
mt_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import re, sys
content = open(sys.argv[1], encoding="utf-8").read()
blocks = re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", content, re.DOTALL)
# Select by job name, not by first text mention: "memory-approve-queue" also appears
# in prose comments far above the seed block, which grabbed the wrong block.
mt = [b for b in blocks if '"name": "memory-approve-queue"' in b]
print(mt[0] if mt else "")
PY
)
[ -n "$mt_block" ] && ok "seed has a memory-approve-queue PYEOF block" || nope "memory-approve-queue block" "not found"

rm -rf "$TMPDIR/cron"
mkdir -p "$TMPDIR/cron"
echo '{"jobs": []}' > "$TMPDIR/cron/jobs.json"
mt_block_tmp=${mt_block//\/opt\/data\/cron\/jobs.json/$TMPDIR\/cron\/jobs.json}
python3 -c "$mt_block_tmp" >/dev/null 2>&1

mt_fields=$(python3 - "$TMPDIR/cron/jobs.json" <<'PY'
import json, sys
jobs = json.load(open(sys.argv[1]))["jobs"]
if len(jobs) != 1:
    print("fail count=%d" % len(jobs)); sys.exit()
j = jobs[0]
sched = j.get("schedule", {})
prompt = j.get("prompt") or ""
checks = {
    "name": j.get("name") == "memory-approve-queue",
    "kind": sched.get("kind") == "cron",
    "expr": sched.get("expr") == "0 8 * * *",
    "display": j.get("schedule_display") == "0 8 * * *",
    "enabled": j.get("enabled") is True,
    "deliver": j.get("deliver") == "telegram",
    "skills": j.get("skills") == ["hermes-troubleshooting"],
    "prompt_len": len(prompt) > 500,
    "safe_rollback": "memory-triage.sh restore" in prompt,
    "cap": "--max-records" in prompt or "40 records" in prompt,
    "audit": "memory-triage-audit.jsonl" in prompt,
    "topic_rule": "memories/topics" in prompt,
    "untruncated_list": "list --full" in prompt,
    # write_file refuses to overwrite a file the task never read; a plan left by
    # the previous run must be removed before this run writes its own.
    "fresh_plan": "rm -f /opt/data/tmp/triage-queue.json /opt/data/tmp/triage-plan.json" in prompt
        and prompt.find("rm -f /opt/data/tmp/triage") < prompt.find("Write the verdict plan"),
    "digest_header": "🧠 *Memory triage" in prompt,
    "digest_store_table": "| Store | Used | Cap |" in prompt,
}
bad = [k for k, v in checks.items() if not v]
print("pass" if not bad else "fail " + repr(bad))
PY
)
case "$mt_fields" in
    pass) ok "job: cron 0 8 * * * · telegram · hermes-troubleshooting · safe prompt (snapshot/cap/audit)" ;;
    *) nope "memory-approve-queue fields" "$mt_fields" ;;
esac

# Idempotency: re-running the block must not duplicate the job.
python3 -c "$mt_block_tmp" >/dev/null 2>&1
mt2=$(python3 -c "import json;print(len(json.load(open('$TMPDIR/cron/jobs.json'))['jobs']))")
[ "$mt2" = "1" ] && ok "idempotent: still 1 job on re-seed" || nope "memory-approve-queue idempotent" "got $mt2"

# Migration: an install that already has the job must get the managed fields updated
# in place. The seed only appends when the job is missing, so a prompt change that
# relied on the append path would never reach a running deployment.
echo ""
echo "=== memory-approve-queue prompt migration (existing installs) ==="

rm -rf "$TMPDIR/cron-legacy"
mkdir -p "$TMPDIR/cron-legacy"
cat > "$TMPDIR/triage-config.yaml" <<'CFG'
memory:
    memory_char_limit: 2800
    user_char_limit: 1375
CFG
python3 - "$TMPDIR/cron-legacy/jobs.json" <<'PY'
import json, sys
legacy = "Triage the Hermes memory write-approval queue on this machine (HERMES_HOME=/opt/data).\n\nlegacy prompt without the topic-file rule"
json.dump({"jobs": [{
    "id": "legacy1234",
    "name": "memory-approve-queue",
    "prompt": legacy,
    "skills": ["hermes-troubleshooting"],
    "skill": "hermes-troubleshooting",
    "schedule": {"kind": "cron", "expr": "30 3 * * *", "display": "30 3 * * *"},
    "schedule_display": "30 3 * * *",
    "enabled": False,
    "deliver": "local",
    "context_from": ["self"],
    "created_at": "2026-01-01T00:00:00+00:00",
    "user_note": "keep me",
}]}, open(sys.argv[1], "w"))
PY

mt_legacy_tmp=${mt_block//\/opt\/data\/cron\/jobs.json/$TMPDIR\/cron-legacy\/jobs.json}
mt_legacy_tmp=${mt_legacy_tmp//\/opt\/data\/config.yaml/$TMPDIR\/triage-config.yaml}
mt_migrate_out=$(python3 -c "$mt_legacy_tmp" 2>&1)

mt_migrate=$(python3 - "$TMPDIR/cron-legacy/jobs.json" <<'PY'
import json, sys
jobs = json.load(open(sys.argv[1]))["jobs"]
if len(jobs) != 1:
    print("fail count=%d" % len(jobs)); sys.exit()
j = jobs[0]
prompt = j.get("prompt") or ""
checks = {
    "id_preserved": j.get("id") == "legacy1234",
    "created_at_preserved": j.get("created_at") == "2026-01-01T00:00:00+00:00",
    "user_field_preserved": j.get("user_note") == "keep me",
    "prompt_updated": "memories/topics" in prompt,
    "untruncated_list": "list --full" in prompt,
    "schedule_not_reverted": j.get("schedule_display") == "30 3 * * *",
    "disabled_stays_disabled": j.get("enabled") is False,
    "deliver_not_reverted": j.get("deliver") == "local",
    "cap_from_config": "memory 2800 chars" in prompt,
}
bad = [k for k, v in checks.items() if not v]
print("pass" if not bad else "fail " + repr(bad))
PY
)
case "$mt_migrate" in
    pass) ok "existing job migrated in place (prompt only; schedule/enabled/deliver/user fields preserved)" ;;
    *) nope "memory-approve-queue migration" "$mt_migrate" ;;
esac
case "$mt_migrate_out" in
    *migrated*) ok "migration is reported" ;;
    *) nope "migration report" "got: $mt_migrate_out" ;;
esac

# An install created under the old 09:00 default moves to 08:00 once (#579).
# Only the exact legacy value is rewritten; a custom time is kept (above).
echo ""
echo "=== memory-compact daily cron seeding ==="

# Weekly compaction keeps MEMORY.md under its cap by moving detail to topic
# files. It lives in its own block (memory-approve-queue stays the last PYEOF block).
mc_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import re, sys
content = open(sys.argv[1], encoding="utf-8").read()
blocks = re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", content, re.DOTALL)
print(next((b for b in blocks if '"name": "memory-compact"' in b), ""))
PY
)
[ -n "$mc_block" ] && ok "seed has a memory-compact PYEOF block" || nope "memory-compact block" "not found"

rm -rf "$TMPDIR/cron-mc" && mkdir -p "$TMPDIR/cron-mc"
echo '{"jobs": [{"id": "other1", "name": "memory-approve-queue", "prompt": "x"}]}' > "$TMPDIR/cron-mc/jobs.json"
mc_tmp=${mc_block//\/opt\/data\/cron\/jobs.json/$TMPDIR\/cron-mc\/jobs.json}
mc_tmp=${mc_tmp//\/opt\/data\/config.yaml/$TMPDIR\/triage-config.yaml}
python3 -c "$mc_tmp" >/dev/null 2>&1
python3 -c "$mc_tmp" >/dev/null 2>&1

mc_fields=$(python3 - "$TMPDIR/cron-mc/jobs.json" <<'PY'
import json, sys
jobs = json.load(open(sys.argv[1]))["jobs"]
mc = [j for j in jobs if j.get("name") == "memory-compact"]
if len(jobs) != 2 or len(mc) != 1:
    print("fail jobs=%d compact=%d" % (len(jobs), len(mc))); sys.exit()
j = mc[0]
prompt = j.get("prompt") or ""
checks = {
    "daily": j.get("schedule", {}).get("expr") == "30 7 * * *",
    "display": j.get("schedule_display") == "30 7 * * *",
    "enabled": j.get("enabled") is True,
    "deliver": j.get("deliver") == "telegram",
    "skills": j.get("skills") == ["hermes-troubleshooting"],
    "uses_compact_cmd": "memory-triage.sh compact --plan" in prompt,
    "dry_run_first": "--dry-run" in prompt,
    "rollback": "memory-triage.sh restore" in prompt,
    "topics": "memories/topics" in prompt,
    "cap_from_config": "2800" in prompt,
    "fresh_plan": "rm -f /opt/data/tmp/compact-plan-memory.json /opt/data/tmp/compact-plan-user.json" in prompt,
    "digest": "🗜 *Memory compaction" in prompt,
    "triage_untouched": next(x for x in jobs if x["name"] == "memory-approve-queue")["prompt"] == "x",
}
bad = [k for k, v in checks.items() if not v]
print("pass" if not bad else "fail " + repr(bad))
PY
)
case "$mc_fields" in
    pass) ok "memory-compact: daily 07:30 · telegram · compact cmd, dry-run, rollback; idempotent" ;;
    *) nope "memory-compact fields" "$mc_fields" ;;
esac

python3 - "$TMPDIR/cron-mc/jobs.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for j in d["jobs"]:
    if j["name"] == "memory-compact":
        j["prompt"] = "old"; j["schedule_display"] = "0 6 * * 1"; j["enabled"] = False
json.dump(d, open(sys.argv[1], "w"))
PY
python3 -c "$mc_tmp" >/dev/null 2>&1
mc_mig=$(python3 -c "
import json
j=[j for j in json.load(open('$TMPDIR/cron-mc/jobs.json'))['jobs'] if j['name']=='memory-compact'][0]
print('pass' if 'compact --plan' in j['prompt'] and j['schedule_display']=='0 6 * * 1' and j['enabled'] is False else 'fail')")
[ "$mc_mig" = "pass" ] && ok "memory-compact: prompt migrated, schedule/enabled kept" || nope "memory-compact migration" "$mc_mig"

echo "=== memory-approve-queue legacy 09:00 schedule migration (#579) ==="
rm -rf "$TMPDIR/cron-0900"
mkdir -p "$TMPDIR/cron-0900"
python3 - "$TMPDIR/cron-0900/jobs.json" <<'PY'
import json, sys
json.dump({"jobs": [{
    "id": "old0900job", "name": "memory-approve-queue", "prompt": "old",
    "skills": ["hermes-troubleshooting"], "skill": "hermes-troubleshooting",
    "schedule": {"kind": "cron", "expr": "0 9 * * *", "display": "0 9 * * *"},
    "schedule_display": "0 9 * * *", "enabled": False, "deliver": "local",
}]}, open(sys.argv[1], "w"))
PY
mt_0900=${mt_block//\/opt\/data\/cron\/jobs.json/$TMPDIR\/cron-0900\/jobs.json}
mt_0900=${mt_0900//\/opt\/data\/config.yaml/$TMPDIR\/triage-config.yaml}
mt_0900_out=$(python3 -c "$mt_0900" 2>&1)
mt_0900_res=$(python3 - "$TMPDIR/cron-0900/jobs.json" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))["jobs"][0]
ok = (j["schedule"].get("expr") == "0 8 * * *" and j["schedule"].get("display") == "0 8 * * *"
      and j.get("schedule_display") == "0 8 * * *" and j.get("enabled") is False
      and j.get("deliver") == "local")
print("pass" if ok else "fail " + json.dumps(j.get("schedule")) + " " + str(j.get("schedule_display")))
PY
)
[ "$mt_0900_res" = "pass" ] && ok "legacy 0 9 * * * schedule migrated to 0 8 * * *" || nope "legacy schedule migration" "$mt_0900_res"
case "$mt_0900_out" in
    *migrated*schedule*) ok "schedule migration is reported" ;;
    *) nope "schedule migration report" "got: $mt_0900_out" ;;
esac
mt_0900_again=$(python3 -c "$mt_0900" 2>&1)
case "$mt_0900_again" in
    *unchanged*) ok "schedule migration is idempotent" ;;
    *) nope "schedule migration idempotent" "got: $mt_0900_again" ;;
esac

# The routing rule must name the topic-file directory the seed creates.
grep -q "/opt/data/memories/topics" "$SEED_SCRIPT" \
    && ok "seed creates the topic-file directory" \
    || nope "topic-file directory" "seed does not reference /opt/data/memories/topics"

# Without a pointer in the always-on core, tier 2 is write-only: a fresh session
# that has not loaded the troubleshooting skill has no cue the files exist.
echo ""
echo "=== MEMORY.md topic-directory pointer ==="

ptr_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import re, sys
content = open(sys.argv[1], encoding="utf-8").read()
blocks = re.findall(r"<<'PYPTR'[^\n]*\n(.*?)\nPYPTR", content, re.DOTALL)
print(blocks[-1] if blocks else "")
PY
)
[ -n "$ptr_block" ] && ok "seed has a MEMORY.md pointer block" || nope "pointer block" "not found"

mkdir -p "$TMPDIR/memories"
printf 'existing core line\n' > "$TMPDIR/memories/MEMORY.md"
ptr_tmp=${ptr_block//\/opt\/data\/memories\/MEMORY.md/$TMPDIR\/memories\/MEMORY.md}
ptr_tmp=${ptr_tmp//\/opt\/data\/config.yaml/$TMPDIR\/triage-config.yaml}
python3 -c "$ptr_tmp" >/dev/null 2>&1

grep -q "memories/topics" "$TMPDIR/memories/MEMORY.md" \
    && ok "pointer added to MEMORY.md" \
    || nope "pointer content" "MEMORY.md has no topic-directory pointer"
grep -q "existing core line" "$TMPDIR/memories/MEMORY.md" \
    && ok "pointer does not clobber existing entries" \
    || nope "pointer clobber" "existing entry lost"

python3 -c "$ptr_tmp" >/dev/null 2>&1
ptr_count=$(grep -c "memories/topics" "$TMPDIR/memories/MEMORY.md")
[ "$ptr_count" = "1" ] && ok "pointer is idempotent (added once)" || nope "pointer idempotency" "occurrences: $ptr_count"

# A full core must not be pushed over its cap by the pointer.
mkdir -p "$TMPDIR/fullmem"
python3 - "$TMPDIR/fullmem/MEMORY.md" <<'PY'
import sys
open(sys.argv[1], "w").write("x" * 200 + "\n")
PY
cat > "$TMPDIR/tiny-config.yaml" <<'CFG'
memory:
    memory_char_limit: 100
CFG
ptr_full_tmp=${ptr_block//\/opt\/data\/memories\/MEMORY.md/$TMPDIR\/fullmem\/MEMORY.md}
ptr_full_tmp=${ptr_full_tmp//\/opt\/data\/config.yaml/$TMPDIR\/tiny-config.yaml}
ptr_full_out=$(python3 -c "$ptr_full_tmp" 2>&1)
if grep -q "memories/topics" "$TMPDIR/fullmem/MEMORY.md"; then
    nope "pointer cap guard" "pointer written past the configured limit"
else
    ok "pointer refused when the core is full (reports it)"
fi

# Reinstall survival: scripts + skill must be baked in the repo (image) so the
# seed can restore them.
[ -f "$SCRIPT_DIR/../scripts/memory-triage.sh" ] && ok "baked: scripts/memory-triage.sh" || nope "scripts/memory-triage.sh" "missing"
[ -f "$SCRIPT_DIR/../scripts/memory_triage.py" ] && ok "baked: scripts/memory_triage.py" || nope "scripts/memory_triage.py" "missing"
[ -f "$SCRIPT_DIR/../skills/hermes-troubleshooting/SKILL.md" ] && ok "baked: skill SKILL.md" || nope "skill SKILL.md" "missing"
[ -f "$SCRIPT_DIR/../skills/hermes-troubleshooting/scripts/memory_triage.py" ] && ok "baked: skill triage engine" || nope "skill triage engine" "missing"

python3 -m py_compile "$SCRIPT_DIR/../scripts/memory_triage.py" 2>/dev/null \
    && ok "memory_triage.py compiles" || nope "py compile" "syntax error"

echo ""
echo "=== boot reconcile log probe ==="

# The hook keeps the reconcile's stderr in a boot log and falls back to
# /dev/null when the log path cannot be opened. Nothing else runs that branch:
# the probe block is extracted and executed under dash (the shell the hook runs
# as) against a stub reconciler. A revert to a bare `:` (which exits the shell on
# a failed redirection) or to a `mkdir -p`-only check (which returns 0 when the
# log path already exists as a directory) then fails here instead of silently
# skipping the reconcile on every boot.
probe_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import re
import sys

content = open(sys.argv[1], encoding="utf-8").read()
match = re.search(
    r"(mkdir -p /opt/data/logs 2>/dev/null \|\| true\n"
    r"if true 2>/opt/data/logs/codex-router-skills-sync\.log; then\n.*?\nfi)",
    content,
    re.DOTALL,
)
print(match.group(1) if match else "")
PY
)
[ -n "$probe_block" ] \
    && ok "seed: has the boot reconcile log probe" \
    || nope "seed: boot reconcile log probe" "probe block missing from $SEED_SCRIPT"

probe_root="$TMPDIR/probe"
mkdir -p "$probe_root/hermes-defaults/scripts" "$probe_root/data/logs"
cat > "$probe_root/hermes-defaults/scripts/sync-codex-router-skills.sh" <<'STUB'
#!/bin/sh
printf 'stub reconcile ran\n' >> "$PROBE_MARKER"
printf 'stub reconcile stderr\n' >&2
STUB
chmod +x "$probe_root/hermes-defaults/scripts/sync-codex-router-skills.sh"

# The hook hardcodes absolute paths, so run the extracted block against the temp
# fixtures. It is executed as a file, never sourced: a special-builtin redirect
# failure exits the shell outright, and sourcing would apply that to this suite
# instead of to the hook under test.
probe_code=${probe_block//\/opt\/data/$probe_root/data}
probe_code=${probe_code//\/opt\/hermes-defaults/$probe_root/hermes-defaults}
probe_script="$TMPDIR/probe-hook.sh"
printf '%s\n' "$probe_code" > "$probe_script"
if command -v dash >/dev/null 2>&1; then
    probe_shell=dash
else
    probe_shell=sh
fi

probe_log="$probe_root/data/logs/codex-router-skills-sync.log"
probe_marker="$TMPDIR/probe-marker"

# Healthy log path: the reconcile must run and its stderr must land in the log.
: > "$probe_marker"
probe_rc=0
PROBE_MARKER="$probe_marker" "$probe_shell" "$probe_script" 2>"$TMPDIR/probe-hook-stderr" || probe_rc=$?
probe_ran=$(cat "$probe_marker" 2>/dev/null || true)
probe_logged=$(cat "$probe_log" 2>/dev/null || true)
probe_hook_stderr=$(cat "$TMPDIR/probe-hook-stderr" 2>/dev/null || true)
[ -n "$probe_block" ] && [ "$probe_rc" -eq 0 ] && [ "$probe_ran" = "stub reconcile ran" ] \
    && [ "$probe_logged" = "stub reconcile stderr" ] \
    && ok "boot probe: reconcile runs and its stderr lands in the log" \
    || nope "boot probe: healthy log path" \
        "rc=$probe_rc ran='$probe_ran' logged='$probe_logged' hook_stderr='$probe_hook_stderr'"

# Unwritable log path (a directory with that name): the hook must not exit and
# the reconcile must still run, with its stderr discarded.
rm -f "$probe_log"
mkdir -p "$probe_log"
: > "$probe_marker"
probe_fallback_rc=0
PROBE_MARKER="$probe_marker" "$probe_shell" "$probe_script" 2>"$TMPDIR/probe-fallback-stderr" || probe_fallback_rc=$?
probe_fallback_ran=$(cat "$probe_marker" 2>/dev/null || true)
probe_fallback_stderr=$(cat "$TMPDIR/probe-fallback-stderr" 2>/dev/null || true)
probe_fallback_litter=$(ls -A "$probe_log" 2>/dev/null || true)
[ -n "$probe_block" ] && [ "$probe_fallback_rc" -eq 0 ] \
    && [ "$probe_fallback_ran" = "stub reconcile ran" ] \
    && [ -z "$probe_fallback_litter" ] \
    && ok "boot probe: reconcile still runs when the log path is a directory" \
    || nope "boot probe: log path is a directory" \
        "rc=$probe_fallback_rc ran='$probe_fallback_ran' hook_stderr='$probe_fallback_stderr'"

echo "--- seeded script pruning (#605) ---"
seed_scripts_run() {
    # Run the real seed-scripts block with /opt paths rewritten into $TMPDIR/sp.
    local blk="$TMPDIR/seed-scripts-block.sh"
    awk '/# seed-scripts:begin/{f=1} f{print} /# seed-scripts:end/{f=0}' "$SEED_SCRIPT" \
        | sed "s#/opt/data#$TMPDIR/sp/data#g; s#/opt/hermes-defaults#$TMPDIR/sp/defaults#g" > "$blk"
    [ -s "$blk" ] || return 1
    sh "$blk"
}
SP="$TMPDIR/sp"
rm -rf "$SP"; mkdir -p "$SP/defaults/scripts" "$SP/data/scripts"
echo a > "$SP/defaults/scripts/keep.sh"; echo b > "$SP/defaults/scripts/old.sh"
echo op > "$SP/data/scripts/operator.sh"
echo stale > "$SP/data/scripts/preexisting-orphan.sh"

seed_scripts_run || nope "seed-scripts block runs (first boot)" "extract or run failed"
[ -f "$SP/data/scripts/preexisting-orphan.sh" ] && [ -f "$SP/data/scripts/operator.sh" ] \
    && ok "first boot with no manifest prunes nothing" || nope "first boot prune" "files removed"
[ -f "$SP/data/.hermes-seeded-scripts" ] && grep -qx old.sh "$SP/data/.hermes-seeded-scripts" \
    && ok "first boot writes manifest" || nope "first boot manifest" "missing or incomplete"

rm "$SP/defaults/scripts/old.sh"
seed_scripts_run || true
[ ! -e "$SP/data/scripts/old.sh" ] && ok "script removed from image is pruned" || nope "prune removed" "old.sh still present"
[ -f "$SP/data/scripts/operator.sh" ] && [ -f "$SP/data/scripts/preexisting-orphan.sh" ] \
    && ok "operator and pre-manifest files are kept" || nope "keep operator file" "removed"
[ -f "$SP/data/scripts/keep.sh" ] && ! grep -qx old.sh "$SP/data/.hermes-seeded-scripts" \
    && ok "manifest rewritten without pruned name" || nope "manifest rewrite" "$(cat "$SP/data/.hermes-seeded-scripts" 2>/dev/null)"

before=$(cat "$SP/data/.hermes-seeded-scripts")
seed_scripts_run || true
[ "$before" = "$(cat "$SP/data/.hermes-seeded-scripts")" ] && [ -f "$SP/data/scripts/keep.sh" ] && [ -f "$SP/data/scripts/operator.sh" ] \
    && ok "re-running is idempotent" || nope "idempotence" "state changed"

# Pre-manifest orphans: a one-time retired-name list removes scripts the image
# once shipped (in repo history), but never an operator file (names never in
# the repo), and never a retired name the image ships again.
echo stale > "$SP/data/scripts/log-issue-triage-worker.sh"
for n in deleg-watchdog.sh onedrive-auth-poll.sh; do echo mine > "$SP/data/scripts/$n"; done
mkdir -p "$SP/data/scripts/whatsapp-bridge"; echo x > "$SP/data/scripts/whatsapp-bridge/a"
seed_scripts_run || true
[ ! -e "$SP/data/scripts/log-issue-triage-worker.sh" ] \
    && ok "retired pre-manifest orphan is pruned" || nope "retired orphan" "still present"
[ -f "$SP/data/scripts/deleg-watchdog.sh" ] && [ -f "$SP/data/scripts/onedrive-auth-poll.sh" ] \
    && [ -f "$SP/data/scripts/whatsapp-bridge/a" ] && [ -f "$SP/data/scripts/operator.sh" ] \
    && ok "never-shipped files are left alone" || nope "retired list scope" "operator file removed"
echo stale > "$SP/data/scripts/log-issue-triage-worker.sh"
echo "new in image" > "$SP/defaults/scripts/log-issue-triage-worker.sh"
seed_scripts_run || true
grep -qx "new in image" "$SP/data/scripts/log-issue-triage-worker.sh" \
    && ok "retired name shipped by the image is kept" || nope "retired but shipped" "removed or stale"
rm -f "$SP/defaults/scripts/log-issue-triage-worker.sh"

echo ""
echo "=== cron jobs.json safety (every seed block) ==="
# A corrupt jobs.json must never be read as empty and rewritten: that wipes
# every cron job. Each block that writes jobs.json must refuse and leave it.
safety=$(python3 - "$SEED_SCRIPT" "$TMPDIR" <<'PY'
import re, subprocess, sys, os
content = open(sys.argv[1], encoding="utf-8").read()
tmp = sys.argv[2]
blocks = [b for b in re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", content, re.DOTALL)
          if 'jobs_path = "/opt/data/cron/jobs.json"' in b]
bad = []
for i, block in enumerate(blocks):
    d = os.path.join(tmp, f"corrupt-{i}")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "jobs.json")
    open(path, "w").write('{"jobs": [{"name": "keep"')
    code = block.replace("/opt/data/cron/jobs.json", path).replace("/opt/data/config.yaml", os.path.join(d, "none.yaml"))
    subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=d)
    if open(path).read() != '{"jobs": [{"name": "keep"':
        name = re.search(r'"name": "([^"]+)"', block)
        bad.append(name.group(1) if name else f"block{i}")
    if 'open(jobs_path, "w")' in block:
        bad.append(f"non-atomic write in block{i}")
print(f"pass {len(blocks)}" if not bad and len(blocks) >= 8 else f"fail blocks={len(blocks)} {bad}")
PY
)
case "$safety" in
    pass*) ok "corrupt jobs.json left untouched by every cron block; writes are atomic ($safety)" ;;
    *) nope "jobs.json safety" "$safety" ;;
esac

echo ""
echo "=== one-time schedule migrations (wiki 04:00, compact 07:30, reminders 08:15) ==="
migr=$(python3 - "$SEED_SCRIPT" "$TMPDIR" <<'PY'
import json, re, subprocess, sys, os
content = open(sys.argv[1], encoding="utf-8").read()
tmp = sys.argv[2]
blocks = re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", content, re.DOTALL)
cases = [
    ("wiki-finance-refresh", "0 9 * * 1", "every monday 9am", "0 4 * * 1", "every monday 4am"),
    ("memory-compact", "30 8 * * 0", "30 8 * * 0", "30 7 * * *", "30 7 * * *"),
    ("wiki-due-reminders", "0 8 * * *", "every day 8am", "15 8 * * *", "every day 8:15am"),
    ("memory-approve-queue", "0 9 * * *", "0 9 * * *", "0 8 * * *", "0 8 * * *"),
]
bad = []
for name, old, old_disp, new, new_disp in cases:
    block = next((b for b in blocks if f'"name": "{name}"' in b), None)
    if block is None:
        bad.append(f"{name}: no block"); continue
    for label, expr, disp, want in (("legacy", old, old_disp, new), ("custom", "5 6 * * 3", "custom", "5 6 * * 3")):
        d = os.path.join(tmp, f"mig-{name}-{label}")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, "jobs.json")
        json.dump({"jobs": [{"id": "x1", "name": name, "prompt": "old", "enabled": False,
                             "next_run_at": "2026-01-05T09:00:00+08:00",
                             "schedule": {"kind": "cron", "expr": expr, "display": disp},
                             "schedule_display": disp}]}, open(path, "w"))
        code = block.replace("/opt/data/cron/jobs.json", path).replace("/opt/data/config.yaml", os.path.join(d, "none.yaml"))
        for _ in range(2):
            subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        j = json.load(open(path))["jobs"][0]
        if j["schedule"]["expr"] != want or j.get("enabled") is not False:
            bad.append(f"{name}/{label}: {j['schedule']}")
        if label == "legacy" and (j["schedule"].get("display") != new_disp or j.get("schedule_display") != new_disp):
            bad.append(f"{name}/display: {j['schedule']} {j.get('schedule_display')}")
        # A migrated job must drop the instant computed from the old expr, or the
        # scheduler re-anchors past the first new occurrence without firing it.
        want_next = None if label == "legacy" else "2026-01-05T09:00:00+08:00"
        if j.get("next_run_at") != want_next:
            bad.append(f"{name}/{label} next_run_at: {j.get('next_run_at')}")
print("pass" if not bad else "fail " + repr(bad))
PY
)
[ "$migr" = "pass" ] && ok "exact legacy schedules move once; custom schedules and enabled flags kept" || nope "schedule migrations" "$migr"

echo ""
echo "=== Mnemosyne cross-session recall ==="
cs_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import re, sys
content = open(sys.argv[1], encoding="utf-8").read()
blocks = re.findall(r"<<'PYCS'[^\n]*\n(.*?)\nPYCS", content, re.DOTALL)
print(blocks[0] if blocks else "")
PY
)
[ -n "$cs_block" ] && ok "seed has a cross_session block" || nope "cross_session block" "not found"
cs_run() { python3 -c "${cs_block//\/opt\/data\/mnemosyne\/config.yaml/$1}" >/dev/null 2>&1; }
mkdir -p "$TMPDIR/cs"
printf '# header\nauto_sleep_enabled: true\ncross_session: false\ndefault_scope: session\n' > "$TMPDIR/cs/config.yaml"
cs_run "$TMPDIR/cs/config.yaml"; cs_run "$TMPDIR/cs/config.yaml"
[ "$(grep -c '^cross_session:' "$TMPDIR/cs/config.yaml")" = "1" ] && grep -qx 'cross_session: true' "$TMPDIR/cs/config.yaml" \
    && grep -qx 'default_scope: session' "$TMPDIR/cs/config.yaml" && grep -qx '# header' "$TMPDIR/cs/config.yaml" \
    && ok "cross_session flipped to true once; other keys and comments kept" || nope "cross_session edit" "$(cat "$TMPDIR/cs/config.yaml")"
cs_run "$TMPDIR/cs/absent.yaml"
grep -qx 'cross_session: true' "$TMPDIR/cs/absent.yaml" 2>/dev/null && ok "absent Mnemosyne config gets cross_session: true" \
    || nope "cross_session absent file" "not created"

echo ""
echo "=== memory digests and wiki lint wording ==="
wording=$(python3 - "$SEED_SCRIPT" "$SCRIPT_DIR/../config.yaml" <<'PY'
import re, sys
content = open(sys.argv[1], encoding="utf-8").read()
blocks = re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", content, re.DOTALL)
def block(name): return next((b for b in blocks if f'"name": "{name}"' in b), "")
triage, compact, wiki = block("memory-approve-queue"), block("memory-compact"), block("wiki-finance-refresh")
reminders, repos, proposals = block("wiki-due-reminders"), block("wiki-repo-docs"), block("skills-merge-proposals")
cfg = open(sys.argv[2], encoding="utf-8").read()
checks = {
    "triage_table": "| Result | Count |" in triage,
    "triage_needs_you": "Needs you" in triage and "age_days" in triage,
    "triage_no_plain_text_rule": "Plain text, no code blocks" not in triage,
    "compact_table": "| Store | Before | After | Cap |" in compact,
    "reminders_table": "listing ONLY the problems" in reminders,
    "reminders_no_digest": "Never send the routine digest" in reminders,
    "idle_runs_silent": all("reply exactly [SILENT]" in b for b in (triage, compact, reminders, repos, wiki)),
    "compact_quiet_when_not_needed": "change nothing and reply exactly [SILENT]" in compact and "saying no compaction needed" not in compact,
    "wiki_weekly_quiet_when_nothing": "change table would have no rows" in wiki and "nothing is due" in wiki,
    "repos_table": "| Repo | Issue | Link |" in repos and "Repo docs" in repos,
    "proposals_job": '"script": "curator-proposals.py"' in proposals and '"no_agent": True' in proposals and '"deliver": "telegram"' in proposals,
    "mnemosyne_ignores_alerts": "System push alert" in cfg and "Replying to: \"Cronjob" in cfg,
    "wiki_runs_lint": "scripts/lint.py" in wiki,
    "wiki_lint_fallback": "full read" in wiki and "missing" in wiki,
    "wiki_monthly_full_read": "day of the month is 7 or less" in wiki,
    "rich_messages": re.search(r"^    telegram:\n        extra:\n            rich_messages: true$", cfg, re.M) is not None,
}
bad = [k for k, v in checks.items() if not v]
print("pass" if not bad else "fail " + repr(bad))
PY
)
[ "$wording" = "pass" ] && ok "digests use tables; triage surfaces 7-day holds; wiki runs lint with full-read fallback; Telegram rich messages on" \
    || nope "digest/lint wording" "$wording"

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
