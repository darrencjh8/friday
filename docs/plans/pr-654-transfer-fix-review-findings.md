QUESTIONS
q: Should the hold cover a transfer to ANY person, or only the holder's own legal name as today? | a: Any bare person name, in BOTH directions. Memory is consulted FIRST; if no fact resolves the counterparty, hold. Never guess. Confirmed by Darren 2026-10-05, superseding the earlier Option 1 (narrow hold).
q: Where should the memory lookup happen? | a: `_resolveMovementToOutput`, at the existing hold site (orchestrator.js:761-765), which already receives the movement. Parsing stays free of account facts.
q: Which memory read decides the person/business question? | a: `list_facts` (full deterministic read from disk), NOT `search_memory`. A recall miss on `search_memory` would silently book a real person transfer as spend, which is the exact defect this closes. The read is made only when `movement.person_transfer === true`, so plain merchant alerts pay nothing.
q: EXACTLY which facts release the hold? | a: Only the payee/category mapping grammar — a fact whose key normalises equal to the alert's counterparty name under `normalizeIdentityName` (orchestrator.js:290, already used at :759) using the shape `KEY (merchant )?maps to VALUE (payee|category)`. A legal-name / account-holder fact or an `is a ... account` fact can NEVER release the hold. It is fail-closed: an unrecognised grammar holds.
q: What closes the loop when a person-shaped name is held? | a: Hold only, and name the counterparty and the cause in the notification (Option 1, Darren 2026-10-05). No reply path, no auto-learn, and the notification does NOT tell the user to teach it — nothing would act on that. The cause rides a NEW `_hold_cause` string with one value per held row, not `notify_message` (ignored by the notify path at orchestrator.js:2395-2406) and not `reasoning` (LLM-authored for the three Phase-2 holds).
q: Does the hold also fire on INCOMING person credits? | a: Yes, deliberately, but only where the alert resolves to exactly ONE live account at the sender bank. The flag is direction-independent (bank-movement.js:292-293 sets it for `received` as well as `sent`) and an unverified incoming person credit is as unverifiable as an outgoing one; this already matches the #585 precedent that an own-name credit is held rather than booked as income. BOUNDARY, verified: with 2+ live accounts at the sender bank the movement is dropped at orchestrator.js:740 before the hold site, because resolveAccountByBank refuses an ambiguous bank, and F2's new branch is keyed on `outgoing`. That case is unchanged by this plan, is listed under "Not in scope", and is pinned by a test at both account counts.
q: May the pipeline write facts automatically? | a: Only what the alert itself proves — digits and bank names printed in the body (orchestrator.js:2819 suffix->account, :2749 account type). Never a judgment fact. No new auto-learn is added by this plan.
q: Should the LLM-extractor route be covered too? | a: Yes (H4), and at `_llmExtractMovement` (orchestrator.js:1040-1052) where the movement is built — NOT at the Phase-1 sanitize block at :1297-1303, which runs after every `_resolveMovementToOutput` caller has already returned.
q: Is the generic full Phase-1 LLM path covered? | a: No. The loop at orchestrator.js:1128 never enters `_resolveMovementToOutput`, so no movement hold can reach it. Stated as a boundary and tracked as its own issue.

# Fix the transfer-shape defects on PR #654 (F1, F1b, F2, F3, H4)

## Problem

Independent review of `be4b124` proved three defects, each reproduced at base `f0b9a5b`.

**F1 (Critical) — a person-to-person transfer is booked as spend.**
`bank-movement.js:347` sets `person_transfer`, and nothing reads it
(`grep -rn person_transfer src/` returns only the two writers). The sole
person-hold is `orchestrator.js:761-765`, which requires the counterparty to be
the holder's OWN legal name, recalled from memory. Consequences:

- transfer to the holder, legal-name fact recalled → held;
- transfer to the holder, fact not recalled → `inserted` as `Misc` spend;
- transfer to ANY other person → `inserted` as `Misc` spend, always.

This is not new: the already-supported `you've sent ... to <person>` form
books the same way at base. The branch added a second way in.

**F1b (High) — a hold notifies with text that misstates the cause.**
All three hold sites set `notify_message: ""` (orchestrator.js:735, 783, 905),
and the notify path at `:2395-2406` ignores that field anyway, hardcoding
`Held: transfer destination for ... was not safe to resolve`. For a person-shaped
hold that text is wrong: the destination was never the problem, the counterparty
identity was. Darren chose Option 1 on 2026-10-05 — hold, and say why, with no
reply path and no auto-learn.

**F2 (High) — the ambiguous sender-bank case is dropped, not held.**
`bank-movement.js:337` claims resolution "holds rather than guessing when that
is ambiguous". It does not. `own_account` carries only a bank, and
`resolveAccountByBank` (`bank-movement.js:701`) returns null unless exactly one
live account matches, so `_resolveMovementToOutput` returns null at
`orchestrator.js:740` and `_runPhase1` yields null. With the LLM unable to read
this sentence either, the user gets "Couldn't understand this transaction
alert." — no hold, no booking, no notification. Any holder with two accounts at
Ryt hits this.

