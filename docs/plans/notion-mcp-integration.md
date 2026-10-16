QUESTIONS
q: Does the `darren-prod` environment secret `NOTION_API_TOKEN` hold the same token as the working local `modules/hermes/.env` value? | assumption: yes. GitHub secrets are write-only, so this is not verifiable from this repository; the local token was measured working against `api.notion.com`. If the assumption is wrong the symptom is a 401 from Notion after deploy, and the fallback is to create an environment secret named `NOTION_API_KEY` from the working local value and revert the workflow line to `secrets.NOTION_API_KEY`.
q: Where must the MCP server be installed so that both an image rebuild and a container recreate keep it? | a: In the persisted `/opt/data` volume, through the "Ensure Hermes container tooling" step that already installs `gh` and `ntn`. `/opt/data/.local/bin` is on the container PATH, and `modules/tests/test_deploy_workflow_router.py:396` forbids CLI tools in the image.
q: Is `/opt/data/.local/bin` on the PATH Hermes uses when it spawns a stdio MCP server? | a: Yes. Measured in the running container: `PATH=/opt/hermes/bin:/opt/hermes/.venv/bin:/opt/data/.local/bin:...`, and Hermes passes `PATH` through to stdio servers.
q: Does the new MCP server conflict with the `productivity/notion` skill already on the volume? | a: No. That skill is a hub skill on the data volume, not a file in this repository, so this change neither edits nor removes it.
q: Does insurance need its own database? | a: No. Insurance already lives as rows inside databases that are shared with the integration; the only search match is the page `CIMB eCard (Insurance)`, whose parent is a data source row.
q: Is a failed stdio MCP spawn non-fatal, so the introducing deploy goes green while the notion tools are absent? | assumption: yes. Hermes registers a server's tools at connect time and the docs describe a failed remote server as logging and leaving the other servers running, but no doc line states the stdio case outright, so this is an assumption rather than a citation. If it is backwards — a missing `notion-mcp-server` makes Hermes treat the server as fatal — the symptom is loud rather than silent: `deploy.sh`'s post-`up` checks or the container health check fail, the deploy goes red, and the operator skips the reload and waits for the tooling step to be re-ordered. Either way the activation steps in this plan remain the correct next action once the binary is on the volume.

## Intent

Make Hermes able to read the Notion finance knowledge base (bank accounts, cards, insurance) and to write to it through an approval-gated MCP surface, without copying a secret value and without adding a container, a port, or a second credential. Tracked by #681.

"Approval-gated" is a property of the MCP surface, not a boundary around the credential: `NOTION_API_KEY` is in the hermes container environment (`modules/docker-compose.yml:263`) and the agent's terminal runs in that same container (`modules/hermes/config.yaml:69-72`, `terminal.backend: local`, `persistent_shell: true`), so a shell command can still reach `api.notion.com` with that token directly. The gate stops an MCP *tool* call; it does not stop `curl`. This is recorded as an accepted limitation in Risks.

Two independent faults block this today, both confirmed by read-only production inspection:

1. **The secret name does not match the reference.** The `darren-prod` environment holds `NOTION_API_TOKEN`, while `.github/workflows/deploy.yml:159` injects `secrets.NOTION_API_KEY`. A missing secret interpolates to an empty string rather than failing, so the container starts with `NOTION_API_KEY=` — measured length `0` inside the running container. `modules/docker-compose.yml:263` already forwards that variable to the `hermes` service and `modules/deploy.sh:599` already validates it as optional, so the only broken link is the name.
2. **No Notion MCP server is registered.** `modules/hermes/config.yaml:143` lists only `expense-tracker` and `portfolio-tracker`, so no `mcp__notion__*` tools exist and the empty token has nothing to be empty for.

## Current behaviour (traced)

