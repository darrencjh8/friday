QUESTIONS
q: Which emoji counts as approve? | a: The thumbs-up family: "👍" plus its skin-tone variants (👍🏻-👍🏿), matched after stripping skin-tone modifiers — the web client double-click sends exactly "👍", and a phone emoji picker may send a variant. Recommendation; Darren can narrow it to exact "👍" only.
q: What does 👎 mean? | a: Deny, mirroring the Refuse button — same one-shot pop and resolution path, choice "deny". Recommendation; Darren can choose ignore instead. Deny is the safe direction (an accidental deny only blocks a command; an accidental approve runs one).
q: Does a reaction approve once, or for the session? | a: Once only, mirroring the Approve button (web client: "Approuver = once"). "session" and "always" still need the buttons.
q: How is a reaction tied to the pending approval? | a: No new mapping and no client change: the approval event's id IS the approval_id (adapter _send_exec_approval_prompt sets "id": approval_id and returns message_id=approval_id; the client sends the reaction with message_id = that id). The server looks up self._approvals[message_id] directly.
q: What happens if the approval already resolved or expired? | a: Nothing: _approvals.pop returns None and the reaction is ignored. Approvals have no expiry in the code (they live until resolved or process restart); a reaction:removed (emoji None) after a resolve is also ignored — approval is one-shot and cannot be un-approved by un-reacting.
q: Does the reaction still get forwarded to the reaction handler? | a: Yes: resolve first, then fall through to the existing forward to _reaction_handler, so the upstream contract is unchanged. (No handler is registered today; if one ever is, it still sees the reaction.)
q: Do you accept that a casual 👍 irreversibly approves, with no undo — including on an old approval message? | assumption: Darren's approval of this plan is the acceptance of that trade-off. A reaction is a lighter gesture than the labelled Approve button, and approvals have no expiry, so a 👍 on a weeks-old approval message still approves that stale command (the same exposure exists for the buttons today; the reaction only lowers the friction). Un-reacting cannot undo it: the approval is popped on resolve. Mitigation is out of scope unless Darren asks for it (e.g. reactions only counting while the approval is the latest pending one).

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
- Client affordance gap (plan review round 1, F2): the wire protocol needs
  no change, but approval bubbles have NO react gesture today — web
  `Bubbles.tsx` renders approval messages as `ApprovalCard` with no
  `onReact`/double-click handler (only text bubbles get one, double-click
  toggles 👍), and Android `MessageBubbles.kt` is the same split (approval
  card gets only `onApproval`; Android double-click sends ❤️, not 👍). So
  this server fix is unreachable by a user until the hermes-dots #28 work
  adds a react gesture/picker to approval cards. That affordance is an
  explicit acceptance dependency: this server PR must not be presented as a
  working end-to-end feature until it exists (acceptance before then is by
  a manual wire-level reaction frame as the trigger).
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
   - The approval/emoji check runs FIRST, before the `if
     self._reaction_handler is None or not message_id: return` guard at the
     top of `_on_user_reaction` — that guard fires in production today
     (the handler is never assigned), so a check placed after it would
     never run. Only the forward to `_reaction_handler` stays behind the
     guard. (Plan review round 1, F1.)
   - Normalize the emoji first: guard with `isinstance(emoji, str)` (a
     non-string emoji must not crash frame dispatch), then strip the
     skin-tone modifiers U+1F3FB–U+1F3FF and the variation selector U+FE0F,
     and require exact equality with "👍" or "👎" after stripping.
     (Plan review round 1, F3.)
   - If the normalized emoji is 👍 and `message_id` is in `self._approvals`,
     resolve it exactly like the Approve button: call the existing
     `_on_approval` with a synthesized frame `{"approval_id": message_id,
     "choice": "once"}`, which pops the approval, validates, resolves,
     updates history, and pushes `approval_resolved`. If the normalized
     emoji is 👎, resolve the same way with choice `"deny"` (per the
     QUESTIONS decision).
   - The one-shot guarantee is the pop inside `_on_approval`, not the
     membership check — the check is only a fast path. Two near-simultaneous
     👍 frames both pass the check, but the second pop returns None, so only
     one resolve happens. (Plan review round 1, F6.)
   - Any other emoji, a reaction:removed (`emoji` None), or a message_id
     that is not a pending approval: do nothing new — fall through to the
     existing handler forward unchanged.
   - The handler forward stays as-is and runs after any resolution, so a
     future handler still sees the reaction.
2. Tests:
   - `modules/tests/test_issue_188.py`: the reproduction control, kept as
     RED/GREEN (fails at base, passes at HEAD). Extend it with cases for:
     👎 resolves as "deny"; skin-tone 👍🏻 resolves; "👍️" (variation
     selector U+FE0F) resolves; 👎 skin-tone variant resolves as "deny";
     👍 on a non-approval message resolves nothing; 👍 after the approval
     already resolved resolves nothing; duplicate 👍 then 👎 ordering
     (second frame is a no-op); reaction:removed resolves nothing AND the
     approval stays pending afterwards (assert it, do not just pop it);
     a non-string emoji and an empty message_id do not crash; the reaction
     is still forwarded to `_reaction_handler` when one is registered.
     Assert the full `_on_approval` reuse, not just the resolve call: the
     `approval_resolved` push and the `history.update(resolved=choice)`
     must both be asserted. (Plan review round 1, F3/F5.)
   - No existing adapter unit tests cover this path (only release-proxy
     tests exist); the new test stubs the host modules the adapter imports
     (`gateway.*`, `hermes_constants`, `tools.approval`), as the repro
     already does.

## Interface the hermes-dots side must provide (for the parallel #28 worker)

- Nothing new on the wire: the client already sends `{type: "reaction",
  message_id, emoji}`, and for an approval message `message_id` is already
  the approval_id. No wire-protocol change is needed.
- The client work is UI affordance, and it is real work, not a confirmation:
  approval bubbles currently have no react gesture on either client (web
  double-click toggles 👍 on text bubbles only; Android double-click sends
  ❤️). The #28 worker must add a react gesture/picker to approval cards so
  a user can actually send the 👍. Until that lands, this server change is
  only testable with a manual wire-level reaction frame. (Plan review
  round 1, F2.)

## Out of scope

- No client (hermes-dots) change in this fix; UI affordance is #28.
- No "session"/"always" via reaction; those still need the buttons.
- No expiry for pending approvals; no change to `tools.approval` (host).
- No change to clarify prompts or any other message type.

## Verification

- `python3 modules/tests/test_issue_188.py` passes at HEAD (was failing at
  base), including the extended cases above.
- Existing hermes tests pass: `python3 -m unittest
  modules.hermes.tests.test_dots_release_proxy -v` (the only dots-adjacent
  unit suite in the repo).
- Dev-loop review round, then push branch and create PR, no merge by
  the agent.
