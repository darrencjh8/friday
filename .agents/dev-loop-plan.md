QUESTIONS
q: Is the defect a missing `incoming` branch, or a wrong `direction` value? | a: a missing branch. `parseBankMovement` returns `direction: "incoming"` for the real received bodies and `resolveMovementAccounts` resolves the credited account (measured: uid 1030 resolves `source = destination = DBS Account`, `internal=false`). The route has no incoming counterpart, so control reaches the final `return null` at `:1097`.
q: What is a received credit into an owned account — income, or a transfer? | a: the credited half of an OWN transfer, not income. uid 1030 DBS (`…ending 7222`, SGD 1000.00, ref `0126100100114350`) and uid 1029 OCBC (`360 Account (-166600)` → `Darren DBS (-667222)`, SGD 1000.00, ref `2610010011435015`) are the two legs of one transfer in the same minute; the sender on the DBS received body is the holder (`ACCOUNT HOLDER`). uid 1028 (DBS received SGD 1557.24 into 7222 from `ACCOUNT HOLDER`) is the same shape.
q: So should the received leg book as income? | a: no. Booking `+1000` as `Misc` income while the outgoing leg books `-1000` spend counts the same money twice and inflates income. It must book as a transfer leg.
q: Is EVERY resolvable inbound credit a transfer leg, or only a self-transfer? | a: every resolvable named inbound credit, by the repository's existing convention. A credit with no counterparty already books `Unidentified deposit` as a plain un-categorised `Misc` row (`bank-movement.test.js:1035`, `:1014`), i.e. inbound credits are never auto-classified as income; this arm extends that same convention to a *named* credit, booking it `Misc` un-categorised pending pairing. Gating on a self-transfer discriminator alone would leave an external named credit falling through to `:1097` and re-introduce the endless re-fetch loop for it, so the arm is deliberately broad and the convention is pinned by assertion 3b (a named non-self credit books and is marked read). Round-3 finding F-1.
q: Can the received leg pair itself, like the internal arm at `:949`? | a: no. The received body names no sender bank or suffix, so the far account is unknowable from it; `resolveMovementAccounts` sets `source = other || own = own = destination`. The pair is linked from the OTHER side's pass through the existing #598 machinery (`_findExistingFarSide` at `:1957`, `_linkExistingFarSide` at `:2022`); the received leg only has to be the shape `find_link_candidate` recognises (a plain unlinked `Misc` row on the credited account).
q: Which account is the credited one, `source` or `destination`? | a: `destination`. `resolveMovementAccounts` (`bank-movement.js:736`) computes `destination = own` and `source = other || own`, and the internal arm at `:951` already reads `bookedAccount = incoming ? destination : source`. The arm keys on `destination_account`.
q: What must the received leg carry for `find_link_candidate` to match it? | a: `account_id` = the credited account, `amount_cents` = `+Math.abs(...)`, payee = `Misc`, **no** transfer payee and **not** linked. `find_link_candidate` matches the opposite sign, uncleared, `!transfer_id`, payee `Misc` (`tools.js:1564-1572`). A transfer payee would make Actual create its own counterpart at insert and the row would then be skipped.
q: Does the received leg set `_transfer` / `_is_transfer`? | a: no. `_findExistingFarSide` derives the far account from `_transfer.source_account_id`/`destination_account_id` (`:1958`), and `reserveTransfer` needs a real far account id; the received leg has neither, so it must not set them. It sets `_structured_movement: true` only.
q: Where must the arm go, exactly? | a: after the one-sided deposit branch (after `:1024`) and before the `:1026` outgoing gate. After `:1024` so the `!counterparty` deposit branch still wins for a one-sided credit (`bank-movement.test.js:1035`). Before `:1026` because that gate is the defect the incoming movement skips. After the person-hold arm (`:913`) and after `resolved.internal` (`:949`) so a person/unverified credit keeps its hold and an own-to-own leg keeps its pairing.
q: Does an unresolvable credited account (`5500`) book or hold? | a: scoped out of this change. With no account and no live fact for `5500`, `source` is null and the movement exits at `:870`; giving it a hold needs a change to the `:657` no-account gate (a hold with `account_id: ""` is swallowed there, so the alert would still loop). That shared-gate change is its own risk and is not taken here. `5500` therefore still drops until a fact maps it. (Corrected after review round 2 finding H1.)
q: Which account is the OTHER party on an incoming movement? | assumption: the deterministic parser's convention, `movement.counterparty`. The extractor route assigns fields the other way round (`:1229-1230`); this change does not touch that route.
q: Does booking the credit as a transfer risk the pinned #654 person boundary? | a: yes, and the arm is scoped against it. `production-incidents.test.js:811-825` and `:857-870` pin `expect(phase1).toBeNull()` for a two-account-ambiguous and a released incoming person credit. The arm requires `movement.person_transfer !== true` and `resolved.destination_account` truthy, so those two keep dropping.
q: Is the uid 895 Trust/OCBC row in scope? | a: no. `own` is null and the counterparty is a bank, so `destination_account` is null and the arm does not fire.
q: Will the full suite regress? | assumption: measured, not assumed. The arm is placed to preserve `bank-movement.test.js:1035-1074` (one-sided deposit), `:266-311` (PayNow credit as transfer), and the two #654 pins; all are re-run rather than assumed.
q: What if only the received leg ever arrives? | assumption: it books unpaired (a plain `Misc` row on the credited account) and is marked read, so it does not loop. It links later when an outgoing leg's pass finds it, or not at all if no leg ever names the far account. Accepted and stated in Risks.

