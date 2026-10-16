# OpenClaw Cron Seed Pattern

When changing a Hermes cron job in the OpenClaw deployment, update **both** places or the change silently reverts on next deploy:

## Two-step process

| Step | Action | Tool | Survives redeploy? |
|------|--------|------|--------------------|
| 1 | Update running job | `cronjob(action='update', ...)` | ✗ No |
| 2 | Update seed file in repo | PR to `modules/hermes/50-seed-defaults` | ✓ Yes |

## Repo location

The friday repo lives at `/opt/data/friday` (NOT `/workspace/friday`).

## Seed file

Path: `modules/hermes/50-seed-defaults`

The job definition includes `schedule.expr` and `schedule_display` fields. Both must be updated.

Test file at `modules/hermes/tests/test-50-seed-defaults.sh` also contains the cron expression in both the seed snippet copy and the assertion — update all three occurrences.

## Git identity

The repo may not have `user.name`/`user.email` set. Configure before committing:

```bash
git config user.name "Example"
git config user.email "<your-github-noreply-email>"
```

Verify with `gh auth status` (should show `darrencjh8`).
