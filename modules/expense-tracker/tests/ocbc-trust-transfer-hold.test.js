/**
 * Regression coverage for the S$6.48 OCBC 360 -> Trust Bank transfer of
 * 2026-09-27 that booked as nothing: both legs were held.
 *
 *   uid 968  Trust  "KACHING. You've got a transfer"        -> held
 *   uid 969  OCBC   "We have processed your funds transfer"  -> held
 *
 * The two legs are ONE movement, and each has its own distinct cause:
 *
 * 1. uid 968 (the Trust credit). The deterministic parser resolved the whole
 *    pair correctly — OCBC 360 is the counterparty (suffix 6600, which memory
 *    maps to OCBC 360), Trust Bank is the credited account (from the stored
 *    "Trust alert recipient maps to Trust Bank account" fact) — and emitted a
 *    ready `_transfer` reservation. Phase 2 then discarded it: back then the
 *    `resolved.internal` branch did not set `_structured_movement` (the fix
 *    added it), so the LLM-path ambiguity gate re-judged an already-decided
 *    destination from the
 *    BANK NAME ("OverseaChinese Banking Corporation Ltd" -> OCBC) rather than
 *    the account suffix the alert body actually carries. Two open OCBC-named
 *    accounts (OCBC 360, OCBC 90N) made that read as ambiguous, so the row was
 *    flipped to `Misc` + `_hold_unresolved_transfer` (issue #575).
 *
 * 2. uid 969 (the OCBC request). Held for a different and correct reason: the
 *    destination `Darren Trust (-222000)` had no stored suffix fact, so the
 *    destination account could not be verified as one of yours. The fact now
 *    exists (`Account ending 222000 belongs to Trust Bank`), so the leg
 *    resolves. This test pins that it resolves, and that the safety gate still
 *    refuses when the fact is absent.
 *
 * Bodies are the production bodies, with one caveat recorded at the `WRAPPED`
 * constant below: the uid 968 constant is the whitespace-FLATTENED form of the
 * bank's 80-column text/plain, and the wrap point inside it is reconstructed,
 * not a byte-exact copy. Amounts, dates, times, reference numbers, suffixes,
 * and product names are retained — they are what resolution keys on. The
 * account holder's given name is left as the bank printed it; no statement
 * password or credential appears.
 */
import { describe, expect, it, vi } from "vitest";
import { parseBankMovement } from "../src/bank-movement.js";

// ── Production bodies ───────────────────────────────────────────

/** Email uid 968 — Trust "KACHING. You've got a transfer". */
const TRUST_INBOUND_TRANSFER = `💰❤️🎉 Sweet! You have received SGD 6.48 from OverseaChinese Banking Corporation Ltd A/C ending 6600 on 27 Sep 2026 11:49 SGT. For more info, please contact us via Trust App.`;

/** Email uid 969 — OCBC "We have processed your funds transfer request". */
const OCBC_TRANSFER_REQUEST = `Dear Valued Customer

We have received your request to make the following transfer:

Date of Transfer   : 27 Sep 2026
Time of Transfer   : 11.49 AM SGT
Amount             : SGD 6.48
From your account  : 360 Account (-166600)
To account         : Darren Trust (-222000) at TRUST BANK SINGAPORE LIMITED
Reference number   : 2609270064297585
`;

// ── Live-shaped account set (Darren SGD) ─────────────────────────

const OCBC_360 = "942dc4d1-7310-429e-8c53-54bb9571ce81";
const OCBC_90N = "4b313497-6203-47b6-857e-1ff62874ca46";
const TRUST_BANK = "2dd467dd-b953-47a5-be47-1c23866400ce";
const TRUST_CARD = "8eff953e-05c5-4024-9fee-ffad8b6320e9";

const accounts = [
    { id: OCBC_360, name: "OCBC 360", closed: false },
    { id: OCBC_90N, name: "OCBC 90N", closed: false },
    { id: TRUST_BANK, name: "Trust Bank", closed: false },
    { id: TRUST_CARD, name: "Trust Card", closed: false },
];

const payees = [
    { id: "p-ocbc-360", name: "OCBC 360", transfer_acct: OCBC_360 },
    { id: "p-ocbc-90n", name: "OCBC 90N", transfer_acct: OCBC_90N },
    { id: "p-trust-bank", name: "Trust Bank", transfer_acct: TRUST_BANK },
    { id: "p-trust-card", name: "Trust Card", transfer_acct: TRUST_CARD },
];

