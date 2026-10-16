# Agent Instructions for friday

## Communication
- Get to the point. No polite filler ("That's right", "I'm sorry", "Great question", "Sure thing", "Let me explain").
- State the action, result, or next step. Drop conversational fluff.
- Follow global `caveman` ultra guidance for agent communication. Do not compress evidence, safety warnings, code, commands, errors, commits, issues, pull requests, or documentation.

## General

- Always propose a plan before making changes. Wait for explicit approval before implementing.
- Before running any command on production for the first time, ask for explicit approval.
- Never expose or commit credentials, tokens, `.env` files, `modules/expense-tracker/db.sqlite`, or `modules/expense-tracker/metadata.json`.

## Production Server

- Production host details are in global Codex rules.
- Never restart, rebuild, pull, or deploy directly on production. Always use the GitHub Actions CI/CD pipeline.
- Never run `docker compose`, `git pull`, `deploy.sh`, or direct deployment commands on production.
- For config-only intervention or CI/CD failure, ask the user for direction; do not perform manual production remediation by default.
- Before any production debug, inspection, test, or verification command, ask for explicit approval.

## Configuration

- Verify any changes against official docs:
  - https://hermes-agent.nousresearch.com/docs/user-guide/configuration
  - https://github.com/NousResearch/hermes-agent/tree/main/docs
  - https://docs.openclaw.ai/start/hubs
  - https://github.com/openclaw/openclaw/tree/main/docs
- Do not guess schema.

## Planning

- Always propose a plan before making changes. Wait for explicit approval.
- Before running any test/verification command on production for the first time, explicitly ask the user for approval — never assume it's safe.

## Implementation
- Start from a clean worktree. If it is dirty, ask the user before proceeding.
- Create `feat/...` or `fix/...` branches. Never commit or push directly to `main`.
- For behavior changes, write a failing test first, implement the minimum passing change, then refactor with tests green.
- For documentation, configuration, or skill changes with no testable behavior, state why TDD does not apply and run relevant validation.
- When a relevant specification or approved implementation plan exists, invoke spec-auditor before code review. Skip spec-auditor only when no relevant specification exists.
- Fix validated Critical and High findings before merge. Cosmetic notes, style preferences, and coverage-only suggestions do not block the loop.
- Require one approval on an unchanged HEAD before merge. Any repository mutation or `REQUEST_CHANGES` after that approval invalidates it. This must stay aligned with `required_clean_rounds` in `darrencjh8/codex-router` `codex/skills/dev-loop/policy.json`, which is authoritative.
- Push a branch, open a pull request, wait for required GitHub Actions checks, then squash-merge. CI/CD owns deployment after merge.


## Git Operations

### Primary: Use `gh` CLI
For pushing, pulling, and interacting with GitHub, always prefer the `gh` CLI tool over MCP.

```bash
# Clone
gh repo clone darrencjh8/friday

# Create branches
gh repo fork / clone / create

# Pull requests
gh pr create / list / view / merge

# Issues
gh issue create / list / view

# Auth
gh auth login    # One-time setup
gh auth status   # Check current auth state
```

### Secondary: GitHub MCP Server
Use MCP GitHub tools only when `gh` CLI cannot accomplish the task (e.g., searching code across GitHub, creating files directly in repos without local clone).

### Never use:
- MCP `push_files` for initial commits on empty repos (use `gh` + `git` instead)
- MCP for large multi-file pushes (use `git add -A && git commit && git push`)

## Repository: darrencjh8/friday

- **URL:** https://github.com/darrencjh8/friday
- **Status:** Initialized with README.md, .gitignore, config files, and constitution.md
- **Remaining files to push locally:** spec.md, plan.md, tasks.md, agent.md, design.md, source stubs

---

## Excluded files (never commit)
- `modules/expense-tracker/db.sqlite` — dedup journal with transaction hashes
- `modules/expense-tracker/metadata.json` — Actual Budget IDs, user UUIDs, encryption keys
- `.env` / `.env.*` — API keys and credentials

These are covered by `.gitignore`.

## No personal data in public content
This repository is public. Never put personal data in code, fixtures, docs, commit messages, issues, or pull requests: no names, emails, phone numbers, account or card numbers, addresses, chat user IDs, or private hostnames. Use placeholders (`user@example.com`, `U00000000AA`, `your-host.your-tailnet.ts.net`) and synthetic numbers listed in `scripts/pii-synthetic-numbers.txt`.
