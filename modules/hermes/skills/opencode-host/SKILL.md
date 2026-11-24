---
name: opencode-host
description: Use to hand a coding task to OpenCode on the host (implement, fix, refactor, review code in friday, codex-router or hermes-dots), and to follow up on it.
version: 1.0.0
author: Hermes Agent
license: MIT-0
metadata:
  hermes:
    tags: [opencode, coding, delegation]
    related_skills: [opencode, hermes-troubleshooting]
---

# OpenCode on the host

`opencode serve` runs on the machine that runs Hermes (the laptop) as the systemd user service `opencode-serve`. The `opencode-host` CLI drives it over its API; the `opencode` binary is not in this container, so use this instead of `opencode run`.

- Start a task: `opencode-host start <repo> "<task>"`. `<repo>` is a checkout under `/home/darren/workspace` on the host (`friday`, `codex-router`, `hermes-dots`) or an absolute host path. Write the task like a GitHub issue: goal, acceptance criteria, constraints. It prints the session id.
- Check on it: `opencode-host read <session-id>` prints `done` or `still working`, then the latest reply. Tasks take minutes; check back rather than polling in a tight loop.
- Follow up: `opencode-host send <session-id> "<message>"`.
- Recent sessions: `opencode-host list`.

The user can watch and steer the same sessions in the OpenCode web UI. OpenCode uses the models behind codex-router.

If it is unreachable, the service may be down on the host: `systemctl --user status opencode-serve` there (the user's laptop), not in this container.