- `.github/workflows/deploy.yml:159` passes `NOTION_API_KEY: ${{ secrets.NOTION_API_KEY }}` into the deploy step's environment; the same step runs `modules/deploy.sh` at `:197` and `:201`.
- `modules/docker-compose.yml:263` maps `NOTION_API_KEY=${NOTION_API_KEY}` into the `hermes` container's environment; the value therefore comes from the workflow, and from a local `.env` during a local deploy.
- `modules/deploy.sh:599` calls `check_var_optional "NOTION_API_KEY"`, so an empty or absent value is accepted silently — which is why this has been broken without any failing run.
- `modules/hermes/config.yaml:143` holds `mcp_servers:` with two HTTP entries and no notion entry.
- `.github/workflows/deploy.yml:204-233` installs `gh` and `ntn` into `/opt/data/.local` inside the running container, guarded by `command -v`, and finishes with `docker exec hermes sh -c 'gh --version && ntn --version'`.
- `modules/tests/test_deploy_workflow_router.py:396` pins the image rule: `assertNotIn("npm install --global", dockerfile)`.
- Production state, read-only: container env `NOTION_API_KEY` length 0; container `PATH` includes `/opt/data/.local/bin`; node v26.5.1, npm 11.17.0; `ntn 0.23.17` present but unusable without `NOTION_WORKSPACE_ID`.
- The working local token sees 201 pages and 7 data sources: `Miles Calculator`, `Accounts`, `Credit Cards`, `Singapore`, `Malaysia`, `Miles Constants`, `Exchange Rate`.
- The official server `@notionhq/notion-mcp-server@2.5.2` exposes 24 tools named `API-<operationId>`. It sets `readOnlyHint: true` only on GET tools and `destructiveHint: true` on everything else (`src/openapi-mcp-server/mcp/proxy.ts:171-188`), which is why `API-post-search` and `API-query-data-source` cannot share a `trust: untrusted` entry with the write tools.

## Target design

### `.github/workflows/deploy.yml`

Line 159, point at the secret that exists:

```yaml
                  NOTION_API_KEY: ${{ secrets.NOTION_API_TOKEN }}
```

Inside the "Ensure Hermes container tooling" step, after the `ntn` install (`:230-232`), install the MCP server the same way — into the volume, guarded, pinned:

```sh
                  if ! docker exec hermes npm ls --global --prefix /opt/data/.local --depth=0 @notionhq/notion-mcp-server 2>/dev/null | grep -q '@notionhq/notion-mcp-server@2.5.2'; then
                      docker exec hermes npm install --global --prefix /opt/data/.local @notionhq/notion-mcp-server@2.5.2
                  fi
```

The step's closing verification (`:233`) gains the same existence check used by the guard, because the server exposes no `--version` flag:

```sh
                  docker exec hermes sh -c 'gh --version && ntn --version && command -v notion-mcp-server'
```

### `modules/hermes/config.yaml`

Append two entries under `mcp_servers:` (`:143`). Both spawn the same stdio server and read the token through the environment reference that Hermes resolves at connect time, so no secret lands in the file:

```yaml
    notion:
        command: notion-mcp-server
        env:
            NOTION_TOKEN: ${NOTION_API_KEY}
        supports_parallel_tool_calls: false
        tools:
            include:
                - API-get-self
                - API-post-search
                - API-query-data-source
                - API-retrieve-a-data-source
                - API-retrieve-a-database
                - API-retrieve-a-page
                - API-retrieve-a-page-property
                - API-retrieve-page-markdown
                - API-get-block-children
                - API-list-data-source-templates
            resources: false
            prompts: false
    notion-write:
        command: notion-mcp-server
        env:
            NOTION_TOKEN: ${NOTION_API_KEY}
        supports_parallel_tool_calls: false
        trust: untrusted
        tools:
            include:
                - API-post-page
                - API-patch-page
                - API-update-page-markdown
                - API-create-a-comment
            resources: false
            prompts: false
```

The split is the whole point of the second entry: `include` cannot be conditioned on approval, and `trust: untrusted` gates every tool without `readOnlyHint: true`. A single entry would either expose writes ungated or demand approval for every read, because search and query are POSTs. No dedicated delete, archive, schema-change or page-move tool is exposed; archiving stays reachable through the gated `API-patch-page` (a page PATCH accepts `archived` / `in_trash`), so the property that holds is "no ungated destructive capability", not "no destructive capability".