/** The stored facts that made this pair resolvable on 2026-09-27. */
const facts = [
    { text: "Account ending 166600 belongs to OCBC 360", score: 1 },
    { text: "Account ending 6600 belongs to OCBC 360", score: 1 },
    { text: "Account ending 222000 belongs to Trust Bank", score: 1 },
    { text: "Trust alert recipient maps to Trust Bank account", score: 1 },
    { text: "OCBC 360 is a bank account", score: 1 },
    { text: "Trust Bank is a bank account", score: 1 },
];

async function orchestrate(
    body,
    {
        senderBank,
        receivedAt,
        facts: factOverride = null,
        accounts: accountOverride = null,
        payees: payeeOverride = null,
    } = {},
) {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const activeFacts = factOverride || facts;
    const activeAccounts = accountOverride || accounts;
    const activePayees = payeeOverride || payees;
    const calls = [];
    const tools = {
        executeTool: vi.fn(async (name, args) => {
            calls.push({ name, args });
            if (name === "fetch_context")
                return { accounts: activeAccounts, categories: [], payees: activePayees };
            if (name === "search_memory")
                return { results: activeFacts };
            if (name === "check_duplicate") return false;
            if (name === "check_schedule_collision") return false;
            // The transfer-link probe. Its contract is
            // `{candidate, matches}`: no far side booked yet is
            // `{candidate: null, matches: 0}`. Returning a bare truthy value
            // here reads as a failed far-side read, which holds the row.
            if (name === "find_link_candidate")
                return { candidate: null, matches: 0 };
            if (name === "insert_transaction")
                return {
                    id: "tx-1",
                    account: args.account_id,
                    date: args.date,
                    amount: args.amount_cents,
                    payee_name: args.payee_name || "Misc",
                    category: args.category_id || null,
                    cleared: false,
                };
            return true;
        }),
        getPhase1ToolSchemas: vi.fn(() => []),
        setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(
        {
            primaryCurrency: "SGD",
            secondaryCurrency: "MYR",
            primaryBudgetFile: "budget-sgd",
            secondaryBudgetFile: "budget-myr",
            llmProvider: "deepseek",
            llmApiKey: "sk-test",
            deepseekApiKey: "sk-test",
        },
        tools,
    );
    orch._llm.chat = vi.fn();
    const phase1 = await orch._runPhase1(body, { senderBank, receivedAt });
    // A body the deterministic parser refuses hands Phase 1 nothing usable;
    // that refusal is itself a correct outcome, so it is surfaced as null
    // rather than fed into Phase 2.
    const phase2 = phase1
        ? await orch._resolvePhase2(phase1)
        : null;
    const result = phase1 ? await orch._executePhase3(phase2) : null;
    return { phase1, phase2, result, calls };
}

// ── The Trust credit leg (uid 968) ──────────────────────────────

describe("uid 968 Trust inbound transfer credits Trust Bank as a transfer", () => {
    it("parses the uid 968 body with the counterparty suffix intact", () => {
        const movement = parseBankMovement(TRUST_INBOUND_TRANSFER, {
            senderBank: "Trust",
            receivedAt: "2026-09-27T03:49:46.000Z",
        });

        expect(movement).toMatchObject({
            kind: "bank_movement",
            direction: "incoming",
            amount_cents: 648,
            currency: "SGD",
            own_account: null,
            counterparty: {
                name: "OverseaChinese Banking Corporation Ltd",
                bank: "OCBC",
                suffix: "6600",
            },
            recipient_bank: "Trust",
        });
    });

    it("books the credit to Trust Bank with the OCBC 360 transfer reserved, not held", async () => {
        const { phase2, result, calls } = await orchestrate(TRUST_INBOUND_TRANSFER, {
            senderBank: "Trust",
            receivedAt: "2026-09-27T03:49:46.000Z",
        });

        // Credited account is the Trust account that received it.
        expect(phase2.account_id).toBe(TRUST_BANK);
        expect(phase2.amount_cents).toBe(648);
        // The counterparty resolved to the holder's own OCBC account, so this
        // is an own-account transfer: OCBC 360 -> Trust Bank.
        expect(phase2.payee_name).toBe("OCBC 360");
        expect(phase2._is_transfer).toBe(true);
        expect(phase2.category_id).toBeNull();
        // The regression: the Phase-2 ambiguity gate used to clear these and
        // hold the row instead, throwing the reservation away.
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(phase2._transfer).toMatchObject({
            source_account_id: OCBC_360,
            destination_account_id: TRUST_BANK,
            amount_cents: 648,
            currency: "SGD",
        });
        // And it really booked, rather than only resolving correctly.
        expect(result.action).toBe("inserted");
        const insert = calls.find((c) => c.name === "insert_transaction");
        expect(insert).toBeDefined();
        expect(insert.args.amount_cents).toBe(648);
    });

    it("still refuses a destination the row is already booked on", async () => {
        // The control on the fix. Marking the internal-transfer branch as
        // structured exempts it from the AMBIGUITY check only. Every other
        // guard must still fire, and a row must never become a transfer ONTO
        // the account it already sits on.
        //
        // Driven directly against `_resolvePhase2` with a hand-built row
        // because the deterministic parser cannot produce this shape: it
        // refuses a closed counterparty upstream, and it never books a
        // transfer whose far leg equals the booked account.
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const tools = {
            executeTool: vi.fn(async (name) => {
                if (name === "fetch_context")
                    return { accounts, categories: [], payees };
                if (name === "search_memory") return { results: [] };
                return true;
            }),
            getPhase1ToolSchemas: vi.fn(() => []),
            setEmailContext: vi.fn(),
        };
        const orch = new AgentOrchestrator(
            {
                primaryCurrency: "SGD",
                secondaryCurrency: "MYR",
                primaryBudgetFile: "b",
                secondaryBudgetFile: "m",
                llmProvider: "deepseek",
                llmApiKey: "x",
                deepseekApiKey: "x",
            },
            tools,
        );
        orch._llm.chat = vi.fn();

        // Booked on OCBC 360, and the payee names OCBC 360: a self-target.
        const phase2 = await orch._resolvePhase2({
            merchant: "OCBC 360",
            amount_cents: -648,
            date: "2026-09-27",
            currency: "SGD",
            account_id: OCBC_360,
            account_name: "OCBC 360",
            budget_id: "b",
            action: "insert",
            payee_name: "OCBC 360",
            raw_description: "Transfer to OCBC 360",
            notes: "",
            category_id: null,
            reasoning: "",
            notify_message: "",
        });

        expect(phase2._hold_unresolved_transfer).toBe(true);
        expect(phase2.payee_name).toBe("Misc");
        expect(phase2._transfer).toBeFalsy();
    });
});

// ── The OCBC request leg (uid 969) ──────────────────────────────

describe("uid 969 OCBC transfer request books once 222000 is known", () => {
    it("resolves the destination and books the outgoing leg as a transfer", async () => {
        const { phase2, result } = await orchestrate(OCBC_TRANSFER_REQUEST, {
            senderBank: "OCBC",
            receivedAt: "2026-09-27T03:49:46.000Z",
        });

        expect(phase2).toMatchObject({
            account_id: OCBC_360,
            amount_cents: -648,
            payee_name: "Trust Bank",
            category_id: null,
            _is_transfer: true,
        });
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(phase2._transfer).toMatchObject({
            source_account_id: OCBC_360,
            destination_account_id: TRUST_BANK,
            amount_cents: 648,
        });
        expect(result.action).toBe("inserted");
    });

    it("still holds when the destination suffix has no fact", async () => {
        // Exactly the production state that produced the hold: drop the
        // 222000 fact and the destination cannot be verified as the holder's
        // own, so the row must still be held rather than guessed at.
        const { phase2 } = await orchestrate(OCBC_TRANSFER_REQUEST, {
            senderBank: "OCBC",
            receivedAt: "2026-09-27T03:49:46.000Z",
            facts: facts.filter(
                (f) => !f.text.includes("222000"),
            ),
        });

        expect(phase2._hold_unresolved_transfer).toBe(true);
        expect(phase2.payee_name).toBe("Misc");
    });
});

// ── The unit-level gate (#575) ──────────────────────────────────

// ── The gate itself keeps its bank-name rule ────────────────────

describe("transferDestinationIsAmbiguous", () => {
    it("stays ambiguous when a bank name matches several open accounts", async () => {
        // The rule the fix deliberately does NOT weaken. "OverseaChinese
        // Banking Corporation Ltd" matches both OCBC 360 and OCBC 90N, and
        // this gate is only reached by rows that were never resolved from
        // suffix evidence, so the name alone stays ambiguous.
        const { transferDestinationIsAmbiguous } = await import(
            "../src/orchestrator.js"
        );
        expect(
            transferDestinationIsAmbiguous(
                "OverseaChinese Banking Corporation Ltd",
                accounts.find((a) => a.id === OCBC_360),
                accounts,
            ),
        ).toBe(true);
    });

    it("is not ambiguous when the name itself resolves to the destination", async () => {
        const { transferDestinationIsAmbiguous } = await import(
            "../src/orchestrator.js"
        );
        // The pre-existing direct-match rule must survive the change. The gate
        // takes the live account OBJECT, not a bare id.
        const ocbc360 = accounts.find((a) => a.id === OCBC_360);
        expect(
            transferDestinationIsAmbiguous("OCBC 360", ocbc360, accounts),
        ).toBe(false);
    });
});

// ── What `_structured_movement` actually guarantees (#623) ──────

describe("_structured_movement is not a synonym for an internal resolution (#623)", () => {
    // The #575 fix marked the `resolved.internal` branch structured. The flag
    // has a property that is easy to get wrong: it is NOT proof that an
    // internal resolution happened. It is set on three resolution outcomes in
    // `AgentOrchestrator._resolveMovementToOutput` (src/orchestrator.js:633) —
    // the internal transfer, the deterministic external payment, and the
    // one-sided incoming deposit — and only the first of those is
    // `resolved.internal`, so a row can arrive marked without both legs having
    // resolved to the holder's own accounts. The three branches that return
    // `_hold_unresolved_transfer` and the trailing `return null` do NOT set it.
    //
    // An earlier version of this comment argued that claim against PR #624's
    // docstring, on the grounds that it said the flag is set "for every
    // internal resolution, whichever extractor produced the movement". That
    // was wrong twice over: no such sentence appears at 05d3dbf, and the
    // wording it was aimed at came from 2cd21ec, which 05d3dbf replaced. The
    // claim below is asserted on its own evidence instead, from the three flag
    // sites, and stands on its own. PR #624's current docstring states the same
    // thing and points back at this file.

    const withoutTrustPayee = () =>
        payees.filter((p) => p.transfer_acct !== TRUST_BANK);

    // The boundary this pins, which `bank-movement.test.js` does not: there the
    // external branch is reached with the destination never resolving to an own
    // account at all (it is a merchant), so nothing there separates "destination
    // resolved" from "internal". Here the destination DOES resolve to one of the
    // holder's own accounts and the row is still not internal.

    it("resolves the uid 969 destination without a transfer payee, so it is not internal", async () => {
        const { identityMappingsFromFacts, resolveMovementAccounts } =
            await import("../src/bank-movement.js");
        const movement = parseBankMovement(OCBC_TRANSFER_REQUEST, {
            senderBank: "OCBC",
            receivedAt: "2026-09-27T03:49:46.000Z",
        });
        const resolved = resolveMovementAccounts(
            movement,
            accounts,
            withoutTrustPayee(),
            identityMappingsFromFacts(facts, accounts),
        );

        // The destination is still one of the holder's own accounts...
        expect(resolved.destination_account.id).toBe(TRUST_BANK);
        // ...but `internal` also requires a transfer payee for that
        // destination (src/bank-movement.js:578), so this resolution is not
        // internal even though the destination was matched.
        expect(resolved.internal).toBe(false);
    });

    it("marks that non-internal row structured anyway", async () => {
        const { phase1, phase2, calls } = await orchestrate(OCBC_TRANSFER_REQUEST, {
            senderBank: "OCBC",
            receivedAt: "2026-09-27T03:49:46.000Z",
            payees: withoutTrustPayee(),
        });

        expect(phase1._structured_movement).toBe(true);
        // This test runs ONLY the uid 969 body, so it cannot demonstrate a
        // cross-leg double-count on its own; that needs both alerts in one
        // scenario. What it does show is that the flag is not load-bearing for
        // this row and that the row does NOT become a transfer: the external
        // branch leaves `payee_name` empty, and Phase 2's transfer block is
        // gated on a non-empty payee, so neither the ambiguity gate nor a
        // `_transfer` reservation is ever reached for it.
        //
        // With the uid 968 credit leg run alongside this one, that produces a
        // DOUBLE-COUNT: the credit leg reserves the pair and books +648, while
        // this leg books a second -648 out of the same OCBC 360. Tracked as
        // #629, not #623 (which is the unrelated opposite-polarity flag
        // defect). #629 carries the evidence and the acceptance criteria.
        const inserts = calls.filter((c) => c.name === "insert_transaction");
        expect(inserts).toHaveLength(1);
        // Still a plain payment out of the source account, not a transfer leg.
        expect(inserts[0].args.amount_cents).toBe(-648);
        expect(inserts[0].args.account_id).toBe(OCBC_360);
        expect(phase1.payee_name).toBe("");
        expect(phase2._is_transfer).toBeFalsy();
        expect(phase2._transfer).toBeFalsy();
    });
});

// ── The uid 968 body keeps parsing across input paths ──

describe("uid 968 tolerates the bank's wrapped text/plain body", () => {
    // The bank's text/plain part wraps mid-counterparty. Matching against
    // collapsed whitespace makes the parser independent of MIME line wrapping
    // and keeps the Telegram/text path aligned with the IMAP path.
    // This is redacted production data from uid 968: amount/date/time,
    // suffix, and bank/product wording are retained; no credential is present.
    // The IMAP extractor already collapses this whitespace; the parser now
    // applies the same normalization when called directly.

    // The Telegram/text entry point bypasses MIME extraction, so this fixture
    // also exercises the raw-body path directly.
    const WRAPPED =
        "💰❤️🎉 Sweet! You have received SGD 6.48 from OverseaChinese Banking Corporation\nLtd A/C ending 6600 on 27 Sep 2026 11:49 SGT. For more info, please contact us via Trust App.";

    it("parses the raw wrapped body without relying on email extraction", () => {
        expect(
            parseBankMovement(WRAPPED, {
                senderBank: "Trust",
                receivedAt: "2026-09-27T03:49:46.000Z",
            }),
        ).toMatchObject({
            direction: "incoming",
            amount_cents: 648,
            counterparty: {
                name: "OverseaChinese Banking Corporation Ltd",
                suffix: "6600",
            },
        });
    });

    it("parses once the extractor has collapsed the whitespace", async () => {
        const { extractEmailContent } = await import("../src/extractors.js");
        const raw = [
            "From: Trust <from_us@trustbank.sg>",
            "To: alerts@example.com",
            "Subject: KACHING. You've got a transfer",
            "Date: Sun, 27 Sep 2026 11:49:46 +0800",
            "MIME-Version: 1.0",
            'Content-Type: text/plain; charset="utf-8"',
            "",
            WRAPPED,
        ].join("\r\n");

        const text = await extractEmailContent(Buffer.from(raw, "utf8"));

        expect(text).not.toContain("\n");
        expect(
            parseBankMovement(text, {
                senderBank: "Trust",
                receivedAt: "2026-09-27T03:49:46.000Z",
            }),
        ).toMatchObject({
            direction: "incoming",
            amount_cents: 648,
            counterparty: {
                name: "OverseaChinese Banking Corporation Ltd",
                suffix: "6600",
            },
        });
    });

    it("keeps the processText entry point deterministic for a wrapped alert", async () => {
        // The Telegram/text entry point bypasses MIME extraction. The parser
        // itself must therefore tolerate the same real bank line wrapping.
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const tools = {
            executeTool: vi.fn(async (name) => {
                if (name === "fetch_context")
                    return { accounts, categories: [], payees };
                if (name === "search_memory") return { results: facts };
                if (name === "find_link_candidate") return { candidate: null, matches: 0 };
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction") return { id: "tx-wrapped" };
                return true;
            }),
            getPhase1ToolSchemas: vi.fn(() => []),
            setEmailContext: vi.fn(),
        };
        const orch = new AgentOrchestrator(
            {
                primaryCurrency: "SGD",
                secondaryCurrency: "MYR",
                primaryBudgetFile: "budget-sgd",
                secondaryBudgetFile: "budget-myr",
                llmProvider: "deepseek",
                llmApiKey: "test",
                deepseekApiKey: "test",
            },
            tools,
        );
        orch._llm.chat = vi.fn();

        expect(
            parseBankMovement(WRAPPED, {
                senderBank: "Trust",
                receivedAt: "2026-09-27T03:49:46.000Z",
            }),
        ).toMatchObject({
            direction: "incoming",
            amount_cents: 648,
            counterparty: { suffix: "6600" },
        });

        const phase1 = await orch._runPhase1(WRAPPED, {
            senderBank: "Trust",
            receivedAt: "2026-09-27T03:49:46.000Z",
        });
        expect(phase1).toMatchObject({
            amount_cents: 648,
            currency: "SGD",
        });
        expect(orch._llm.chat).not.toHaveBeenCalled();
    });
});
