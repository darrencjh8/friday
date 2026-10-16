# GitHub issue parallel-creation race (friday #415/#416, 2026-09-09)

## What happened

User asked to "update this issue" (the opencode auto-thinking default-model draft) with added scope: confirm & verify all 3 interfaces (Hermes, OpenCode, Codex) load the rules by default (git worktree + update to latest origin/main before every work).

Assistant couldn't find the issue (the draft had not been created — approval had timed out in the earlier session). Timeline of the race:

| Time (UTC) | Event |
|---|---|
| 02:37:36 | Prior session presented the draft, asked "go ahead and create the issue?" — approval timed out |
| ~02:38:30 | User's message arrives ("update this issue to also ...") |
| 02:38:56 / 02:39:56 | Assistant lists friday issues twice — still NO #415 |
| 02:40:59 | **Parallel session creates #415** with the draft title |
| 02:42:28 | Assistant creates #416 (near-duplicate) — race window was ~90s |
| 02:43+ | #415 body replaced with full merged scope (edit --title/--body-file); #416 closed as duplicate with comment |

## Resolution commands

```bash
# 1. Confirm which issue is canonical (earlier / the one the user pointed at):
gh issue view -R darrencjh8/friday 415 --json number,title,state,url --jq '{number,title,state,url}'

# 2. Merge the full scope into the canonical issue (body staged in a file from the start):
gh issue edit -R darrencjh8/friday 415 \
  --title "<expanded title>" \
  --body-file issue-body.md \
  --add-label enhancement,high

# 3. Close the duplicate, pointing at the canonical:
gh issue close -R darrencjh8/friday 416 \
  --comment "Superseded by #415 — the expanded scope was merged into #415. Closing as duplicate."

# 4. Verify final state:
gh issue view -R darrencjh8/friday 415 --json number,title,state,labels,url
gh issue view -R darrencjh8/friday 416 --json number,state
```

## Takeaways

- Treat "want me to create this issue?" drafts as concurrently creatable by any sibling session.
- A single `gh issue list` early in the turn is NOT proof of non-existence; re-list immediately before `gh issue create`.
- When reconciling, the canonical issue is the one the user referenced (usually the EARLIER number); merge scope into it and close your own duplicate — never leave twin issues, never delete the user's canonical.
- Ambiguity resolution for "this issue" with no number: session_search the shared lineage for the last issue/draft on the table, then recency-sorted `gh issue list` on all sibling repos (the owner's repos are friday + codex-router).
