/**
 * Reproductions for the transfer holds and the duplicate of 2026-10-11/12.
 * Bodies are the production shapes with the holder's name, account suffixes
 * and references replaced; amounts, labels and layout are kept.
 *
 *   R1  SC FAST advice whose "Payee Bank:" is filled in ("DBS BANK LIMITED")
 *       is held although the destination suffix has a fact.
 *   R2  OCBC deposit "Reference: from <name>" reads the sender as the whole
 *       rest of the flattened email.
 *   R3  Trust PayNow to the holder's own masked name is held as a stranger;
 *       it now pairs with the credit leg from whichever side arrives second.
 *   R4  reserve_transfer books a second pair when Actual already holds the
 *       same transfer, linked, outside the journal.
 */
import { describe, expect, it, vi } from "vitest";
import { parseBankMovement } from "../src/bank-movement.js";
import { Config } from "../src/config.js";
import { ToolRegistry } from "../src/tools.js";
import { DedupJournal } from "../src/dedup.js";

const SC_BONUS = "acct-sc-bonus";
const DBS_ACCOUNT = "acct-dbs";
const OCBC_360 = "acct-ocbc-360";
const TRUST_BANK = "acct-trust";

const accounts = [
    { id: SC_BONUS, name: "SC Bonus Saver", closed: false },
    { id: DBS_ACCOUNT, name: "DBS Account", closed: false },
    { id: "acct-posb", name: "POSB Cashback", closed: false },
    { id: "acct-dbs-alt", name: "DBS Altitude Card", closed: false },
    { id: OCBC_360, name: "OCBC 360", closed: false },
    { id: "acct-ocbc-90n", name: "OCBC 90N", closed: false },
    { id: TRUST_BANK, name: "Trust Bank", closed: false },
];
const payees = accounts.map((a) => ({ id: `p-${a.id}`, name: a.name, transfer_acct: a.id }))
    .concat([{ id: "p-misc", name: "Misc", transfer_acct: null }]);
const facts = [
    "Account ending 1111 belongs to SC Bonus Saver",
    "Account ending 2222 belongs to DBS Account",
    "Account ending 333001 belongs to OCBC 360",
    "Account ending 4440 belongs to Trust Bank",
    "Trust alert recipient maps to Trust Bank account",
].map((text) => ({ text, score: 1 }));

const scAdvice = (payeeBank) => `Dear Valued Customer, Your FAST transaction has been successful, transaction details below: Transaction reference: SG-TEST-0001 From account: ******1111 To account: ******2222 Amount: 1,557.24 Currency: SGD Transaction due date: 01/10/2026 21:14:09 Transaction type: FAST Payee Name: Jane DBS Payee Bank: ${payeeBank} Transaction message: Please call Client Contact Centre for enquiries. Thank you for using Standard Chartered Online Banking. Yours Sincerely, Transaction Banking Consumer Banking`;

// extractEmailContent() flattens whitespace, so this is the form the parser gets.
const OCBC_DEPOSIT_FLAT = "Dear Valued Customer, A deposit was made in your account. Here are the details: Time of deposit: 12:41 AM Amount: SGD 6,729.67 Account that money was deposited in: (-333001) Reference: from JANE TAN For assistance at any time, please call us at 1800-363 3333 (or +65 6363 3333 from overseas). Thank you for banking with us.";

const TRUST_PAYNOW_SELF = "Didn't do this? Please contact us via your Trust App. Your PayNow transfer of SGD 6,729.67 from A/C ending 4440 to JAXX TAX on 12 Oct 2026 00:41 SGT is successful. For assistance, contact us via Trust App.";

async function orchestrate(body, { senderBank, receivedAt, llm = null, findLink = null }) {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
        executeTool: vi.fn(async (name, args) => {
            calls.push({ name, args });
            if (name === "fetch_context") return { accounts, categories: [], payees };
            if (name === "search_memory") return { results: facts };
            if (name === "list_facts") return { facts: facts.map((f) => f.text) };
            if (name === "check_duplicate" || name === "check_schedule_collision") return false;
            if (name === "find_link_candidate") return findLink ? findLink(args) : { candidate: null, matches: 0 };
            if (name === "reserve_transfer") return { status: "reserved", entry: { id: 1 } };
            if (name === "insert_transaction")
                return { id: "tx-1", account: args.account_id, amount: args.amount_cents, cleared: false };
            return true;
        }),
        getPhase1ToolSchemas: vi.fn(() => []),
        setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
        primaryCurrency: "SGD", secondaryCurrency: "MYR",
        primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
        llmProvider: "deepseek", llmApiKey: "sk-test", deepseekApiKey: "sk-test",
    }, tools);
    orch._llm.chat = vi.fn(async () => (llm ? { choices: [{ message: { content: JSON.stringify(llm) } }] } : undefined));
    const phase1 = await orch._runPhase1(body, { senderBank, receivedAt });
    const phase2 = phase1 ? await orch._resolvePhase2(phase1) : null;
    return { phase1, phase2, calls };
}

