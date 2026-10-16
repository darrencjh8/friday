/**
 * Hold-path coverage for the production failures of 2026-10-01..04.
 *
 * `transfer-shape-resilience.test.js` pins the parser. This file pins the
 * DECISION the orchestrator makes from each parsed movement, because for the
 * card-to-card family the parser was already correct — the row was held or
 * booked as an expense downstream.
 *
 * Live-shaped account set and facts are the production ones (ids, names and
 * suffixes are real; they key the resolution and are not secret). Bodies are
 * the real alerts with the holder/counterparty names replaced and reference
 * numbers truncated to their leading segment.
 */
import { describe, expect, it, vi } from "vitest";
import { parseBankMovement } from "../src/bank-movement.js";

const DBS_ACCOUNT = "506df429-0000-0000-0000-000000000001";
const DBS_ALTITUDE = "9029069b-0000-0000-0000-000000000002";
const CITI_REWARD = "5d6eb10b-0000-0000-0000-000000000003";
const UOB_ONE_CARD = "79e2d9d4-0000-0000-0000-000000000004";

const OCBC_360 = "7c1a5e20-0000-0000-0000-000000000005";

const accounts = [
    { id: DBS_ACCOUNT, name: "DBS Account", closed: false },
    { id: DBS_ALTITUDE, name: "DBS Altitude Card", closed: false },
    { id: OCBC_360, name: "OCBC 360", closed: false },
];

const payees = [
    { id: "p-dbs-account", name: "DBS Account", transfer_acct: DBS_ACCOUNT },
    { id: "p-altitude", name: "DBS Altitude Card", transfer_acct: DBS_ALTITUDE },
    { id: "p-ocbc-360", name: "OCBC 360", transfer_acct: OCBC_360 },
    // Both are card payees that name no ACCOUNT. This is the production shape:
    // the DBS alert names the card product ("CITI CREDIT CARDS"), which exists
    // as a payee but has no account behind it in this budget.
    { id: "p-citi", name: "Citi Reward", transfer_acct: null },
    { id: "p-uob-one", name: "UOB One Card", transfer_acct: null },
];

const facts = [
    { text: "Account ending 7222 belongs to DBS Account", score: 1 },
    { text: "Account ending 1777 belongs to DBS Altitude Card", score: 1 },
    // The real memory says "166600"; the real alert prints "(-166600)" in the
    // body and the same account as "360 Account" in the source field, so the
    // two spellings of one account must stay keyed to one mapping.
    { text: "Account ending 166600 belongs to OCBC 360", score: 1 },
    { text: "Card ending 1888 belongs to UOB Ladies Card", score: 1 },
    { text: "DBS Account is a bank account", score: 1 },
    { text: "OCBC 360 is a bank account", score: 1 },
    { text: "DBS Altitude Card is a credit card account", score: 1 },
    { text: "Altitude maps to Entertainment payee", score: 1 },
    { text: "Yuu maps to DBS Yuu Card payee", score: 1 },
    { text: "CITI CREDIT CARDS maps to Citi Reward payee", score: 1 },
    { text: "UOB CREDIT CARDS maps to UOB One Card payee", score: 1 },
];