### Which approval policy decides a write (finding P1)

`trust: untrusted` only routes a non-`readOnlyHint` tool call into the approval surface; what happens next is `modules/hermes/config.yaml:41-44`:

```yaml
approvals:
    mode: smart
    timeout: 60
    cron_mode: allow
```

with an LLM judge configured at `auxiliary.approval` (`:104-109`, provider `custom:codex-router`, model `auto-thinking`). Two consequences the plan states rather than leaves implicit:

- In an interactive session, `mode: smart` sends the write to the approval judge first; a judge that cannot reach a decision falls through to the human surface, and `timeout: 60` bounds the wait. So a Notion write is deliberate and visible, which is the whole purpose of the second server entry.
- **`cron_mode: allow` means an unattended (cron-initiated) turn does not wait for approval at all.** A scheduled job that calls a write tool proceeds. This is the existing policy for every MCP server in this deployment, not something this change introduces, and it is named here so the gate is not described as stronger than it is.

### `modules/tests/test_notion_mcp_wiring.py` (new)

One `unittest` file in the established `modules/tests` style, guarding the wiring that has no runtime test:

- `test_workflow_uses_the_existing_notion_api_token_secret` — the workflow passes `secrets.NOTION_API_TOKEN` and contains no `secrets.NOTION_API_KEY`.
- `test_workflow_installs_the_pinned_mcp_server_into_the_volume` — the tooling step installs `@notionhq/notion-mcp-server@2.5.2` with `--prefix /opt/data/.local`, gates the install on the installed **version** (`npm ls --global --prefix /opt/data/.local --depth=0 @notionhq/notion-mcp-server` piped into a `grep` for the pinned `@notionhq/notion-mcp-server@2.5.2`), and verifies the binary at the end of the step; the Dockerfile still contains no `npm install --global`. The version gate is asserted rather than bare `command -v` presence, because a presence-only guard would let a later version bump silently no-op on a volume that already holds an older server.
- `test_config_registers_read_and_gated_write_servers` — parsed YAML has both entries, both map `NOTION_TOKEN` to `${NOTION_API_KEY}`, the read include list holds search and query, the write entry carries `trust: untrusted`, and no entry exposes `API-delete-a-block`, `API-create-a-data-source`, `API-update-a-data-source` or `API-move-page`.

## Validation

No production behaviour changes in this repository: the change is a workflow line, one install block, and YAML config. Per the dev-loop policy's config/workflow exception, the gate is a green check plus the applicable parse validation, and no base RED is claimed:

- GREEN: `python3 -m unittest discover -s modules/tests -p 'test_notion_mcp_wiring.py'` passes at HEAD, and `python3 -m unittest discover -s modules/tests -p 'test_*.py'` passes in full — measured green at base, 75 tests in 16.7 s, and the new file adds three more.
- Parse validation: the changed YAML is exercised by the new test, which `yaml.safe_load`s `modules/hermes/config.yaml` and reads `.github/workflows/deploy.yml` as text.
- **No `--mutation-command` is offered (finding P3).** A base replay of the new test cannot be assertion evidence: `modules/tests/test_notion_mcp_wiring.py` does not exist at base, so `unittest discover` collects nothing, exits 5 with `NO TESTS RAN` on Python 3.12+ (measured on 3.13.5), and would exit 0 on an older interpreter. That is a missing-file signal, not a failing assertion, and the driver's `_FailedTest|ModuleNotFoundError|AttributeError` warning does not cover it. The RED this change can honestly claim is "the file is absent at base, so no guard runs"; the assertions themselves are first exercised at HEAD.

### Activation: the introducing deploy does not converge (finding M3)

The step that installs the tool runs *after* `Deploy services`, and `modules/tests/test_deploy_workflow_router.py:426` pins that order (`Deploy services` before `Ensure Hermes container tooling`). The recreated container therefore boots with the new config while `notion-mcp-server` is still absent, and Hermes registers MCP servers at boot. So the introducing deploy is expected to report green while exposing no `mcp__notion__*` tool (assumption recorded in the QUESTIONS block). The tooling step cannot simply move earlier: it `docker exec`s into the running container, so it requires the container to exist.

