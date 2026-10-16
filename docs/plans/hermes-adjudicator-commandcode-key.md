# Pass COMMANDCODE_API_KEY into the Hermes container

## QUESTIONS

```
q: Does the dev-loop adjudicator actually run inside the Hermes container, or on the host?
a: Inside the Hermes container. The driver resolves the key with `state.py` -> `ADJUDICATOR["api_key_env"]`, and the observed failure is the driver's own "is not set, so the round adjudicator fails closed" error, which only that code path raises.
q: Which environment variable name does the driver read?
a: The installed policy declares a list, `["COMMANDCODE_API_KEY", "COMMAND_CODE_API_KEY"]`, tried canonical first. The repo policy declares only the string `COMMAND_CODE_API_KEY`, and the repo copy of `loop.py` coerces `api_key_env` with `str()`, so the two copies disagree. This change does not touch that divergence.
q: Why is the key not already available, given the file at /opt/data/.env?
a: The container's `HOME` is `/root`, so the driver's `~/.env` fallback reads `/root/.env`, which does not exist. Even at `/opt/data/.env`, the file has no `COMMANDCODE_API_KEY` entry. Only an environment variable reaches the driver.
q: Is the key present in the deploy secrets already?
a: Yes. `.github/workflows/deploy.yml` already exports `COMMANDCODE_API_KEY` into the deploy step's environment, so the value is available to `docker compose` and only the Hermes service needs to declare it.
q: Does adding the variable to the Hermes service suffice for commandcode models to work there?
a: No. It fixes the adjudicator, which calls the Command Code API directly with this key. Making `commandcode/*` models routable inside Hermes is the codex-router container's concern, and that service already declares the key. This change intentionally scopes to the direct caller.
q: Is a new test needed, or does an existing one cover it?
a: A new test is needed. The existing provider-env test asserts the key reaches the `codex-router` service only, so it passed while the Hermes service was missing the key, which is exactly the gap being fixed.
```

## Problem

The dev-loop round adjudicator fails closed inside the Hermes container:

```
COMMAND_CODE_API_KEY is not set, so the round adjudicator fails closed; set it or disable the adjudicator
```

The adjudicator is required for every plan round and every code round, so no gate can advance.

## Root cause

The key is wired to exactly one container. In `modules/docker-compose.yml`:

- the `codex-router` service declares `- COMMANDCODE_API_KEY=${COMMANDCODE_API_KEY:-}` (line 128),
- the `hermes` service declares no such variable.

`modules/deploy.sh` validates the variable as required, but that validation is scoped to the `codex-router` section, so a deploy passes while the Hermes container has no key.

Verified read-only on the production host, inside the running Hermes container:

```
HOME=/root
env | grep -c COMMANDCODE   -> 0
/root/.env                  -> missing
/opt/data/.env              -> exists, mode 744, no COMMANDCODE_API_KEY entry
```

So both key sources the driver consults are unavailable: the environment does not carry the key, and the `~/.env` fallback resolves against `/root`, not `/opt/data`.

## Change

One line in `modules/docker-compose.yml`, in the `hermes` service's `environment` list:

```yaml
- COMMANDCODE_API_KEY=${COMMANDCODE_API_KEY}
```

This makes the variable the driver's first-priority source, so the unreachable `~/.env` fallback stops mattering. No driver change, no policy change, and the adjudicator is not disabled.

The deploy workflow already exports the secret into the compose invocation, so no workflow change is required.

## Tests

TDD, following the existing pattern in `modules/tests/test_codex_router_provider_env.py`.

RED: add a test asserting the `hermes` service forwards `COMMANDCODE_API_KEY`. It must fail against the unmodified compose file.

GREEN: add the compose line, and it passes.

The test belongs beside the existing router-service assertion, because the class already documents that "a key that never reaches the container silently disables every Command Code model". This change extends that same invariant to the container that calls the API directly.

Run: `python -m unittest discover -s modules/tests -p 'test_*.py'`

## Out of scope

- The repo/installed divergence in `loop.py` (`str()` vs list `api_key_env`, and the missing `~/.env` fallback in the repo copy). It is a real trap but a separate change in a separate repository.
- Disabling the adjudicator. `policy.json`'s `adjudicator` block is the only switch, and `on_unavailable: "llm"` already degrades rather than wedging.

## Verification after deploy

Read-only, one command, with user approval:

```
docker exec hermes sh -lc 'env | grep -c COMMANDCODE'
```

Expect `1`. Then a plan round advances past the adjudicator.