async function orchestrate(
    body,
    { senderBank, receivedAt, facts: factsOverride, accounts: accountsOverride } = {},
) {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const activeFacts = factsOverride || facts;
    const activeAccounts = accountsOverride || accounts;
    const calls = [];
    const tools = {
        executeTool: vi.fn(async (name, args) => {
            calls.push({ name, args });
            if (name === "fetch_context")
                return { accounts: activeAccounts, categories: [], payees };
            if (name === "search_memory") return { results: activeFacts };
            if (name === "list_facts") return { facts: activeFacts };
            if (name === "check_duplicate") return false;
            if (name === "check_schedule_collision") return false;
            if (name === "find_link_candidate")
                return { candidate: null, matches: 0 };
            if (name === "find_inserted_transfer") return null;
            if (name === "reserve_transfer")
                return { status: "reserved", entry: { id: 1 } };
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
            llmApiKey: "test",
            deepseekApiKey: "test",
        },
        tools,
    );
    orch._llm.chat = vi.fn();
    const phase1 = await orch._runPhase1(body, { senderBank, receivedAt });
    const phase2 = phase1 ? await orch._resolvePhase2(phase1) : null;
    const result = phase1 ? await orch._executePhase3(phase2) : null;
    return { phase1, phase2, result, calls };
}

/** uid 1031 — card -> own card, destination already an account ("Altitude"). */
const DBS_BILLPAY_TO_ALTITUDE =
    "Transaction Ref: 1790867316694201 Dear Customer, You've successfully made a bill payment. " +
    "Date and Time: 01 Oct 21:17 (SGT) Amount: SGD 2435.35 From: My Account (A/C ending 7222) " +
    "To: Altitude (Ref ending 1777) If unauthorised, please call our DBS hotline.";

/** uid 1025 — card -> card, destination named only by product. */
const DBS_BILLPAY_TO_CITI =
    "Transaction Ref: 1790865962876580 Dear Customer, You've successfully made a bill payment. " +
    "Date and Time: 01 Oct 21:12 (SGT) Amount: SGD 345.64 From: Altitude (A/C ending 1777) " +
    "To: CITI CREDIT CARDS (Ref ending 2666) If unauthorised, please call our DBS hotline.";

/** uid 1029 — the outgoing leg of a held own-account FAST transfer. */
const OCBC_TRANSFER_REQUEST_FLAT =
    "Dear Valued CustomerWe have received your request to make the following transfer:" +
    "Date of Transfer:01 Oct 2026Time of Transfer:09.14 PM SGTAmount:SGD 1000.00" +
    "From your account:360 Account (-166600)To account:Darren DBS (-667222) at DBS BANK LTD" +
    "Reference number:26100100114You can log in to OCBC Online Banking and select Customer " +
    "Service > Check internet transaction status to check the status of this transfer.";

describe("a bill payment into the holder's own card account books as a transfer", () => {
    it("does not hold the uid 1031 row", async () => {
        const { phase2, calls } = await orchestrate(DBS_BILLPAY_TO_ALTITUDE, {
            senderBank: "DBS",
            receivedAt: "2026-10-01T13:17:23.000Z",
        });

        expect(phase2).toBeTruthy();
        expect(phase2._hold_unresolved_transfer).toBeFalsy();
        // Booked on the FUNDING side, against the destination's transfer payee,
        // with the money moving out: a repayment into the holder's own card is
        // a transfer between own accounts, never spend on the funding side.
        // Both legs come from the deterministic parser's own resolution, which
        // is why the payee name ("Altitude") does not have to match an account.
        expect(phase2.account_id).toBe(DBS_ACCOUNT);
        expect(phase2.amount_cents).toBe(-243535);
        expect(phase2.payee_id).toBe("p-altitude");
        expect(phase2._is_transfer).toBe(true);
        expect(phase2.category_id).toBeNull();
        const insert = calls.find((c) => c.name === "insert_transaction");
        expect(insert?.args).toMatchObject({
            account_id: DBS_ACCOUNT,
            amount_cents: -243535,
        });
    });

    it("does not hold the uid 1025 row when the destination is a card payee with no account", async () => {
        const { phase2, result, calls } = await orchestrate(DBS_BILLPAY_TO_CITI, {
            senderBank: "DBS",
            receivedAt: "2026-10-01T13:12:59.000Z",
        });

        expect(phase2).toBeTruthy();
        // "CITI CREDIT CARDS" names no account in either budget, but memory
        // maps it to the Citi Reward payee, so the money is a card repayment
        // and must not be posted as spend on the DBS card either.
        expect(phase2._hold_unresolved_transfer).toBeFalsy();
        expect(phase2.amount_cents).toBe(-34564);
        // The whole point: it really books, against the card payee and with no
        // category, rather than being held and notified. Asserting only the
        // Phase-2 shape would pass even if Phase 3 held the row downstream.
        expect(phase2._is_transfer).toBe(true);
        expect(phase2.category_id).toBeNull();
        expect(result.action).toBe("inserted");
        const insert = calls.find((c) => c.name === "insert_transaction");
        expect(insert?.args).toMatchObject({
            account_id: DBS_ALTITUDE,
            amount_cents: -34564,
            payee_id: "p-citi",
        });
        const notify = calls.find((c) => c.name === "notify_user");
        // The only notification is the ordinary "logged" success notice — not a
        // hold, which would mean the repayment was surfaced as unresolved.
        expect(notify?.args.message).toMatch(/logged/i);
        expect(notify?.args.message).not.toMatch(/Held:/i);
        const { parseBankMovement } = await import("../src/bank-movement.js");
        expect(
            parseBankMovement(DBS_BILLPAY_TO_CITI, {
                senderBank: "DBS",
                receivedAt: "2026-10-01T13:12:59.000Z",
            }).counterparty,
        ).toMatchObject({ name: "CITI CREDIT CARDS", suffix: "2666" });
    });
});

describe("the flattened OCBC transfer request is not held", () => {
    it("resolves the destination and books the outgoing leg", async () => {
        const { phase2 } = await orchestrate(OCBC_TRANSFER_REQUEST_FLAT, {
            senderBank: "OCBC",
            receivedAt: "2026-10-01T13:14:29.000Z",
        });

        expect(phase2).toBeTruthy();
        expect(phase2._hold_unresolved_transfer).toBeFalsy();
        expect(phase2.amount_cents).toBe(-100000);
        // The destination is the holder's own DBS Account, so this is a
        // transfer between own accounts: booked on the funding OCBC 360 side
        // against the destination's transfer payee, with no category. Before
        // the fix the DBS leg (printed "667222" by OCBC, stored as "7222")
        // could not be matched, and the row was held and notified instead.
        expect(phase2.account_id).toBe(OCBC_360);
        expect(phase2.payee_id).toBe("p-dbs-account");
        expect(phase2._is_transfer).toBe(true);
        expect(phase2.category_id).toBeNull();
    });
});

// ── 3. Only a COMPLETED scheduled transfer is a movement ─────────

describe("Ryt scheduled transfer completion", () => {
    it("does NOT parse a failed scheduled transfer as a movement", () => {
        // Same opening sentence, non-completion status. Booking this would
        // post a debit for money that never left.
        const failed = RYT_SCHEDULED_TRANSFER.replace(
            "was successfully completed",
            "was unsuccessful",
        );
        expect(
            parseBankMovement(failed, {
                senderBank: "Ryt",
                receivedAt: "2026-10-01T02:02:00.000Z",
            }),
        ).toBeNull();
    });

    it("does NOT parse a pending scheduled transfer as a movement", () => {
        const pending = RYT_SCHEDULED_TRANSFER.replace(
            "was successfully completed",
            "is pending approval",
        );
        expect(
            parseBankMovement(pending, {
                senderBank: "Ryt",
                receivedAt: "2026-10-01T02:02:00.000Z",
            }),
        ).toBeNull();
    });

    it("does NOT parse a reminder with no completion clause", () => {
        const reminder = RYT_SCHEDULED_TRANSFER.replace(
            "was successfully completed",
            "will be processed on that date",
        );
        expect(
            parseBankMovement(reminder, {
                senderBank: "Ryt",
                receivedAt: "2026-10-01T02:02:00.000Z",
            }),
        ).toBeNull();
    });
});

// ── 4. A card-product destination with no alias must fail closed ──

describe("a card-product destination that cannot be linked is held, not spent", () => {
    it("holds uid 1025 when memory has no Citi Reward alias", async () => {
        // The production alias is what makes this row bookable. Without it the
        // destination is an unlinkable card product, so the row must hold —
        // falling through here posts the repayment as spend.
        const { phase2, calls } = await orchestrate(DBS_BILLPAY_TO_CITI, {
            senderBank: "DBS",
            receivedAt: "2026-10-01T13:12:59.000Z",
            facts: facts.filter((f) => !/CITI CREDIT CARDS/i.test(f.text)),
        });

        expect(phase2).toBeTruthy();
        expect(phase2._hold_unresolved_transfer).toBe(true);
        expect(phase2._hold_cause).toBe("destination_unresolved");
        // The destination-refusal family renders the DESTINATION story, not the
        // person one or the source-ambiguous one — one cause per held row.
        const text = calls.find((c) => c.name === "notify_user")?.args?.message || "";
        expect(text).toMatch(/transfer destination/i);
        expect(text).not.toMatch(/which of your accounts it left/);
        expect(text).not.toMatch(/could not verify/);
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
    });
});

// ── 5. A scheduled transfer must not become an external expense ───

const RYT_SCHEDULED_TRANSFER =
    "Hi Darren, Your scheduled transfer of RM908.25 to ACCOUNT HOLDER on 1/10/2026, " +
    "10:02 AM (GMT+8) was successfully completed. For more details, just log into the " +
    "Ryt Bank App and head to Scheduled Transfers.";

describe("a Ryt scheduled transfer is never booked as an external expense", () => {
    it("holds instead of inserting when the destination is the holder", async () => {
        // Production shape: the alert names the holder, and the tracker holds a
        // person-to-person movement whose other leg it cannot verify. The
        // placeholder name needs the matching legal-name fact that production
        // carries, otherwise it stops being an own identity at all.
        const { phase2, calls } = await orchestrate(RYT_SCHEDULED_TRANSFER, {
            senderBank: "Ryt",
            receivedAt: "2026-10-01T02:02:00.000Z",
            accounts: [...accounts, { id: "ryt-main", name: "Ryt Main Account", closed: false }],
            facts: [
                ...facts,
                { text: "Legal name: ACCOUNT HOLDER -> ABCD (statement password)", score: 1 },
            ],
        });

        expect(phase2).toBeTruthy();
        expect(phase2._hold_unresolved_transfer).toBe(true);
        expect(phase2._hold_cause).toBe("person_identity_unverified");
        expect(phase2.category_id).toBeNull();
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
    });
});