describe("R1 SC FAST advice with a filled-in Payee Bank", () => {
    it("control: an empty Payee Bank resolves the destination by its suffix fact", async () => {
        const { phase2 } = await orchestrate(scAdvice(""), { senderBank: "SC", receivedAt: "2026-10-01T13:14:09.000Z" });
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(phase2._transfer?.destination_account_id).toBe(DBS_ACCOUNT);
    });

    it("books the same transfer when SC names the bank as 'DBS BANK LIMITED'", async () => {
        const { phase2 } = await orchestrate(scAdvice("DBS BANK LIMITED"), { senderBank: "SC", receivedAt: "2026-10-01T13:14:09.000Z" });
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(phase2._transfer?.destination_account_id).toBe(DBS_ACCOUNT);
    });

    it("normalises the payee bank to the tracker's bank key", () => {
        const m = parseBankMovement(scAdvice("OVERSEA-CHINESE BANKING CORPN"), { senderBank: "SC", receivedAt: "2026-10-01T13:14:09.000Z" });
        expect(m.counterparty.bank).toBe("OCBC");
    });
});

describe("R2 OCBC deposit sender read from a flattened body", () => {
    it("ends the sender at the end of the Reference line", () => {
        const m = parseBankMovement(OCBC_DEPOSIT_FLAT, { senderBank: "OCBC", receivedAt: "2026-10-11T16:41:06.000Z" });
        expect(m.counterparty.name).toBe("JANE TAN");
    });
});

