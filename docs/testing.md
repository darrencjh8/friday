# Testing

`.github/workflows/test.yml` (`Unit Tests`) is the gate. It runs on pull requests
targeting `main`, and `deploy.yml` also calls it via `workflow_call` before
deploying on non-push events. Keep this page in step with that file.

## The jobs

| Job | Working directory | Command | Notes |
|---|---|---|---|
| `expense-tracker` | `modules/expense-tracker` | `npm test` | needs `poppler-utils` and `qpdf` |
| `actual-api` | `modules/actual-api` | `npm test` | |
| `portfolio-tracker-unit` | `modules/portfolio-tracker` | `npx vitest run` on a named list of offline test files | blocking |
| `portfolio-tracker-ci-guard` | `modules/portfolio-tracker` | `npx vitest run tests/ci-gating.test.js` | keeps the unit job's file list honest |
| `portfolio-tracker` | `modules/portfolio-tracker` | `npm test` | `continue-on-error`: needs IBKR keys and live services, so red here does **not** block a merge |
| `pp-cli` | `modules/portfolio-tracker/pp-cli` | `mvn test` | installs the Portfolio Performance model JAR first |
| `compose-config` | repo root | `docker compose config -q` on every tracked `docker-compose.yml`, then `python -m unittest discover -s modules/tests` | |
| `hermes-scripts` | repo root | `shellcheck`, the `modules/hermes/tests/*.sh` suites, and the Python `unittest` modules listed in the job | |
| `hermes-webui-image` | repo root | builds the WebUI image when `modules/hermes/`, the compose file or `test.yml` changed | |
| `image-gen` | `modules/image-gen` | `node --test __tests__/server.test.js` | there is no `npm test` script |

`secrets-scan.yml` (gitleaks, PII literals, author email) and
`codex-router-ci.yml` (the router repository's suite, see
[operations.md](operations.md)) guard the rest.

Not every `modules/hermes/tests/*.sh` file is wired into `hermes-scripts`:
`test-config-nochown.sh`, `test-mnemosyne-seed.sh`, `test-mnemosyne-vacuum.sh`
and `test-skills-backup-restore.sh` have no CI step, so nothing exercises a
change to them unless you run them yourself.

## Running them locally

```bash
cd modules/expense-tracker && npm ci && npm test
cd modules/actual-api      && npm ci && npm test
cd modules/image-gen       && npm ci && node --test __tests__/server.test.js
bash modules/hermes/tests/test-50-seed-defaults.sh
python -m unittest discover -s modules/tests -p 'test_*.py'
```

The bash suites print their own result and exit non-zero on failure. For
`pp-cli`, copy the model-JAR install step from the `pp-cli` job rather than
guessing it.
