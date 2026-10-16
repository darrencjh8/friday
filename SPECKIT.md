# Spec-Kit Quick Reference

Tag agent files with `@` in Zed to run each phase.

| Phase | Tag | What it does | Output |
|-------|-----|-------------|--------|
| **Specify** | `@.github/agents/speckit.specify.agent.md <description>` | Define what to build | `specs/<NNN-name>/spec.md` |
| **Clarify** _(optional)_ | `@.github/agents/speckit.clarify.agent.md` | Q&A for underspecified areas | Clarifications in spec.md |
| **Plan** | `@.github/agents/speckit.plan.agent.md <tech stack>` | Technical architecture | `plan.md`, `research.md`, `data-model.md`, `contracts/` |
| **Tasks** | `@.github/agents/speckit.tasks.agent.md` | Break into ordered tasks | `tasks.md` with [P] parallel markers |
| **Analyze** _(optional)_ | `@.github/agents/speckit.analyze.agent.md` | Cross-check consistency | Gap/coverage report |
| **Implement** | `@.github/agents/speckit.implement.agent.md` | Execute with TDD | Implementation + passing tests |

### E2E Example

```
@.github/agents/speckit.specify.agent.md Add a daily expense digest sent via Telegram at 8am
@.github/agents/speckit.clarify.agent.md
@.github/agents/speckit.plan.agent.md Use APScheduler, pull from expense-tracker API, format with Jinja
@.github/agents/speckit.tasks.agent.md
@.github/agents/speckit.analyze.agent.md
@.github/agents/speckit.implement.agent.md
```

### Key Rules

- Feature numbering is sequential (next is 014)
- Approve each phase before proceeding
- Constitution at `.specify/memory/constitution.md` (TDD mandatory, Docker-first, etc.)