**F3 (High, hardening) — `_card_repayment` is LLM-forgeable.**
`orchestrator.js:1297-1303` deletes six internal flags from untrusted Phase-1
output. The branch's new `_card_repayment` is absent from that list, so an LLM
can supply it. It currently only adds a hold, but it is LLM-reachable control
flow at `:2132` and `:2230`.

**H4 (Medium) — the LLM route never sets `person_transfer`.**
Only the two deterministic writers set it. Any F1 fix keyed on that flag would
cover only deterministically-parsed alerts.

## Approach

### F1 — memory-first person hold

Extend the existing hold condition rather than adding a gate, so one site owns
"person movement with no verified leg" (orchestrator.js:761-765):

- `orchestrator.js:761-765` — add `movement.person_transfer === true` as an
  OR-term of `unverifiablePersonMovement`, and add a `_hold_cause:
  "person_identity_unverified"` to the row it returns. The `!resolved.internal`
  term already stands, so a transfer that DID resolve to a tracked account still
  books as a transfer.
- **The `!matchAccountByName(...)` term at `:764` must move INTO the
  `knownOwnIdentity` arm, not stay as a term of the whole condition (plan round 2,
  finding H6).** As written the condition is
  `!resolved.internal && (knownOwnIdentity || person_transfer) && !match` — the
  `!match` term gates EVERY arm, so a counterparty that resolves to a live account
  by ANY route suppresses the hold even when `person_transfer === true`.
  `matchAccountByName` matches on TOKEN CONTAINMENT (suffix-facts.js:246-275,
  `query.every(w => target.includes(w))`), so with accounts
  `[Ryt Bank, Wei Ling Savings]` the person name `WEI LING` resolves `matched:true`
  to `Wei Ling Savings` (while `WEI LING TAN` does not). Verified by executing the
  condition: `!resolved.internal && (true || true) && !match` evaluates **false**
  — the hold never fires and the transfer books as spend. That defeats the Critical
  on BOTH routes, so removing only the H4 suppression is not sufficient; the
  pre-existing term has the same defect. Restructure so the account-match test
  applies only to the old own-identity arm:

  ```js
  const personNamed = movement.person_transfer === true;
  const unverifiablePersonMovement =
      !resolved.internal &&
      ( (knownOwnIdentity && !matchAccountByName(counterparty, accounts, mappings.aliases).matched)
        || personNamed );
  ```

  This preserves today's behaviour exactly for the own-identity arm (the name still
  must not resolve to an account) while the new `person_transfer` arm no longer
  consults account matching at all — a person name is held because it is an
  unremembered person, not because it failed an account lookup. `!resolved.internal`
  still stands, so a transfer that DID resolve to a tracked account books as a
  transfer. A whole-token identity check is the only safe form of this test, the
  same discipline the release predicate uses.
- **Name the counterparty direction-aware (plan round 2, finding M2).** The held
  row reads `merchant: movement.counterparty.name` (:767) and both notify
  templates interpolate `llmOutput.merchant`, but on the extractor route
  `counterparty` is built unconditionally from `to_account` (:1047) — so on an
  INCOMING credit it is the holder's OWN account. Measured on a held incoming
  credit (`from_account:"LEE WEI LING"`, `to_account:"Main Account"`): `merchant
  "Main Account"`, `raw_description "Transfer from Main Account"`, notification
  `Held an unresolved transfer` — the holder is told a transfer to their own
  account was held because the counterparty could not be verified. Compute the
  name once at the hold site and use it for `merchant`, `raw_description`,
  `reasoning` and the notification:

  ```js
  const namedParty = movement.direction === "outgoing"
      ? movement.counterparty?.name
      : (movement.own_account?.name || movement.counterparty?.name);
  ```

  This is the SAME `namedParty` H4 already computes on that route, so the two
  sections now agree on one definition. The deterministic routes are already
  correct here — the Ryt branches build `counterparty` from the named party in
  both directions (bank-movement.js:293-297) and the OCBC reference deposit sets
  it to the sender (:551-558) — so this is exactly the extractor route's gap.
- The held row stays `Misc`, no category, no amount booked. `raw_description`,
  `reasoning` and `payee_source` must say which cause it was.
- No direction term: the hold covers incoming person credits too (see QUESTIONS).
- The existing `knownOwnIdentity` term is unchanged, so nothing that holds today
  stops holding.
