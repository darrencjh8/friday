/**
 * Redacted from real alerts that failed in production. The bodies keep the flat
 * shape the HTML-to-text step produces: the "To:" value runs on into the footer,
 * and that footer names the sending bank.
 */
import { describe, it, expect, vi } from "vitest";
import { parseBankMovement } from "../src/bank-movement.js";
import { AgentOrchestrator } from "../src/orchestrator.js";

const billPayment = (to) =>
    "Transaction Ref: 17881904007442101381 Dear Customer, You’ve successfully made a bill payment. " +
    "Date and Time: 03 Nov 01:24 (SGT) Amount: SGD 12.34 From: Vista (A/C ending 1777) " +
    `To: ${to} If unauthorised, please call our DBS hotline. To view transaction details, please login to digibank.`;

const ACCOUNTS = [
    { id: "vista", name: "DBS Vista Card", closed: false },
    { id: "savings", name: "DBS Account", closed: false },
    { id: "ocbc-360", name: "OCBC 360", closed: false },
    { id: "uob-card", name: "UOB Demo Card", closed: false },
    { id: "citi-card", name: "Citi Points", closed: false },
];
const PAYEES = [
    { id: "plain-citi", name: "Citi Points", transfer_acct: null },
    { id: "to-citi", name: "Citi Points", transfer_acct: "citi-card" },
    { id: "to-uob", name: "UOB Demo Card", transfer_acct: "uob-card" },
    { id: "to-savings", name: "DBS Account", transfer_acct: "savings" },
];
const FACTS = [
    "Card ending 1777 belongs to DBS Vista Card",
    "Card ending 2666 belongs to UOB Demo Card",
    "Card ending 3555 belongs to Citi Points",
    "Account ending 7788 belongs to DBS Account",
    "Account ending 112233 belongs to OCBC 360",
];

function makeOrchestrator() {
    const tools = {
        executeTool: vi.fn(async (name, args) => {
            if (name === "fetch_context") return { accounts: ACCOUNTS, categories: [], payees: PAYEES };
            // Mirrors production recall: the query must appear in the fact verbatim.
            if (name === "search_memory") {
                return { results: FACTS.filter((text) => text.includes(args.query)).map((text) => ({ text, score: 1 })) };
            }
            if (name === "list_facts") return { facts: FACTS };
            return true;
        }),
        getPhase1ToolSchemas: vi.fn(() => []),
        setEmailContext: vi.fn(),
    };
    const orchestrator = new AgentOrchestrator({
        primaryCurrency: "SGD", secondaryCurrency: "MYR",
        primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
        llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orchestrator._llm.chat = vi.fn();
    return orchestrator;
}

describe("bill payment alerts whose footer names the sending bank", () => {
    it.each([
        ["UOB CREDIT CARDS (Ref ending 2666)", "UOB"],
        ["CITI CREDIT CARDS (Ref ending 3555)", "Citi"],
        ["OCBC CREDIT CARDS (Ref ending 4444)", "OCBC"],
    ])("reads the destination bank of %s from the destination only", (to, bank) => {
        const movement = parseBankMovement(billPayment(to), {
            senderBank: "DBS", receivedAt: "2026-11-02T17:24:19Z",
        });
        expect(movement.counterparty.bank).toBe(bank);
    });

    it.each([
        ["UOB CREDIT CARDS (Ref ending 2666)", "uob-card", "to-uob"],
        ["CITI CREDIT CARDS (Ref ending 3555)", "citi-card", "to-citi"],
    ])("books %s as a transfer to the holder's own card", async (to, destination, payee) => {
        const output = await makeOrchestrator()._runPhase1(billPayment(to), {
            senderBank: "DBS", receivedAt: "2026-11-02T17:24:19Z",
        });
        expect(output).toMatchObject({ account_id: "vista", payee_id: payee, _is_transfer: true });
        expect(output._transfer.destination_account_id).toBe(destination);
    });
});

describe("a destination suffix longer than the remembered one", () => {
    it("resolves an OCBC advice to the account a shorter suffix fact names", async () => {
        const advice =
            "We have received your request to make the following transfer: " +
            "Date of Transfer : 03 Nov 2026 Time of Transfer : 01.24 AM SGT Amount : SGD 25.50 " +
            "From your account : 360 Account (-112233) " +
            "To account : Demo Holder DBS (-447788) at DBS BANK LTD Reference number : 2609010016084129 ";
        const output = await makeOrchestrator()._runPhase1(advice, {
            senderBank: "OCBC", receivedAt: "2026-11-02T17:24:50Z",
        });
        expect(output).toMatchObject({ account_id: "ocbc-360", payee_id: "to-savings", _is_transfer: true });
        expect(output._hold_unresolved_transfer).toBeUndefined();
    });
});

describe("a card repayment reached by payee name", () => {
    it("uses the transfer payee when the name has both a plain and a transfer payee", async () => {
        const output = await makeOrchestrator()._resolvePhase2({
            merchant: "Citi Points", amount_cents: -1234, date: "2026-11-03", currency: "SGD",
            account_id: "vista", account_name: "DBS Vista Card", action: "insert",
            payee_name: "Citi Points", category_id: null, budget_id: "budget-sgd",
            raw_description: "Bill payment", _card_repayment: true,
        });
        expect(output).toMatchObject({ payee_id: "to-citi", _is_transfer: true });
    });
});
