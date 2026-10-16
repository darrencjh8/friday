#!/bin/bash
# Contract tests for the Hermes skill roots.
#
# codex-router owns the skills it publishes (dev-loop, code-reviewer, ...). The
# Hermes image must not bake a second copy of them: the deploy stages
# codex-router's `codex/skills` and the reconciler is the only writer. This
# suite pins that contract instead of pinning the removed duplicate.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODULE_DIR="$SCRIPT_DIR/.."
SKILL_DIR="$MODULE_DIR/skills"
SYNC_SCRIPT="$MODULE_DIR/scripts/sync-codex-router-skills.sh"
SEED_SCRIPT="$MODULE_DIR/50-seed-defaults"
DEPLOY_SCRIPT="$SCRIPT_DIR/../../deploy.sh"
REPO_RULES="$SCRIPT_DIR/../../../AGENTS.md"
SPEC_AUDITOR_SKILL="$SKILL_DIR/spec-auditor/SKILL.md"
SPEC_AUDITOR_PROFILE="$MODULE_DIR/profiles/spec-auditor"
CODE_REVIEWER_PROFILE="$MODULE_DIR/profiles/code-reviewer"

fail=0
ok() { printf 'PASS %s\n' "$1"; }
nope() { printf 'FAIL %s\n' "$1"; fail=1; }

echo "=== codex-router-owned skills are not baked twice ==="
for owned in dev-loop code-reviewer; do
    if [ -e "$SKILL_DIR/$owned" ]; then
        nope "modules/hermes/skills/$owned is not a second copy"
    else
        ok "modules/hermes/skills/$owned is owned by codex-router, not baked here"
    fi
done

echo "=== openclaw-owned skills stay baked ==="
[ -f "$SPEC_AUDITOR_SKILL" ] && ok "spec-auditor skill is baked in" || nope "spec-auditor skill is baked in"
for pinned in expense-tracker hermes-troubleshooting image-gen; do
    [ -d "$SKILL_DIR/$pinned" ] && ok "$pinned skill is baked in" || nope "$pinned skill is baked in"
done

echo "=== the reconciler is the single writer for every Hermes root ==="
[ -x "$SYNC_SCRIPT" ] && ok "skill reconciler exists and is executable" || nope "skill reconciler exists and is executable"
for root in 'PRIMARY_HOME/skills' 'PRIMARY_HOME/.agents/skills' 'SECONDARY_HOME/.agents/skills'; do
    grep -Fq -- "$root" "$SYNC_SCRIPT" \
        && ok "reconciler covers $root" \
        || nope "reconciler covers $root"
done
grep -Fq -- 'codex-router' "$SYNC_SCRIPT" && ok "reconciler documents codex-router as the source" \
    || nope "reconciler documents codex-router as the source"

echo "=== boot and deploy both run the reconciler ==="
grep -Fq -- 'sync-codex-router-skills.sh' "$SEED_SCRIPT" \
    && ok "50-seed-defaults reconciles skills on boot" \
    || nope "50-seed-defaults reconciles skills on boot"
grep -Fq -- 'sync-codex-router-skills.sh' "$DEPLOY_SCRIPT" \
    && ok "deploy.sh stages and reconciles the codex-router payload" \
    || nope "deploy.sh stages and reconciles the codex-router payload"
grep -Fq -- 'modules/codex-router/codex/skills' "$DEPLOY_SCRIPT" \
    && ok "deploy.sh stages the canonical codex-router checkout" \
    || nope "deploy.sh stages the canonical codex-router checkout"
grep -Eq 'should_deploy "codex-router".*should_deploy "hermes"' "$DEPLOY_SCRIPT" \
    && ok "deploy.sh syncs on a router-only and a hermes deploy" \
    || nope "deploy.sh syncs on a router-only and a hermes deploy"
# The docker staging path itself is integration-only (needs a running
# container); the reconciler's staged swap is executed by
# test-codex-router-skills-sync.sh, and the host-side moves and failure
# accounting are pinned here.
for expected in \
    'docker cp "$SKILLS_SRC/." hermes:/opt/data/.codex-router-skills.new' \
    'docker cp "$SKILLS_SYNC" hermes:/tmp/sync-codex-router-skills.sh' \
    'docker exec hermes sh /tmp/sync-codex-router-skills.sh /opt/data/.codex-router-skills /opt/data/.codex-router-skills.new' \
    'rm -rf /opt/data/.codex-router-skills.new' \
    'failed=$((failed + 1))'; do
    grep -Fq -- "$expected" "$DEPLOY_SCRIPT" \
        && ok "deploy.sh block contains: $expected" \
        || nope "deploy.sh block contains: $expected"
done

echo "=== the retired reviewer slug is gone from the Hermes module ==="
# This test names the retired slug to search for it, so it is excluded from its
# own sweep rather than papered over with a split literal.
slug_hits=$(grep -rIl --exclude="$(basename "$0")" -- 'auto-thinking-free' \
    "$MODULE_DIR" \
    2>/dev/null || true)
if [ -z "$slug_hits" ]; then
    ok "modules/hermes contains no auto-thinking-free reference"
else
    nope "modules/hermes contains no auto-thinking-free reference: $slug_hits"
fi

echo "=== the code-reviewer profile is untouched and still routes codex-router ==="
for profile_file in config.yaml profile.yaml SOUL.md; do
    [ -f "$CODE_REVIEWER_PROFILE/$profile_file" ] \
        && ok "code-reviewer profile has $profile_file" \
        || nope "code-reviewer profile has $profile_file"
done
grep -Eq '^    default: auto-thinking$' "$CODE_REVIEWER_PROFILE/config.yaml" \
    && ok "code-reviewer profile runs the auto-thinking pool" \
    || nope "code-reviewer profile runs the auto-thinking pool"
grep -Eq '^ +model: deepseek-flash$' "$CODE_REVIEWER_PROFILE/config.yaml" \
    && ok "code-reviewer profile keeps the direct deepseek-flash fallback" \
    || nope "code-reviewer profile keeps the direct deepseek-flash fallback"

echo "=== repo rules keep the gate invariants ==="
grep -Fq -- 'one approval on an unchanged HEAD' "$REPO_RULES" \
    && ok "repo rules require one approval on an unchanged HEAD" \
    || nope "repo rules require one approval on an unchanged HEAD"
grep -Fq -- 'invoke spec-auditor before code review' "$REPO_RULES" \
    && ok "repo rules invoke spec-auditor when a spec exists" \
    || nope "repo rules invoke spec-auditor when a spec exists"

echo ""
echo "dev-loop skill contract: $fail failed"
[ "$fail" -eq 0 ]