## Intent

A bank alert saying money was **received** into an account the tracker can identify is parsed, matched, and then thrown away: never booked and never marked read, so `imap.js:86` re-fetches it `{ unseen: true }` on every idle poll and the user is told "Couldn't understand email" forever. Tracked by issue #680.

The received money is the holder's **own transfer**, not income (uid 1030 + uid 1029 are one transfer). So the fix gives the incoming direction the counterpart of the outgoing booking block, and books the received leg as a **transfer leg on the credited account** — a plain `Misc` row that the existing #598 pairing machinery links to the outgoing leg from the outgoing side.

## Current behaviour (measured at `3ccf684`, real accounts and the live 253-fact store)

| Body | parsed | `own`/`destination` | outcome | exit |
|---|---|---|---|---|
| uid 1030 DBS `…ending 7222` | suffix 7222, `direction:"incoming"` | **DBS Account** | dropped | `return null` at `:1097` |
| uid 942 DBS `…ending 5500` | suffix 5500, `direction:"incoming"` | **null** (no account, no live fact) | dropped | `return null` at `:870` |
| uid 895 Trust OCBC `…ending 6600` | — | null (`source` = OCBC 360, the sender) | dropped, out of scope | `:1097` |

End to end through `processEmail`, uid 1030: `action=notified`, no `insert_transaction`, **no** `mark_email_read`, message `Couldn't understand email from "no-reply@dbs" re: "digibank Alerts - You've received a transfer".`

Why no test caught it: the existing tests carry these bodies but assert only on `parseBankMovement` (`own-account-fast-transfer-598.test.js`, `transfer-shape-resilience.test.js`). The resolver and `processEmail` path for a resolvable inbound credit were untested — the broken region.

## Target design

One insertion: a sibling `if (movement.direction === "incoming" …)` arm, after the one-sided deposit branch (after `:1024`) and immediately before `if (movement.direction === "outgoing")` at `:1026`.

Condition: `movement.direction === "incoming"` ∧ `resolved.destination_account` truthy ∧ a `date` ∧ `movement.counterparty` named ∧ `movement.person_transfer !== true`.

