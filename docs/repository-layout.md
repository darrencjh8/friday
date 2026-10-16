# Repository layout

```
friday/
├── modules/
│   ├── docker-compose.yml            # The seven runtime services (router front + two colours)
│   ├── deploy.sh                     # Env validation + build + compose up + health checks
│   ├── build.sh                      # Image builds only (no downtime)
│   ├── codex-router-auth-recovery.py
│   ├── actual-api/                   # Node.js REST proxy in front of Actual Budget
│   ├── expense-tracker/
│   │   ├── src/                      # orchestrator, classify, imap, tools, statement/
│   │   ├── tests/  __tests__/        # Vitest / Node test suites
│   │   ├── docker/Dockerfile
│   │   ├── config/  docs/
│   │   └── .env.example
│   ├── hermes/
│   │   ├── Dockerfile                # FROM nousresearch/hermes-agent
│   │   ├── config.yaml               # Providers, MCP servers, platforms, memory
│   │   ├── 50-seed-defaults          # Container init: seeds config, SOUL, cron jobs, skills
│   │   ├── SOUL.md.template
│   │   ├── SLACK.md                  # Slack app setup and Socket Mode notes
│   │   ├── profiles/                 # code-reviewer (friday default profile is seeded at boot)
│   │   ├── scripts/                  # github-auth, memory-backup/restore/triage, portfolio-sync, slack-manifest, skill sync
│   │   ├── skills/                   # expense-tracker, image-gen, spec-auditor, hermes-troubleshooting
│   │   └── tests/
│   ├── portfolio-tracker/
│   │   ├── src/                      # orchestrator, imap, tools, mcp-server, onedrive, ibkr, sheets
│   │   ├── tests/
│   │   ├── pp-cli/                   # Java CLI for Portfolio Performance XML
│   │   ├── docker/Dockerfile
│   │   ├── .env.example
│   │   └── README.md
│   ├── image-gen/                    # Standalone image tool (has tests; NOT a compose service)
│   ├── perchance-gen/                # Perchance image script used by image-gen
│   ├── onedrive-sync/                # Legacy config dir; referenced only for the OAuth token path
│   └── tests/                        # Python tests for compose + workflow wiring
├── specs/                            # Spec-Kit feature specs (001-gateway … 030-spec-drift)
├── docs/                             # Design notes and verification records
├── scripts/                          # Host and runner helper scripts
├── .github/workflows/                # deploy, test, codex-router sync/recovery, secrets scan
├── .agents/skills/full-deploy/       # Operator runbook skill
├── design.md                         # Current architecture document
├── DEPLOY.md  SETUP.md               # Deployment flow and production host setup
├── SPECKIT.md
└── AGENTS.md                         # Instructions for agents working in this repo
```

Notes on the tree:

- `modules/codex-router/` is absent from a fresh clone — CI checks it out as part of deployment.
- `modules/image-gen/` and `modules/perchance-gen/` are present and tested, but `image-gen` is **not** a service in `modules/docker-compose.yml`, so `--component all` does not deploy it.
- `modules/onedrive-sync/` is retained only because `modules/deploy.sh` still points at `modules/onedrive-sync/config/onedrive` for the OAuth refresh token. The rclone sync container it used to describe is retired; portfolio sync now happens in `src/onedrive.js`.
