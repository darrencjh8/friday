# Hermes memory stores — capacity, the approval queue, and triage

Diagnostic reference for "how do I improve / expand my memory?" questions. Companion to
the two memory sections in `SKILL.md`.

## The stores

| Store | File | Cap | Override key |
|---|---|---|---|
| Built-in memory | `<HERMES_HOME>/memories/MEMORY.md` | upstream default 2200; **this deployment 2800** | `memory.memory_char_limit` |
| User profile | `<HERMES_HOME>/memories/USER.md` | upstream default 1375; this deployment 1375 | `memory.user_char_limit` |
| MCP facts (per module) | e.g. `<data>/MEMORY.md` | module-defined (expense-tracker: 300, auto-compacts to 250) | module config |
| Topic files (tier 2) | `<HERMES_HOME>/memories/topics/*.md` | uncapped | — |

The judge prompt quotes the configured caps, which it reads from the seeded
`config.yaml` at seed time — the numbers are not hardcoded in the prompt text.

Caps are **soft** — `MemoryStore.__init__` takes `memory_char_limit` / `user_char_limit`,
loaded from config by both the live agent (`agent/agent_init.py`) and the agentless path
(`tools/memory_tool.py: load_on_disk_store()`), which falls back to 2200/1375 if config is
unreadable. The char budget is checked against the **final** state of a batch, so one call
can remove stale entries AND add new ones even when the add alone would overflow.

Entries are separated by `ENTRY_DELIMITER`; `MEMORY.md` is injected into **every** turn's
context, so its size is a permanent per-turn token tax — which is why "raise the limit" is
the *last* lever, not the first.

The weekly `memory-compact` cron (Sun 08:30) keeps the core under its cap: it merges
duplicates and moves detail to topic files via `memory-triage.sh compact --plan`, which
snapshots first, allows only replace/remove, and refuses any plan that grows the store.

## The approval queue — the silent write-only trap

`memory.write_approval: true` gates the mutating actions (`add` / `replace` / `remove`).
`_apply_write_gate()` returns a staging result instead of writing; the op lands in:

```
/opt/data/pending/memory/<8-hex-id>.json
```

Nothing drains this automatically. `/memory pending` is the interactive approval surface.
A gateway/Telegram-only workflow can therefore run for **months** with every learning
staged and none applied — memory looks "capped" while the real cause is zero intake.

### File schema

```json
{
  "id": "fdb7ce9d",
  "subsystem": "memory",
  "action": "add",
  "summary": "add to memory: <human-readable one-liner>",
  "origin": "background_review",
  "created_at": 1788943580.5781596,
  "payload": {
    "action": "add",
    "target": "memory",
    "content": "<the entry text>",
    "old_text": null
  }
}
```

Batch shape swaps `payload.action` to `"batch"` and carries
`payload.operations: [{action, content, old_text?}, ...]` with one `target` for the group.
`origin` values seen: `assistant_tool` (saved during the conversation) and
`background_review` (post-turn autonomous review — the bulk of any long-lived queue).

### Inventory recipe

```bash
# Total ops (a batch file holds several)
ls /opt/data/pending/memory/*.json | wc -l

# Oldest first, to see how long intake has been stalled
ls -lt /opt/data/pending/memory/*.json | tail -3
```

Expand a batch file's ops (payload differs between `add` and `batch`, so handle both):

```python
import json, glob, os, time
for f in sorted(glob.glob("/opt/data/pending/memory/*.json"), key=os.path.getmtime):
    d = json.load(open(f)); p = d.get("payload") or {}
    ops = p.get("operations", []) if p.get("action") == "batch" else [p]
    for op in ops:
        print(time.strftime("%m-%d", time.localtime(d.get("created_at", 0))),
              f"[{d.get('origin')}/{p.get('target')}/{op.get('action')}]",
              (op.get("content") or op.get("old_text") or "")[:200])
```

## Triage workflow (drain without importing garbage)

1. **Expand and read every op** (recipe above). Do not apply blind.
2. **Classify each op** into: fact/preference → memory · procedure/runbook → a skill ·
   long-form → a skill `references/` file · ephemeral/dated state → **discard**.
3. **Dedupe and reconcile.** Long queues are mostly re-derivations of the same fact, some
   of them contradicting each other. Where two ops disagree, resolve against the live
   system before writing either.
4. **Apply as few consolidated ops as possible**, in one `batch` call, using `remove` /
   `replace` alongside `add` so the net char delta is small or negative.
5. **Show the proposed diff before writing** if the user is still in the loop — for a
   90+ op queue this is a reviewable change, not a housekeeping detail.

## Tier 2 — topic files (`/opt/data/memories/topics/`)

The always-on core is capped; sessions and skills cover procedures and history. Durable
**facts** that still do not fit the core go to topic files, one file per domain
(`infra.md`, `accounts.md`, `expenses.md`, `prefs.md`), indexed by `INDEX.md`.

Rules that keep this from becoming a second junk drawer:

- One fact per line, with **aliases on the label**:
  `Groceries / supermarket / NTUC FairPrice / Cold Storage -> payee Groceries`. Aliases are
  what let keyword search (`search_files`) cover near-synonyms without an embedding model.
- The agent searches this directory before answering a recall question; the seed
  writes a pointer line into `MEMORY.md` once (idempotent, and skipped with a report if
  the core is full) so a session that never loads this skill still knows the directory
  exists.
- When the triage judge files a fact here it **discards** that queue record in the same run.
  Filing *and* approving produces two copies that drift; never do both.
- Read the queue with `memory-triage.sh list --full` before filing: the default `list`
  truncates each op at 240 characters (`memory_triage.py`, `_summarize`).
- **Backup and restore are split.** `memory-backup.sh` copies `MEMORY.md`, `USER.md` and
  `topics/*.md` (the two stores are copied by name, so the topics copy is an explicit
  block). The triage snapshot/restore covers `MEMORY.md`/`USER.md` only — a `restore` will
  **not** roll topic files back; the git backup (every 6 h) is their restore path.
- Address facts that look like credentials or env assignments can be refused by the skill
  content scanner; expect a reported failure rather than a silent skip.

Monthly: count entries in `MISSES.md`. If misses are paraphrase misses that aliases could
not fix, that count — not a vendor benchmark — is the trigger for adding a semantic index
over these same files.

## Prevention

- The queue only exists because approval is on. Either drain it deliberately, or turn the
  gate off (`memory.write_approval: false` — needs a new session to take effect) so writes
  land as they happen and the store self-regulates through the char budget.
- Pair auto-apply with a **periodic hygiene job** (cron): consolidate memory, drop stale
  entries, and run the module-level compactor for MCP fact stores. That job exists here
  now (`memory-approve-queue`, daily 08:00) — implementation, judge-prompt shape, and the sandbox
  verification recipe live in `references/memory-queue-auto-triage.md`, driven by
  `scripts/memory_triage.py`.
- Keep the store in its lane: a pre-existing `references/` doc or skill already covering a
  procedure means the memory op is a *duplicate*, not a learning.

## Related gotcha — user-owned skills refuse curator writes

A skill whose `created_by` is `None` (hand-written by the user, or installed by URL) is
**user-owned**: autonomous curator patches to it are refused. Symptoms are a refusal on an
edit to a skill that otherwise looks ordinary. Fix is a foreground action:
`hermes curator adopt <skill-name>`. Note this in the reply and move on rather than
retrying or working around it.
