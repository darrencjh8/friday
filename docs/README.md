# Friday — knowledge base

How Friday is put together, how to run it, and where each decision is written
down. The [root README](../README.md) stays a short overview; the detail lives
here.

## Start here

| Page | Contents |
|---|---|
| [architecture.md](architecture.md) | The Docker Compose topology, the service graph, and the expense- and portfolio-tracking pipelines end to end. |
| [repository-layout.md](repository-layout.md) | Every directory and what belongs in it, plus the modules that are present but not deployed. |
| [setup.md](setup.md) | Clone, per-module `.env`, and the `deploy.sh` / `build.sh` entry points. |
| [operations.md](operations.md) | Health endpoints, the CI/CD deploy flow, the other workflows, and the published ports. |
| [testing.md](testing.md) | The CI jobs and how to run each suite locally. |
| [troubleshooting.md](troubleshooting.md) | The failures you will actually hit, and where each answer lives. |
| [glossary.md](glossary.md) | The domain terms, tool names, and acronyms used across these pages. |

## Specifications

Feature specs live in [specs/](../specs/), one directory per feature. Most follow
the Spec-Kit layout (`spec.md`, `plan.md`, `tasks.md`); the smaller ones carry
only the files they need.

| Spec | Feature |
|---|---|
| [001-gateway](../specs/001-gateway/spec.md) | Gateway (Hermes Agent) |
| [002-expense-tracking](../specs/002-expense-tracking/spec.md) | Automated Expense Tracking |
| [003-portfolio-tracker](../specs/003-portfolio-tracker/spec.md) | Portfolio Tracker |
| [004-statement-reconciliation](../specs/004-statement-reconciliation/spec.md) | Statement Reconciliation & Email Routing |
| [006-portfolio-cpf-sync](../specs/006-portfolio-cpf-sync/spec.md) | CPF Statement PDF Sync |
| [008-portfolio-poems-sync](../specs/008-portfolio-poems-sync/spec.md) | POEMS Statement PDF Sync |
| [013-manual-tests](../specs/013-manual-tests/spec.md) | Manual Pipeline Tests |
| [016-telegram-link-preview](../specs/016-telegram-link-preview/spec.md) | Telegram Link Preview Disable |
| [021-three-phase-refactor](../specs/021-three-phase-refactor/spec.md) | Three-Phase Orchestrator Refactor |
| [030-spec-drift](../specs/030-spec-drift/audit.md) | Spec drift audit, consolidation plan, and code notes |

## Design notes and plans

| Document | Contents |
|---|---|
| [plans/](plans/) | The approved plan for each change of substance: the Hermes container's codex-router checkout, DeepSeek Flash routing, LiteLLM account-pool fallbacks, and the bill-payment and transfer-pair fixes. |
| [expense-tracker/spec-code-drift-verification-2026-06-23.md](expense-tracker/spec-code-drift-verification-2026-06-23.md) | Generated check that the expense-tracker spec still matches the shipped code. |

## Documents that stay at the root

These are operationally load-bearing where they are, so they are not moved here.

| Document | Contents |
|---|---|
| [../DEPLOY.md](../DEPLOY.md) | Deployment flow, entry points, module registration, and the production host. |
| [../SETUP.md](../SETUP.md) | Host, users, directory, volume, and cron layout for the production server. |
| [../design.md](../design.md) | The architecture document, including the Hermes migration and hosting topology. |
| [../SPECKIT.md](../SPECKIT.md) | Spec-Kit usage for this repository. |
| [../AGENTS.md](../AGENTS.md) | Instructions for agents working in this repository. |

## Module documentation

| Document | Contents |
|---|---|
| [../modules/hermes/SLACK.md](../modules/hermes/SLACK.md) | Slack app setup, Socket Mode, and tokens/scopes. |
| [../modules/portfolio-tracker/README.md](../modules/portfolio-tracker/README.md) | Portfolio tracker detail and local run instructions. |
| [../modules/expense-tracker/docs/design.md](../modules/expense-tracker/docs/design.md) | Expense tracker design. |
| [../modules/hermes/skills/](../modules/hermes/skills/) | Skill packs: `expense-tracker`, `image-gen`, `spec-auditor`, `hermes-troubleshooting`. |
| [../.agents/skills/full-deploy/SKILL.md](../.agents/skills/full-deploy/SKILL.md) | Full-deploy operator runbook. |