describe("R3 Trust PayNow to the holder's own masked name", () => {
    const opts = { senderBank: "Trust", receivedAt: "2026-10-11T16:41:06.000Z" };

    it("is parsed deterministically and flagged as a masked payee", () => {
        const m = parseBankMovement(TRUST_PAYNOW_SELF, opts);
        expect(m.masked_payee).toBe(true);
        expect(m.direction).toBe("outgoing");
        expect(m.own_account.suffix).toBe("4440");
    });

    it("leaves an unmasked Trust PayNow to the LLM extractor", () => {
        const plain = TRUST_PAYNOW_SELF.replace("JAXX TAX", "Acme Cafe");
        expect(parseBankMovement(plain, opts)).toBeNull();
    });

    it("credit already booked: becomes a transfer to the account holding the credit", async () => {
        const { phase2 } = await orchestrate(TRUST_PAYNOW_SELF, {
            ...opts,
            findLink: ({ account_id }) => account_id === OCBC_360
                ? { candidate: { id: "credit-row", account_id }, matches: 1 }
                : { candidate: null, matches: 0 },
        });
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(phase2._transfer?.source_account_id).toBe(TRUST_BANK);
        expect(phase2._transfer?.destination_account_id).toBe(OCBC_360);
    });

    it("credit not booked yet: books a tagged Misc debit instead of holding", async () => {
        const { phase2 } = await orchestrate(TRUST_PAYNOW_SELF, opts);
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(phase2.payee_name).toBe("Misc");
        expect(phase2.account_id).toBe(TRUST_BANK);
        expect(phase2.amount_cents).toBe(-672967);
        expect(phase2.notes).toContain("Possible own transfer");
    });

    it("holds when two accounts could hold the credit", async () => {
        const { phase2 } = await orchestrate(TRUST_PAYNOW_SELF, {
            ...opts,
            findLink: ({ account_id }) => [OCBC_360, DBS_ACCOUNT].includes(account_id)
                ? { candidate: { id: `row-${account_id}`, account_id }, matches: 1 }
                : { candidate: null, matches: 0 },
        });
        expect(phase2._hold_unresolved_transfer).toBe(true);
    });

    it("holds when an account cannot be read", async () => {
        const { phase2 } = await orchestrate(TRUST_PAYNOW_SELF, {
            ...opts,
            findLink: () => ({ candidate: null, matches: null }),
        });
        expect(phase2._hold_unresolved_transfer).toBe(true);
    });

    it("the credit booked second links to the waiting debit", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "find_link_candidate")
                    return args.account_id === TRUST_BANK
                        ? { candidate: { id: "debit-row", account_id: TRUST_BANK }, matches: 1 }
                        : { candidate: null, matches: 0 };
                return { ok: true };
            }),
        };
        const orch = new AgentOrchestrator({ primaryCurrency: "SGD", secondaryCurrency: "MYR", primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr", llmProvider: "deepseek", llmApiKey: "sk-test", deepseekApiKey: "sk-test" }, tools);
        const linked = await orch._pairWaitingDebit({
            llmOutput: { budget_id: "budget-sgd", date: "2026-10-12", amount_cents: 672967, _pair_other_accounts: [TRUST_BANK, DBS_ACCOUNT] },
            creditRowId: "credit-row",
        });
        expect(linked).toBe(true);
        const link = calls.find((c) => c.name === "link_transfer_pair");
        expect(link.args).toMatchObject({ outgoing_id: "debit-row", incoming_id: "credit-row" });
        expect(calls.find((c) => c.name === "find_link_candidate").args.notes_contains).toContain("Possible own transfer");
    });

    it("an untagged debit is never linked (find_link_candidate honours notes_contains)", async () => {
        const registry = new ToolRegistry(new Config({
            DEEPSEEK_API_KEY: "sk-test", ACTUAL_BUDGET_URL: "http://test:5006",
            ACTUAL_BUDGET_PASSWORD: "pw", ACTUAL_PRIMARY_BUDGET_FILE: "test-budget", DEDUP_DB_PATH: ":memory:",
        }));
        registry._dedup = new DedupJournal(":memory:");
        const row = (notes) => ({ id: "d1", account: TRUST_BANK, amount: -672967, payee: "p-misc", cleared: false, date: "2026-10-12", notes });
        let rows = [row("")];
        global.fetch = async (url) => ({ ok: true, json: async () => (String(url).includes("/payees") ? payees : rows) });
        const ask = () => registry.executeTool("find_link_candidate", {
            budget_id: "budget-sgd", account_id: TRUST_BANK, amount_cents: 672967, on_date: "2026-10-12",
            notes_contains: "Possible own transfer",
        });
        expect((await ask()).candidate).toBeNull();
        rows = [row("Possible own transfer (awaiting credit)")];
        expect((await ask()).candidate?.id).toBe("d1");
    });
});

describe("R4 reserve_transfer with the pair already linked in Actual", () => {
    it("does not report 'reserved' when the same transfer is already booked outside the journal", async () => {
        const registry = new ToolRegistry(new Config({
            DEEPSEEK_API_KEY: "sk-test", ACTUAL_BUDGET_URL: "http://test:5006",
            ACTUAL_BUDGET_PASSWORD: "pw", ACTUAL_PRIMARY_BUDGET_FILE: "test-budget", DEDUP_DB_PATH: ":memory:",
        }));
        registry._dedup = new DedupJournal(":memory:");
        global.fetch = async (url) => {
            if (String(url).includes("/payees")) return { ok: true, json: async () => payees };
            const u = String(url);
            // Actual already has the linked pair: -3600 on SC, +3600 on OCBC.
            const rows = u.includes(SC_BONUS)
                ? [{ id: "sc-leg", account: SC_BONUS, amount: -360000, payee: `p-${OCBC_360}`, transfer_id: "ocbc-leg", cleared: false, date: "2026-10-10" }]
                : [{ id: "ocbc-leg", account: OCBC_360, amount: 360000, payee: `p-${SC_BONUS}`, transfer_id: "sc-leg", cleared: false, date: "2026-10-10" }];
            return { ok: true, json: async () => rows };
        };
        const reservation = await registry.executeTool("reserve_transfer", {
            budget_id: "budget-sgd", source_account_id: SC_BONUS, destination_account_id: OCBC_360,
            currency: "SGD", amount_cents: 360000, occurred_at: "2026-10-09T17:32:00.000Z", payee_id: `p-${OCBC_360}`,
        });
        expect(reservation.status).not.toBe("reserved");
    });
});