- **The incoming leg is covered ONLY when the sender bank's account count is
  unambiguous.** Verified: an incoming person credit with ONE live account at the
  sender bank reaches `:761` and is held, but with TWO it is dropped at `:740`
  before the hold site, because `resolveAccountByBank` (bank-movement.js:698-702)
  refuses the ambiguous bank. F2's new branch is keyed on `outgoing`, so it cannot
  cover this either. So the plan does NOT widen the incoming claim: q7 and
  Behaviour change #1 both state that an incoming person credit for a holder with
  2+ accounts at the sender bank remains dropped today and after this change, and
  it is listed under "Not in scope" with its own issue. The incoming test is pinned
  at BOTH account counts so the boundary is visible in the suite.

**Do NOT use `looksLikePersonName` as the person/business discriminator.** It is
structural and list-free, and a person name is indistinguishable from an unlisted
business descriptor on every feature the parser exposes — proven, not asserted:

```
must HOLD:  {"person_transfer":true,"tokens":3,"nonPersonToken":false,"digits":false,"dots":false}   ACCOUNT HOLDER
must BOOK:  {"person_transfer":true,"tokens":3,"nonPersonToken":false,"digits":false,"dots":false}   BLUE BOTTLE COFFEE
No feature separates the classes: true
```

Memory is the discriminator. Shape is not, and this plan does not pretend
otherwise. (The parser's flag only gates WHICH movements are candidates.)

#### F1 — the release predicate (exact)

"Memory-first, else hold" is only implementable once the releasing fact is pinned,
because no fact in this module asserts an entity type. Enumerated from the
writers and readers:

| Writer | Fact shape | Can release the hold? |
| --- | --- | --- |
| `memory.migrateFromMappings` (memory.js:967-976) | `KEY merchant maps to VALUE payee` | YES |
| `memory.migrateFromMappings` (memory.js:974) | `KEY maps to VALUE category` | YES |
| `learn_fact` (:2749) | `NAME is a TYPE account` | NO — names an account |
| `_learnSuffixFact` (:2819) | `... ending NNNN belongs to NAME` | NO — no counterparty name |
| legal-name fact (read at :751) | `Legal name: NAME -> PASS (statement password)` | NO — names the holder |

**Release (book normally) when** a `list_facts` fact matches BOTH:

1. **Grammar** — it is a `KEY (merchant )?maps to VALUE (payee|category)` fact.
   This is the only grammar in the module whose key is a counterparty name and
   whose presence asserts that name is a known non-person entity.
2. **Identity** — `normalizeIdentityName(key) === normalizeIdentityName(counterparty)`
   (`normalizeIdentityName` is defined at orchestrator.js:290 and already used for
   exactly this comparison at :759).

Matching is on the fact's KEY, compared whole after normalisation. A substring or
token-overlap match is explicitly forbidden: `Legal name: <holder> -> <MNEMONIC>
(statement password)` shares a token with the counterparty, and an overlap rule
would release a real person transfer — re-opening F1 behind F1.

**Hold** in every other case, including an unrecognised grammar, an unavailable
`list_facts`, and any fact whose key does not normalise equal to the counterparty.
The predicate is fail-closed by construction.

**The release predicate is reachable ONLY on the outgoing path (plan round 2,
finding M3).** Verified by executing the revised plan end to end: with
`LEE WEI LING merchant maps to Bak Kwa Trading payee` in memory, an OUTGOING
person credit releases and books, but the same INCOMING credit still returns
`null`. The reason is structural and pre-existing, not something this plan
introduces: `_resolveMovementToOutput` has only three booking arms — the internal
transfer arm (`:789`), the `incoming && !counterparty` unidentified-deposit arm
(`:844`), and the `outgoing` arm (`:866`) — and an INCOMING movement that HAS a
counterparty but is not internal reaches neither, falling to `return null` at
`:936`. Measured identically at HEAD (`409f3fd`) and after the change, so this is
inherited behaviour.

So an incoming person credit is HELD when the predicate does not release it, and
still DROPPED when it does: the release half of F1 is dead code in the incoming
direction. Do not state otherwise. Behaviour change #1 is amended to say the
release takes effect on OUTGOING person movements only, and that an incoming
person credit is either held (predicate does not release) or dropped (it does) —
the `maps to … payee` fact is therefore an unblock for the outgoing direction
only. Tests pin both: an outgoing person credit with the fact books, and the same
incoming credit with the fact is dropped rather than booked. Adding an incoming
booking arm for a person counterparty is its own change and is listed under
"Not in scope".

#### F1 — the `paid` sentence form (the third Ryt verb)

`bank-movement.js:275` accepts `received|sent|paid`, but the flag at `:292-293` is
`/^(received|sent)$/i.test(rytSentence[1]) && looksLikePersonName(counterparty)`,
so `paid` is excluded by construction: `You've paid RM100.00 to LEE WEI LING …
using your Ryt Credit` parses with `person_transfer: false` (verified live against
the parser at this revision). That is a hole in the Critical, so the verb list is
widened to `/^(received|sent|paid)$/i`.

This does not disturb the must-book merchant pins, but NOT for the reason a first
reading suggests. Only the uid 132 `was paid at MERCHANT` fixture is safe by
construction: that branch is parsed at bank-movement.js:250-252 and carries no
`person_transfer` key at all (verified). The uid 917/918 pins are a DIFFERENT
sentence form — `You've paid … to MERCHANT` — which passes through :272-306 and DOES
carry the key, at value `false` only because the verb gate excludes `paid`. Their
real protection is `looksLikePersonName` rejecting them: `CLINIC MERCHANT` because
`clinic` is in NON_PERSON, and `365 BAKERY` because of the bare-digit rejection
(pinned at production-incidents.test.js:113-136). Both pins are listed in Tests
item 6, asserted in the sentence form they actually use, so a change to
NON_PERSON that flipped them would be caught.

### F2 — hold the ambiguous case

`_resolveMovementToOutput` must produce a held row rather than null when the
source cannot be resolved:

- In the `!source || !date` block (`orchestrator.js:705-741`), add a branch
  beside the existing `A/C ending` one: an outgoing movement whose source is
  unresolvable BUT which has a sender bank (so it is a bank alert whose origin
  account is genuinely ambiguous) is held with `_hold_unresolved_transfer`.

Scope is deliberately narrow — it requires `movement.own_account.bank` set,
`resolved.source_account` null, AND that the alert names no source account at all
(no name, no suffix) while the sender bank has more than one live account. The
hold lands on the FIRST live account at that bank, which is sound because a held
row never inserts, so the account only ever carries the notification.

It must NOT be keyed on `direction + own_account.bank` alone: that predicate also
matches legacy bill payments and cross-bank transfers, which then booked against
the wrong account. Must not fire for an outgoing movement with no bank evidence
at all, which is the `null` return the LLM fallback exists to handle.

**Boundary — a sibling drop this plan does NOT close.** The block has a second
null exit: an outgoing movement that *names* a source account which resolves to
nothing (no live account, no suffix fact). That is the phantom-expense family of
issue #592, described in the comment at orchestrator.js:705-711. Closing it is a
separate change with its own reproduction, because the predicate can also fire on
a genuine one-off account the holder has not registered — the opposite trade from
this fix. It is listed in "Not in scope" and pinned by a test so the boundary is
visible in the suite, not only in prose.

### F1b — say why, using a field that actually renders

All three hold sites set `notify_message: ""` (`:735`, `:783`, `:905`), and the
notify path at `:2395-2406` ignores that field anyway, hardcoding
`Held: transfer destination for ... was not safe to resolve`. For a person-shaped
hold that text is wrong: the destination was never the problem, the counterparty
identity was.

Add a dedicated internal `_hold_cause` string (see the three-cause matrix below) to
the person hold, stripped alongside `_card_repayment` in F3, and switch the notify
template at `:2395-2406` on it: keep the existing destination text for the two
account-resolution holds (`:737`, `:907`) and add person-identity and
source-ambiguous variants naming the counterparty and the cause. `payee_source`
gets its own value for the same reason.

**Three hold texts, not two — F2 adds a third site inside the SAME
`!source || !date` block that returns at `:740`, i.e. BEFORE the person-hold site
at `:761-765`.** So a person transfer that is ALSO ambiguous at the sender bank
(uid 1012's `Your scheduled transfer of … to <person> …`, where the Ryt branch
sets `own_account {name:null, bank:"Ryt", suffix:null}`) takes F2's branch, never
reaches `:761`, and is told the transfer DESTINATION was unsafe when the cause was
the source account. Give F2's new branch its OWN cause string (`Held: source
account ambiguous at this bank; the transfer to "<name>" was not booked`).

**The cause is ONE value per held row, never two booleans (plan round 2, finding
M1).** F2's branch does NOT also set `_hold_person_identity`: that branch already
holds the person-shaped counterparty by name, and `:2395-2406` would see two true
flags on one row with no stated branch order, so the notification would depend on
which `if` happened to come first. Instead the hold sites set one dedicated
`_hold_cause` string — `"destination_unresolved"` (`:737`), `"source_account_ambiguous"`
(F2's new branch), `"person_identity_unverified"` (`:761`) — and the notify
template switches on it, so one row renders exactly one cause. `_hold_unresolved_transfer`
remains the single "this row is held" flag every site already sets; `_hold_cause` is
the discriminator. `payee_source` still gets its own value per site for the same
reason.

Tests assert all three texts render their own cause, and Tests item 7 pins the
uid-1012 shape to the source-ambiguous text REGARDLESS of whether its counterparty
is person-shaped — it never sets `_hold_person_identity`, because it never reaches
`:761`.

**Do NOT branch on `reasoning`.** It is a literal for the Phase-1 hold but
LLM-authored free text for the three Phase-2 holds (`:2142`, `:2167`, `:2234` all
set `payee_source = "transfer_destination_refused"`), so keying the notification on
it makes the wrong-text failure mode untestable. A dedicated boolean plus
`payee_source` matches the existing vocabulary and the F3 hygiene.

The notification does NOT instruct the user to teach the counterparty: there is no
reply path and no auto-learn (`learn_fact` is called only at :2749 and :2822, and
the payee-mapping grammar is migration-only per memory.js:957-976), so such an
instruction would be a promise the system cannot keep.

Also mark the email read on the hold path. The hold branch never called
`mark_email_read`, while `imap.js:86` re-fetches `{ unseen: true }` on every idle
poll — so a held alert notifies repeatedly today, and with change #1 that would
become the most common merchant shape. The hold is already journaled via
`log_decision` at `:2403`, so nothing is lost by marking it read.

### H4 — set the flag on the LLM-extractor path

`person_transfer` is written only at bank-movement.js:301,347 and read nowhere.
Set it in `_llmExtractMovement` where that route builds its movement
(orchestrator.js:1040-1052), so the value exists BEFORE `:1053` calls
`_resolveMovementToOutput` and the F1 hold applies to that route too.

**The check is NOT "the same" as the parser's — the two paths disagree on
direction, not on spelling.** The deterministic Ryt branches build `counterparty`
from the NAMED PERSON in both directions (bank-movement.js:293-297), so there
`looksLikePersonName(counterparty)` means "the counterparty is a person". The
extractor route assigns `own_account` from `from_account` and `counterparty` from
`to_account` UNCONDITIONALLY (orchestrator.js:1046-1047), and
`getMovementExtractorPrompt` (prompts.js:124) defines `to_account` as the
destination — which on an incoming movement is the HOLDER'S OWN ACCOUNT. Verified:
`looksLikePersonName` is true for `Main Account`, `Savings Account`,
`Current Account`, `POSB Cashback Account`, `Ryt Credit` and `DBS account`, and
false for `DBS Account 5500`, `OCBC 360`, `Your account ending 5500`. Keying on
`to_account` unconditionally therefore holds real incoming credits, and the
release predicate cannot rescue them: the plan's own fact table marks the only two
account-shape facts this module writes (`NAME is a TYPE account` :2749,
`... ending NNNN belongs to NAME` :2819) as unable to release, so no
`Main Account maps to <x> payee|category` fact can ever exist.

Key the flag on the correct side per direction, and on nothing else:

```js
const namedParty = direction === "outgoing" ? to : from;
person_transfer = looksLikePersonName(namedParty);
```

**There is NO name-matches-account suppression (plan round 2, finding H6).** An
earlier revision of this section added one — "suppress it whenever that name is
one of the holder's own live accounts (`matchAccountByName(namedParty, accounts,
aliases).matched`)" — reasoning that "an account name is by definition not a
counterparty". That is false for the resolver named: `matchAccountByName`
(suffix-facts.js:288-304) falls through to `matchWithoutAliases` step 2 (:246-275),
which matches on TOKEN CONTAINMENT (`query.every(w => target.includes(w))`). With
accounts `[Ryt Bank, Wei Ling Savings]`, the person name `WEI LING` resolves
`matched:true` to `Wei Ling Savings` while `WEI LING TAN` does not. So the
suppression silently turns OFF the hold for a real person transfer whenever the
holder has a joint, trust, minor or homonym account, and F1's new OR-term then
reads `person_transfer === false` and never fires — the Critical re-opens on the
very route H4 exists to close.

Measured, on the same `You've sent RM250.00 to WEI LING … using your Main Account`
alert: deterministic route -> `person_transfer:true`, held, notified, no insert;
extractor route -> `hold:false`, `payee_name:"Misc"`, phase 3
`{action:"inserted", details:"MYR 250 at WEI LING -> Misc"}`, `insert_transaction`
called. The same email holds on one route and posts as spend on the other.

The direction keying alone is sufficient and is verified: an extractor-routed
incoming credit whose `from_account` is `LEE WEI LING` and whose `to_account` is
`Main Account` sets `person_transfer:true` and is held. If an own-account guard is
ever wanted it must compare WHOLE tokens —
`normalizeIdentityName(namedParty) === normalizeIdentityName(account.name)` over
live accounts — the same discipline the release predicate uses, and never
`matchAccountByName(...).matched`. Do not add it here: an account list and aliases
are not in scope at `:1040-1052` (`_llmExtractMovement` holds no context; the
resolver reads its own `fetch_context` at `:684`), so the term would either not
compile or cost an extra context round-trip per alert.

Tests item 8 therefore pins BOTH directions by direction keying alone: an incoming
credit whose `to_account` is the holder's own `Main Account` must not set the flag,
and an outgoing one whose `to_account` is `LEE WEI LING` must — plus a case where
an OUTGOING counterparty that resolves by containment to an account (`WEI LING` vs
`Wei Ling Savings`) is still held, so a reintroduced suppression cannot go green.

It must NOT be set at the Phase-1 sanitize block (`:1297-1303`). Every
`_resolveMovementToOutput` caller — `_runStructuredMovement` (:667-673),
`_llmExtractMovement` (:1053), `_runLegacyBillPaymentMovement` (:1070) — is
reached from `_runPhase1` (:1084-1106) before that block, and nothing feeds its
output back through the resolver, so a value set there could never reach the hold.

The generic full Phase-1 LLM path (loop at :1128, taken when `MOVEMENT_LIKE` does
not match) never enters the resolver at all, so no movement-shaped hold can reach
it. That boundary is stated in "Not in scope" and pinned by a test.

### F3 — sanitize

Add `delete output._card_repayment;` and `delete output._hold_cause;` to
the list at `orchestrator.js:1297-1303`, and extend the existing sanitizer test
rather than adding a file, so the invariant stays pinned next to its siblings.

## Tests

RED first, each failing on real code at the revision named in Evidence:

1. `tests/transfer-person-hold-red.test.js` — transfer to the holder with no
   legal-name fact is held, not inserted; transfer to a NON-holder person is
   held. (currently 2 failed / 1 passed at this revision)
2. `tests/transfer-ambiguity-hold-red.test.js` — two Ryt accounts must produce
   a held row, never a null phase1; `_card_repayment` cannot survive Phase 1.
   (currently 2 failed at this revision)
3. `tests/llm-output-sanitizer.test.js` — add BOTH flags to the existing
   "strips the other LLM-injectable internal flags too" case.
4. NEW — F1b: a hold carries a notification naming the counterparty and the
   cause, and the held email is marked read. H4: an LLM-routed person-shaped
   alert is held, not booked.
5. NEW — the release predicate, BOTH directions, so the hold cannot be
   over-broad either way:
   - person counterparty, no fact → held;
   - the same counterparty with a `... merchant maps to ... payee` fact in
     memory → books normally;
   - the same counterparty with ONLY a legal-name fact
     (`Legal name: <holder> -> <MNEMONIC> (statement password)`) → still held
     (the case an overlap rule gets wrong, and F1's own regression guard);
   - an incoming person credit with ONE live account at the sender bank → held,
     and NOT booked as income;
   - the same incoming credit with TWO live accounts at the sender bank → still
     dropped (the M2 boundary, pinned so the claim cannot silently widen).
6. NEW — boundary pins, so the gaps are visible in the suite and not only in prose:
   - `paid ... to LEE WEI LING` is held (the `:292-293` verb fix);
   - `was paid at CFF UNITED PLT` still books (must-book pin preserved);
   - `You've paid ... to CLINIC MERCHANT` and `... to 365 BAKERY` still book —
     asserted on the SENTENCE FORM they actually use, because the protection is
     `looksLikePersonName` rejecting `CLINIC MERCHANT` (`clinic` in NON_PERSON)
     and `365 BAKERY` (bare-digit), NOT the absence of a `person_transfer` key;
   - `ACME CONSULTANCY` is now held (must-hold pin, amended — see Behaviour changes);
   - a `paid ... to <person-shaped real merchant>` sentence (e.g. `MARINA BAY
     SANDS`, `NTUC FAIRPRICE`, both verified person-shaped) is held, and the same
     counterparty with a `maps to ... payee` fact books — the new surface the verb
     widening opens, pinned on both sides;
   - the release fact is effective OUTGOING only: an outgoing person credit with a
     `maps to ... payee` fact books, and the same INCOMING credit with that fact
     is DROPPED, not booked (no incoming booking arm — `:936`; plan round 2
     finding M3), pinned on both sides;
   - an outgoing movement naming an unresolvable source account still yields the
     current drop (the F2 boundary);
   - the generic full Phase-1 LLM path (loop at :1128) never enters
     `_resolveMovementToOutput` and therefore never reaches a movement hold.
7. NEW — the three hold texts each render their OWN `_hold_cause`, one per row:
   destination-unresolved (`:737`), person-identity (`:761`), and
   source-account-ambiguous (F2's new branch). The uid-1012 shape reaches F2's
   branch FIRST and so never reaches `:761`: it is pinned to the
   source-ambiguous text REGARDLESS of whether its counterparty is person-shaped,
   and it sets no second cause flag.
8. NEW — H4 direction pins, by direction keying ALONE:
   - an extractor-routed INCOMING credit whose `to_account` is the holder's own
     `Main Account` must NOT set `person_transfer`; an outgoing one whose
     `to_account` is `LEE WEI LING` must;
   - an OUTGOING transfer to `WEI LING` is HELD even with a live account named
     `Wei Ling Savings` in the set — i.e. no name-matches-account suppression at
     either the H4 site or the `:764` hold term, so a reintroduced
     `matchAccountByName(...).matched` term cannot go green. This case fails at the
     reviewed revision without the F1 restructure;
   - a held INCOMING credit's `merchant`, `raw_description` and notification name
     the SENDER (`LEE WEI LING`), never the holder's own account.

Items 1-2 are new whole test files under `tests/`, which the dev-loop policy
treats as a `tests_only` mutation, plus lines added to existing test files.

## Evidence

- **RED — this is the recorded reproduction.** Verified at revision `51a9498` on
  2026-10-05, with the two RED files present as untracked worktree files:

  ```
  cd modules/expense-transfer-shape-fix/modules/expense-tracker   # (worktree path)
  PATH=<node22>/bin:$PATH npx vitest run \
    tests/transfer-person-hold-red.test.js tests/transfer-ambiguity-hold-red.test.js
  → Test Files 2 failed (2) | Tests 4 failed | 1 passed (5)
  ```

  Failing assertions, named: `transfer-person-hold-red.test.js:57` and `:78`
  `expected false to be true`; `transfer-ambiguity-hold-red.test.js:96`
  `expected true to be undefined`; and the ambiguity case asserting the notify
  string `Couldn't understand this tran…` instead of a held row.
- **The `repro_evidence` in `.agents/dev-loop-state.json` is NOT used as the RED
  record.** Its output prints `FAIL:` and `PASS:` for the same `test_id` and it
  names base `f0b9a5b` rather than the branch tip, so it is non-atomic and cannot
  be read as a repro (gap G1 in `.agents/dev-loop/gap-findings-654.md`). The
  command above supersedes it.
- **GREEN (exact):** the same command must exit 0 after the change.
- **Full suite — named baseline, measured on this machine.** This container's own
  Node is v26.5.1, which cannot load the `better-sqlite3` binding (absent for
  that ABI), so a bare `npx vitest run` is not a valid baseline: it reported
  `12 failed | 32 passed (44)` files / `153 failed | 1055 passed | 5 skipped`
  tests, every failure a missing-bindings error that says nothing about the code.
  Baseline captured under **Node v22.20.0** (the version CI uses, `test.yml:24`),
  installed to `/workspace/.tools/node-v22.20.0-linux-x64`, after
  `npm rebuild better-sqlite3` in the gitignored `node_modules` — a local
  environment fix that touches no tracked file:

  ```
  cd modules/expense-tracker
  PATH=/workspace/.tools/node-v22.20.0-linux-x64/bin:$PATH npm test
  ```

  **Baseline at `51a9498`, WITH the two RED files present:**
  `1200 passed | 8 failed | 5 skipped (1213)`, `Test Files 4 failed | 40 passed (44)`.

  The 8 failures are NOT all this change's. Measured individually:
  - `transfer-person-hold-red.test.js` — 2 failed (the F1 RED, expected);
  - `transfer-ambiguity-hold-red.test.js` — 2 failed (the F2/F3 RED, expected);
  - `orchestrator.test.js` — 4 failed, all `Test timed out in 5000ms`
    (`:2726`, `:2835`, `:2907`, `:3078`, the #574 journal cases);
  - `dedup.test.js` — worker-hook `onTaskUpdate` timeouts (`:14`, `:81`, `:177`).

  **CORRECTION (plan round 2, finding M3): the two flaky files do NOT fail when run
  alone on this machine.** The earlier claim that they "fail when that file is run
  alone too" is false and is withdrawn. Re-measured under Node v22.20.0 at this
  revision:
  - `npx vitest run tests/orchestrator.test.js` → `Test Files 1 passed (1) | Tests
    108 passed (108)`, twice, ~21s each;
  - `npx vitest run tests/dedup.test.js` → `Test Files 1 passed (1) | Tests 39
    passed (39)`, ~103s, with one worker `onTaskUpdate` error and NO failing test.

  The reproducible claim is the stronger one: **both files pass in isolation and
  only fail under full-suite parallel load in this container**, because they drive
  real sqlite/worker fixtures and are slow enough here to trip vitest's 5s
  per-test and worker-RPC deadlines. That is a load ceiling, not a broken file.
  Their counts also vary between full-suite runs on this box (`8 failed`, `9
  failed` and `10 failed` were all observed at the same revision), so the printed
  total is only indicative. They do not reproduce in CI on Node 22 — the
  `expense-tracker` check passes on this branch — and CI on Node 22
  (`npm ci && npm test`) is the authoritative full-suite gate.

  **GREEN is therefore, in this order:**
  1. the two RED files pass;
  2. the pins in Tests items 5-8 hold their stated outcomes;
  3. **no test this change touches may fail, whichever file it lives in** — the
     delta rule is scoped by TEST NAME, not by file. Concretely: every test in
     `tests/orchestrator.test.js`, `tests/bank-movement.test.js`,
     `tests/production-incidents.test.js`, `tests/deterministic-orchestrator.test.js`
     and `tests/llm-output-sanitizer.test.js` must pass, and the #574
     transfer-detection cases at `:2726/:2835/:2907/:3078` must pass IN ISOLATION
     (`npx vitest run tests/orchestrator.test.js`) since they demonstrably do;
  4. the only failures tolerated in a full-suite run are timeout/RPC-shaped ones in
     `orchestrator.test.js` and `dedup.test.js`, and each must be shown to be
     timeout-shaped rather than assertion-shaped. Any NEW failing file or test name
     fails the gate.
- The earlier "42 files / 1203 passed / 5 skipped / 0 failed" figure was recorded
  against a different revision and is NOT inherited. It is replaced by the
  measured run above.

## Behaviour changes callers must know about

1. A transfer in EITHER direction to any unremembered person-shaped counterparty
   is HELD, not booked — outgoing stops being booked as spend, and incoming stops
   being booked as income — **provided the sender bank has exactly ONE live
   account**. With 2+ accounts at the sender bank an INCOMING person credit is
   still dropped, unchanged by this change (see q7 and "Not in scope"). This closes
   the Critical, and it re-admits
   the name-shape sensitivity that `orchestrator.js:743-747` once removed to fix a real
   production incident (`CFF UNITED PLT` wrongly held).
   **The `maps to ... payee|category` release applies to OUTGOING person movements
   only.** An INCOMING person credit is HELD when the predicate does not release
   it and still DROPPED when it does, because no incoming booking arm exists for a
   movement that has a counterparty and is not internal (it falls to `return null`
   at `:936`) — measured identically at HEAD and after the change, so this is
   inherited, not introduced here (plan round 2, finding M3). The fact is therefore
   an unblock for the outgoing direction only. A brand-new vendor is HELD every
   time until such a fact exists — which today means a
   migration-written or hand-written fact line (write it with `learn_fact`), NOT a
   reply to the notification.
   The must-book pin at `production-incidents.test.js:663` (`ACME CONSULTANCY`)
   therefore changes from "must book" to "must hold" and is amended by this
   change — stated plainly here and in the PR body rather than buried. The
   `CFF UNITED PLT` pin at `:646-660` and the `was paid at` form are NOT affected.
2. `_card_repayment` and `_hold_cause` are stripped from LLM output
   (hardening, no booking change).
3. A hold now names the counterparty and the cause in its notification.
4. A held email is marked read, so it no longer re-notifies on every idle poll.
   This is new: today the hold branch never called `mark_email_read`.

## Not in scope

- The `#574` generic-PayNow hold asymmetry found during review
  (`byId` arm vs `:2155-2159`) — a separate defect with its own reproduction;
  it does not share a root cause with F1-F3 and mixing them would widen the
  diff past what the findings prove.
- The named-but-unresolvable source-account drop (the F2 boundary above, the
  issue #592 phantom-expense family) — pinned by a test, fixed separately.
- **An INCOMING person credit for a holder with 2+ live accounts at the sender
  bank** — dropped at orchestrator.js:740 today and after this change, because
  `resolveAccountByBank` refuses an ambiguous bank and F2's new branch is keyed on
  `outgoing`. Closing it means widening the ambiguity branch to incoming person
  movements, which is the opposite trade from F2 (it would also cover every
  incoming bank credit), so it is its own change with its own reproduction. Pinned
  at both account counts.
- The `paid` verb widening's new surface: recurring person-shaped merchant
  descriptors (`MARINA BAY SANDS`, `NTUC FAIRPRICE`, `GOLDEN VILLAGE`,
  `COLD STORAGE`, `FARM FRESH`, `BUKIT TIMAH` are all verified person-shaped) are
  held every time until a `maps to` fact exists, which the pipeline never writes
  for a merchant it has no fact for. Disclosed in Behaviour change #1, pinned on
  both sides in Tests item 6, and the unblock is `learn_fact`.
- **An INCOMING person credit released by a `maps to … payee` fact** — dropped,
  not booked, because `_resolveMovementToOutput` has no incoming booking arm for a
  movement that has a counterparty and is not internal (it falls to `return null`
  at `:936`). Inherited at HEAD, measured identical before and after this change
  (plan round 2, finding M3). Pinned at both outcomes so it cannot silently
  widen; closing it means adding an incoming person arm, which is its own change
  with its own reproduction.
- Person-shaped counterparties on the generic full Phase-1 LLM path (:1128),
  which never enters `_resolveMovementToOutput` and cannot reach a movement hold.
- `CARD_PRODUCT_RE`'s redundant alternation (`\bcredit\s+cards?\b` already
  covers `\bcredit\s+card\b`) — cosmetic, no behaviour change.
- A reply-to-teach resolution path for holds (Darren's Option 2, not chosen).
  Tracked in issue #670.