Required activation, once, after the introducing deploy — production commands, each needing explicit operator approval first. No step here restarts, rebuilds, pulls, or deploys anything on production; the repo forbids those as manual actions (finding P2):

1. `docker exec hermes sh -c 'command -v notion-mcp-server && npm ls --global --prefix /opt/data/.local --depth=0 @notionhq/notion-mcp-server'` — confirm the pinned binary landed.
2. `/reload-mcp` from a gateway chat. This is the primary and only planned activation path: Hermes reloads `mcp_servers` from the config it already seeded, so no container restart is needed. `hermes mcp` has no `reload` subcommand (`hermes mcp --help` lists only serve, add, remove, list, test, configure, login, reauth, picker, catalog, install), which is why the reload goes through the chat surface. If the reload does not register the server, the fallback is a normal re-deploy through CI/CD — never a manual restart on production.
3. `docker exec hermes hermes mcp test notion` and confirm the server's tools are registered. Note this checks the connection, not the token: the Notion server answers `initialize` without validating `NOTION_API_KEY`.
4. Read check: ask Hermes for the `Accounts` data source and confirm a real `mcp__notion__*` result.
5. Write check (the safety property, finding P1): have Hermes call `mcp__notion-write__API-create-a-comment`, which adds a comment and mutates no finance data. Record which surface decided — an approval prompt in the interactive session, or the smart judge answering on its own — and that the comment landed in Notion. A write that silently succeeds with no prompt, or one that fails closed, is a finding against this change, not a pass.

Every later deploy that recreates the hermes container converges on its own, because the tool is already on the persisted volume. Steps 3-5 are part of this plan, not optional follow-ups.

## Risks and non-goals

- **Token mismatch.** If the GitHub secret holds a different or revoked token, the deploy succeeds and Notion answers 401. Fallback is documented in the QUESTIONS block. This change never reads, copies, or rotates the value.
- **The approval gate is not a credential boundary (finding M2).** `trust: untrusted` gates MCP tool calls. It does not gate the agent's shell, which runs in the hermes container (`terminal.backend: local`, `persistent_shell: true`) and therefore inherits `NOTION_API_KEY` from `modules/docker-compose.yml:263`. `curl -X PATCH https://api.notion.com/v1/pages/<id> -H "Authorization: Bearer $NOTION_API_KEY"` writes to Notion with no approval prompt. Accepted rather than fixed: the same is already true of every other container secret this agent holds (`IMAP_PASSWORD`, `ACTUAL_BUDGET_PASSWORD`, `FRIDAY_PAT`), and the gate's purpose here is to make an MCP write deliberate and visible, not to contain the agent against itself. A future change could mount the token as a file read only by the server process, which would make the claim unqualified; that is out of scope here.
- **Introducing deploy is inert until activated (finding M3).** See the Activation section: the first deploy green-lights the wiring but exposes no notion tool until `/reload-mcp` runs once. Watch item: if that assumption about non-fatal stdio spawn is wrong, the deploy fails loudly instead, which is still detectable.
- **Unattended writes are not gated (finding P1).** `approvals.cron_mode: allow` (`modules/hermes/config.yaml:44`) means a cron-initiated turn bypasses the approval surface, so a scheduled Notion write proceeds without a human. Existing policy for every MCP server here; named so the gate is not overstated.
- **Archive is reachable through the gated patch tool (finding P4).** `API-patch-page` accepts `archived` / `in_trash`, so a page can be trashed after approval. There is no dedicated delete or archive tool, and no ungated destructive path.
- **Pinned server version.** `2.5.2` is pinned, and the install is gated on the installed version rather than on binary presence, so a later bump actually replaces the volume copy instead of silently no-opping. Unpinned `latest` was rejected because a silent behaviour change in a tool that writes to a financial record store is worse than an explicit bump.
- **Two stdio servers** are spawned instead of one, each a small Node process. Accepted: it is the only way to gate writes without gating reads.
- Non-goal: the `productivity/notion` hub skill on the volume, the `ntn` workspace problem, and the insurance data model are all out of scope.
