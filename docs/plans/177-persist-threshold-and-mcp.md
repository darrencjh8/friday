QUESTIONS
q: Should live-added MCP servers survive a restart, or should the fix only document the checked-in path to declare them? | a: They should survive. The extension comment on #177 asks for persistence, and the per-server carry does that while keeping baked servers authoritative.
q: On a name conflict between a baked and a live MCP server, which wins? | a: The baked server wins, matching the existing baked-wins merge rule.
q: Is the scope threshold-only for compression, with no other compression changes? | a: Yes. Only threshold_tokens changes, 300000 -> 350000.
q: How is a server retired from the main config, given live-only servers are now carried? | a: By a named retired-server drop list in the main merge (starting with ktmb-booking). When an operator removes a server from the baked config they add its name to that list in modules/hermes/50-seed-defaults; the merge drops listed servers from the live file and never carries them back.
q: How are live-only servers inserted into the merged file, and what happens with malformed live data? | a: Inserted after the last line of the baked mcp_servers block, before the next top-level key; serialised with yaml.safe_dump of the single-server mapping and re-indented +4 spaces. If baked has no mcp_servers block, a new top-level block is appended. Non-dict live mcp_servers, or a non-dict server entry, is ignored with a warning on stderr, never carried.

# Plan: persist compression threshold 350000 and live MCP servers across restart (issue #177)

## Goal

Fix issue #177: the live `compression.threshold_tokens=350000` (set 2026-11-08 via
`hermes config set`) is lost on the next deploy/restart because the checked-in
`modules/hermes/config.yaml` still has 300000, and the boot seed merge wipes
live-added MCP servers the same way.

## Evidence

- Reproduction recorded with dev-loop (`loop.py repro`, phase REPRODUCED):
  command `python3 modules/tests/test_issue_177.py`, test id
  `tests.test_issue_177.TestIssue177.test_threshold_and_mcp_persistence`.
  At base `1263933` it fails twice: threshold is 300000, and a live-only
  `mcp_servers` entry (`live-added-server`) is wiped by the seed merge.
- Root cause, `modules/hermes/50-seed-defaults`: the merge writes the baked
  config bytes verbatim and only carries over top-level keys the baked config
  does not define. `mcp_servers` is a top-level key the baked config defines,
  so the baked block wins wholesale and every live-only server under it is
  dropped. The same wholesale win applies to `compression`, so the live
  350000 reverts to the baked 300000.

## Changes

1. `modules/hermes/config.yaml`: `compression.threshold_tokens` 300000 ->
   350000. No other compression setting changes (`threshold` stays 0.90,
   `enabled` stays true, all other keys untouched).
2. `modules/hermes/50-seed-defaults` (PYCONFIG merge block): merge
   `mcp_servers` per server instead of wholesale.
   - Baked servers win per server on a name conflict.
   - Live-only servers (present in the live file, absent from the baked file)
     are carried into the merged file.
   - Retired servers are dropped by a named list in the main merge:
     `retired_mcp_servers = ("ktmb-booking",)` as a second, separate tuple
     in the PYCONFIG main-merge block (the profile migration in the same
     file has its own tuple at line 313 for profile configs; the two are
     not shared). Retired filtering applies on every merge path, including
     the appended-block path when the baked config has no `mcp_servers:`
     block. Precedence: the retired list applies to the live/carried side only —
     a name on the list is dropped from the live file and never carried
     back, including on the appended-block path. It does not strip a name
     that is still present in the baked block: that case is an operator
     error (list entry added while the name is still baked), and the
     merge leaves the baked entry in place. The test asserts retired
     filtering on the appended-block path as well as the main path. Rule for future entries:
     when an operator removes a server from the baked `mcp_servers` block
     they add its name to this list in the same change; the merge drops
     listed servers from the live file and never carries them back. A server
     removed from baked without a list entry is therefore an explicit
     operator error, not a silent resurrection.
   - Insertion algorithm: the merge still writes the baked bytes unchanged
     first (comments and formatting survive). It then locates the baked
     `mcp_servers:` top-level line, finds the end of that block as the next
     top-level key line (column 0, non-empty, not a comment) or end of file,
     and inserts each live-only server after the last line of the block,
     before that next top-level key. Each server is serialised with
     `yaml.safe_dump({name: value}, sort_keys=False, indent=4)` and every
     line re-indented by 4 spaces, so a server name lands at the baked entry
     indent (4 spaces), its subkeys one level deeper (8 spaces), and nested
     lists/values keep their relative indentation. (`safe_dump`'s default
     indent is 2, which would put subkeys at 6 spaces; `indent=4` is
     required for the 4-space step the baked file uses.) If the baked config has
     no `mcp_servers:` block at all, a new top-level block is appended
     (the existing carried-key path). If a live server value is not a
     mapping, or the live `mcp_servers` value is not a dict, that entry /
     block is ignored with a warning on stderr and is never carried.
   - Header comment updated: the "baked `mcp_servers` wins, so a retired MCP
     server cannot survive" claim is replaced with the per-server rule above,
     naming the retired-server drop list as the retirement path.
3. Tests:
   - `modules/hermes/tests/test-model-routing.sh`: threshold expectation
     300000 -> 350000.
   - `modules/hermes/tests/test-50-seed-defaults.sh`: seeded threshold
     expectation 300000 -> 350000; derived-trigger expectations updated for
     the new cap (400000 window -> 350000, 1048576 window -> 350000,
     272000 window stays 244800); the derived-trigger ok message at
     `test-50-seed-defaults.sh:1369` ("min(floor_ratio x window, 300000)")
     is updated to 350000. The new seed-merge case is written (and observed
     failing) BEFORE the merge change. It asserts live-only survives, baked
     survives, baked wins on conflict, retired `ktmb-booking` is dropped,
     and a server removed from the baked block (with its name on the retired
     list) does not survive. A second case covers a complex nested live-only
     server (tools.include list, `auth: oauth`, `supports_parallel_tool_calls`)
     round-tripping intact, asserts the merged file re-parses as YAML with
     the live server at the correct nesting and the baked comments intact,
     and covers malformed input: non-dict live `mcp_servers` and a non-dict
     server entry are ignored with a warning, not carried and not crashing
     the merge.
   - `modules/tests/test_issue_177.py`: the reproduction test, kept as the
     RED/GREEN control (fails at base, passes at HEAD).

## Out of scope

- No other compression settings, no MCP server additions/removals in the
  checked-in config, no live deploy, no restart/rebuild of production, no
  manual change on the production host. Deployment happens only through the
  normal PR + CI/CD path after merge.
- Verifying the deployed live value at 350000 after deploy is an operator
  check, not part of this change. Owner: Darren. Timing: after the deploy
  that follows this PR's merge. Check: on the production host, read
  `/opt/data/config.yaml` and confirm
  `compression.threshold_tokens` is 350000 (for example
  `grep -A3 '^compression:' /opt/data/config.yaml`). (`-A2` stops at
  `threshold` and never prints `threshold_tokens`; `-A3` reaches it.) This is recorded as a
  follow-up on the issue-maintenance goal until Darren confirms it.

## Verification

- `python3 modules/tests/test_issue_177.py` passes at HEAD (was failing at base).
- `modules/hermes/tests/test-50-seed-defaults.sh` and
  `modules/hermes/tests/test-model-routing.sh` pass.
- Relevant full suite per `scripts/run_tests.py` / CI workflow, then dev-loop
  review round, CI on the exact HEAD, PR, no merge by the agent.
