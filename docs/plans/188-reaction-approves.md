QUESTIONS
q: Which emoji counts as approve? | a: The thumbs-up family: "👍" plus its skin-tone variants (👍🏻-👍🏿), matched after stripping skin-tone modifiers — the web client double-click sends exactly "👍", and a phone emoji picker may send a variant. Recommendation; Darren can narrow it to exact "👍" only.
q: What does 👎 mean? | a: Deny, mirroring the Refuse button — same one-shot pop and resolution path, choice "deny". Recommendation; Darren can choose ignore instead. Deny is the safe direction (an accidental deny only blocks a command; an accidental approve runs one).
q: Does a reaction approve once, or for the session? | a: Once only, mirroring the Approve button (web client: "Approuver = once"). "session" and "always" still need the buttons.
q: How is a reaction tied to the pending approval? | a: No new mapping and no client change: the approval event's id IS the approval_id (adapter _send_exec_approval_prompt sets "id": approval_id and returns message_id=approval_id; the client sends the reaction with message_id = that id). The server looks up self._approvals[message_id] directly.
q: What happens if the approval already resolved or expired? | a: Nothing: _approvals.pop returns None and the reaction is ignored. Approvals have no expiry in the code (they live until resolved or process restart); a reaction:removed (emoji None) after a resolve is also ignored — approval is one-shot and cannot be un-approved by un-reacting.
q: Does the reaction still get forwarded to the reaction handler? | a: Yes: resolve first, then fall through to the existing forward to _reaction_handler, so the upstream contract is unchanged. (No handler is registered today; if one ever is, it still sees the reaction.)

# Plan: thumbs-up reaction on an approval request resolves it as approved (issue #188)

## Goal

Fix friday #188: a 👍 reaction on a pending approval request should count as
approving it. Today the emote does nothing beyond showing on the message — the
client sends the reaction to the server, the dots adapter forwards it as a
`reaction:added` event, but nothing registers the reaction handler, so it
lands nowhere.

## Evidence

- Reproduction recorded with dev-loop (`loop.py repro`, phase REPRODUCED):
  command `python3 modules/tests/test_issue_188.py`, test id
  `tests.test_issue_188.TestIssue188.test_thumbs_up_resolves_pending_approval`.
  At base it fails: after a 👍 on a pending approval, the approval is still
  pending and `resolve_gateway_approval` was never called.
- Reaction path verified by code reads: web `GatewayClient.toggleReaction`
  and Android `GatewayChatRepository.toggleReaction` both send
  `{type: "reaction", message_id, emoji}`; the adapter dispatches kind
  `"reaction"` to `_on_user_reaction` (adapter.py:913), which only forwards
  to `self._reaction_handler` — never set anywhere in this repo (only the
  upstream Slack fixture references it).
- Approval path verified by code reads: `_send_exec_approval_prompt`
  (adapter.py:1769) creates `approval_id = uuid.uuid4().hex`, stores
  `self._approvals[approval_id] = session_key`, and pushes an event whose
  `id` is the approval_id. `_on_approval` (adapter.py:1624) pops the
  approval, validates the choice against `("once", "session", "always",
  "deny")`, calls host-provided `resolve_gateway_approval(session_key,
  choice)` (imported lazily from `tools.approval`, a host module not in this
  repo), updates history, and pushes `approval_resolved`. The client sends
  its approval answer with `approval_id = target.id`, i.e. the message id.
- No expiry exists for pending approvals (no TTL in the adapter); a resolved
  approval is gone from `_approvals`, so a later reaction is a no-op by
  construction.

## Changes

1. `modules/hermes/plugins/dots/adapter.py`, `_on_user_reaction` only:
   - Before the existing handler forward, check whether `message_id` is in
     `self._approvals` and the emoji is a thumbs-up (skin-tone modifiers
     stripped). If so, resolve it exactly like the Approve button: call the
     existing `_on_approval` with a synthesized frame `{"approval_id":
     message_id, "choice": "once"}`, which pops the approval, validates,
     resolves, updates history, and pushes `approval_resolved`.
   - If the emoji is 👎 (same normalization), resolve with choice `"deny"`
     the same way (per the QUESTIONS decision).
   - Any other emoji, a reaction:removed (`emoji` None), or a message_id
     that is not a pending approval: do nothing new — fall through to the
     existing handler forward unchanged.
   - The handler forward stays as-is and runs after any resolution, so a
     future handler still sees the reaction.
2. Tests:
   - `modules/tests/test_issue_188.py`: the reproduction control, kept as
     RED/GREEN (fails at base, passes at HEAD). Extend it with cases for:
     👎 resolves as "deny"; skin-tone 👍🏻 resolves; 👍 on a non-approval
     message resolves nothing; 👍 after the approval already resolved
     resolves nothing; reaction:removed resolves nothing; the reaction is
     still forwarded to `_reaction_handler` when one is registered.
   - No existing adapter unit tests cover this path (only release-proxy
     tests exist); the new test stubs the host modules the adapter imports
     (`gateway.*`, `hermes_constants`, `tools.approval`), as the repro
     already does.

## Interface the hermes-dots side must provide (for the parallel #28 worker)

- Nothing new on the wire: the client already sends `{type: "reaction",
  message_id, emoji}` for any message, and for an approval message
  `message_id` is already the approval_id. No protocol change is needed.
- The only client work is UI affordance: the user must be able to react to
  an approval bubble (web double-click already toggles 👍 on bubbles; the
  #28 worker confirms it works on approval bubbles, and Android likewise).
  The server needs nothing else from the client.

## Out of scope

- No client (hermes-dots) change in this fix; UI affordance is #28.
- No "session"/"always" via reaction; those still need the buttons.
- No expiry for pending approvals; no change to `tools.approval` (host).
- No change to clarify prompts or any other message type.

## Verification

- `python3 modules/tests/test_issue_188.py` passes at HEAD (was failing at
  base), including the extended cases above.
- Existing hermes tests pass.
- Dev-loop review round, then push branch and create PR, no merge by
  the agent.