**The arm is deliberately broad, not gated on a self-transfer discriminator** (round-3 finding F-1). Every named inbound credit into a resolved account books as an un-categorised `Misc` row — the same class the no-counterparty branch already books as `Unidentified deposit`. Inbound credits are never auto-classified as income by this repository; a transfer leg is simply `Misc` + un-categorised + unlinked, ready to pair. Gating on `counterparty === "ACCOUNT HOLDER"` (or on the holder's recalled legal name) would leave an external named credit falling to `:1097` and re-open the endless re-fetch loop for it, which is the very defect #680 fixes. This is pinned by assertion 3b.

It books the credited leg on `resolved.destination_account`:

- `account_id` / `account_name` = the credited account; `amount_cents: Math.abs(...)` (credit is positive).
- `payee_name: "Misc"`, `category_id: null`, `raw_description: "Transfer from <counterparty>"`.
- `_structured_movement: true`.
- `_is_paynow` / `_paynow_merchant` are deliberately **NOT** propagated onto the booked leg (removed in code review round 1, M1). The credit has already resolved onto a known own account, so the Phase-2 PayNow identity re-check can only *refuse* it: propagating `_is_paynow` set `_hold_unresolved_paynow`, whose branch notifies and logs but never calls `mark_email_read`, leaving the alert to be re-fetched unseen forever (`imap.js:86`) — the exact loop this change removes.
- **No** `_transfer`, **no** `_is_transfer`, **no** `payee_id` — so the row is the plain unlinked `Misc` row that `find_link_candidate` (`tools.js:1567-1572`) later matches from the outgoing side, and Actual does not create a competing counterpart at insert.

Pairing then runs on the outgoing leg's pass, unchanged: `if (llmOutput._transfer)` (`:2754`) → `_findExistingFarSide` (`:2761`, `:1957`) → `_linkExistingFarSide` (`:2868`, `:2022`), matching the credited row by account, opposite sign, `Misc` payee, unlinked.

Placement is load-bearing, each from a pinned test:
- **After `:1024`** so the `!counterparty` one-sided deposit branch still books `Unidentified deposit` (`bank-movement.test.js:1035-1074`).
- **After `:913`** so a person/unverified incoming credit keeps its `person_identity_unverified` hold (`production-incidents.test.js:793-809`, `:872-888`).
- **After `:949`** so an own-to-own leg is still paired as a transfer by the internal arm.
- **`person_transfer !== true`** so the released incoming person credit still drops (`production-incidents.test.js:857-870`).

Deliberately **not** changed: the `:657`/`:552` no-account gate, the person hold (`:913`), the LLM-extractor route, and the parser.

## Test plan (TDD; RED at base, GREEN at HEAD)

RED control: `modules/expense-tracker/tests/incoming-credit-booking-680.test.js` → `incoming credit into a resolvable account (issue #680) > books the credit on the credited account as a transfer leg, not income`. Fails at base with `expected null not to be null` (measured at `3ccf684`).

The file carries the real production bodies (uid 1030, uid 1029) and the real suffix facts, PII-redacted the way this repository redacts (suffixes kept so suffix-to-account pairing still resolves; names and amounts left as the alerts carry them), with the live `Darren SGD` account list. Assertions:

1. uid 1030 books on `DBS Account`, `amount_cents` positive `100000`, `action: "insert"`, `payee_name: "Misc"`, `_structured_movement: true`, and **no** `_transfer`/`_is_transfer`/`payee_id`. (RED at base: null.)
2. `processEmail` on uid 1030 does not return `notified`, and calls both `insert_transaction` and `mark_email_read`. (RED at base: `notified`, neither call.)
3. A one-sided credit with **no** counterparty still books `Unidentified deposit` (`bank-movement.test.js:1035` shape), asserted here so the arm cannot steal it.
3b. **A named non-self credit** (an external payer, not `ACCOUNT HOLDER` and not the holder's legal name) still books on the credited account as a `Misc` un-categorised row and is marked read — it does not fall through to `:1097` and loop. This pins the broad-arm convention that answers round-3 finding F-1, and asserts the arm is not scoring a self-transfer discriminator.
4. **Pairing** is exercised by the existing `own-account-fast-transfer-598.test.js:436-471` suite, which is re-run unchanged: the received leg is the plain unlinked `Misc` row on the credited account that `find_link_candidate` matches, so the outgoing leg's `_findExistingFarSide` links it. This change deliberately adds no second pairing test that would duplicate and could diverge from #598's.
5. **#654 person boundary** is guarded by `production-incidents.test.js:811-825` and `:857-870` (the released incoming person credit must still drop) and `:793-809` (the unreleased one must still hold) — re-run unchanged, not re-asserted here.

No LLM is stubbed to a plausible answer: `orch._llm.chat` is a bare `vi.fn()`, so a null deterministic route would fall through to the extractor and fail the assertion.

Tests gate command, run in full (the pack's scaffold command is a Python `unittest` discovery matching no file in this module — a misfire, not used):

```
cd modules/expense-tracker && npx vitest run
```

The recorded mutation control for the new file links `node_modules` before running, because the driver's throwaway worktree carries tracked files only.

## Risks and how they are handled

- **Double-counting a self-transfer.** The received leg books `Misc`, not income, and pairs to the outgoing leg via #598; the outgoing leg is unchanged.
- **Widening the pinned #654 person boundary.** The arm requires `person_transfer !== true`; test 4 asserts the released person credit and the one-sided deposit both still behave.
- **Stealing the one-sided deposit.** The arm sits after `:1024`, so `!counterparty` deposits still book `Unidentified deposit`.
- **Dropping the inbound PayNow hold.** `_is_paynow`/`_paynow_merchant` are deliberately **NOT** mirrored; the resolved credited leg never enters the Phase-2 PayNow hold (M1).
- **Mis-booking a named non-self credit** (a genuine external payer). The row books `Misc` `+amount` un-categorised and is marked read; it is not income (nothing is auto-classified as income here) and pairs only if a real opposite-sign leg is later found on that account by #598. The residual is that a matching opposite-sign row could mis-link — the same exposure #598 already carries for every `Misc` credit, not new to this arm. Broad-but-conventional was chosen over a self-transfer discriminator because the discriminator would re-open the `:1097` re-fetch loop for external named credits (round-3 finding F-1; pinned by assertion 3b).
- **Received leg stays unpaired (accepted).** If no later leg names the far account, the row is a plain `Misc` credit on the credited account and is marked read, so it does not loop. There is no re-attempt from the receiving side; accepted, and a candidate follow-up.
- **uid 942 still drops (accepted).** `5500` has no account and no live fact; scoped out because holding it needs the `:657` gate change. It books correctly the moment a fact maps `5500` AND the credited leg is bookable — no further change here.

## Rollout

No manual production action; the change reaches production through the PR and `deploy.yml`.

## Non-goals

- Not the uid 895 Trust/OCBC row, and not the uid 942 unresolvable `5500` hold (both need the shared-gate change; tracked on #680).
- Not the incoming **person** arm — `production-incidents.test.js:857-870` pins it as its own change.
- Not the LLM-extractor field convention, the person hold, `resolveMovementAccounts`, the parser, or `mark_email_read`/`imap.js`.
