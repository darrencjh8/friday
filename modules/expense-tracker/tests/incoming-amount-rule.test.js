/**
 * An incoming credit from a named sender books a remembered payee and category
 * only when the sender AND the amount match an owner rule. The same sender with
 * any other amount stays Misc, and a Misc row is never shown or booked with a
 * category. Fixtures are synthetic.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("@xenova/transformers", () => ({ pipeline: vi.fn(), env: {} }));

import { incomingRule } from "../src/orchestrator.js";

const DEPOSIT = (amount, reference = "from ACME PERSON") =>
    [
        "From: OCBC Alerts <alerts@ocbc.com>",
        "Subject: Deposit alert",
        "Date: Fri, 9 Oct 2026 06:50:30 +0800",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "A deposit was made in your account. Here are the details:",
        "",
        "Time of deposit: 6:50 AM",
        `Amount: SGD ${amount}`,
        "Account that money was deposited in: (-166600)",
        `Reference: ${reference}`,
        "",
        "For assistance at any time, please call our hotline.",
        "",
    ].join("\r\n");

const RULES = [
    "Account ending 166600 belongs to OCBC 111",
    "ACME PERSON maps to Rent payee",
    "Incoming SGD 900.00 from ACME PERSON maps to Rent payee",
    "Incoming SGD 900.00 from ACME PERSON maps to Rent category",
];

beforeAll(async () => {
    await import("../src/orchestrator.js");
}, 60000);

async function book(amount, { facts = RULES, reference } = {}) {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
        executeTool: vi.fn(async (name, args) => {
            calls.push({ name, args });
            if (name === "fetch_context")
                return {
                    accounts: [
                        { id: "ocbc-111", name: "OCBC 111", closed: false },
                        { id: "dbs-222", name: "DBS 222", closed: false },
                    ],
                    categories: [
                        { id: "cat-rent", name: "Rent" },
                        { id: "cat-food", name: "Food" },
                    ],
                    payees: [{ id: "p-rent", name: "Rent" }],
                };
            if (name === "list_facts") return { facts: facts.map((text) => ({ text })) };
            if (name === "search_memory")
                return { results: [{ text: "Account ending 166600 belongs to OCBC 111", score: 1 }] };
            if (name === "resolve_merchant") return { payee: null };
            if (name === "classify_category") return { category_id: "cat-food" };
            if (name === "notify_user") return true;
            if (name === "check_duplicate" || name === "check_schedule_collision") return false;
            if (name === "find_link_candidate") return { candidate: null, matches: 0 };
            if (name === "insert_transaction") return { id: "row-1" };
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
    orch._llm.chat = vi.fn().mockResolvedValue({ choices: [{ message: { content: "{}" } }] });
    await orch.processEmail(
        1200,
        Buffer.from(DEPOSIT(amount, reference)),
        null,
        "OCBC Alerts <alerts@ocbc.com>",
        "Deposit alert",
    );
    return calls;
}

const insert = (calls) => calls.find((c) => c.name === "insert_transaction")?.args;
const notice = (calls) => calls.filter((c) => c.name === "notify_user").map((c) => c.args.message).join("\n");

describe("incomingRule", () => {
    const facts = RULES.map((text) => ({ text }));

    it("matches the sender, currency and exact amount", () => {
        expect(incomingRule(facts, { name: "ACME PERSON", currency: "SGD", amountCents: 90000 }))
            .toEqual({ payee: "Rent", category: "Rent" });
        expect(incomingRule(facts, { name: "acme  person", currency: "sgd", amountCents: -90000 }))
            .toEqual({ payee: "Rent", category: "Rent" });
    });

    it("refuses another amount, currency or sender", () => {
        expect(incomingRule(facts, { name: "ACME PERSON", currency: "SGD", amountCents: 5000 })).toBeNull();
        expect(incomingRule(facts, { name: "ACME PERSON", currency: "MYR", amountCents: 90000 })).toBeNull();
        expect(incomingRule(facts, { name: "ACME", currency: "SGD", amountCents: 90000 })).toBeNull();
        expect(incomingRule([], { name: "ACME PERSON", currency: "SGD", amountCents: 90000 })).toBeNull();
    });

    it("never takes a rule from a plain name fact", () => {
        const plain = [{ text: "ACME PERSON maps to Rent payee" }];
        expect(incomingRule(plain, { name: "ACME PERSON", currency: "SGD", amountCents: 90000 })).toBeNull();
    });
});

describe("incoming credit keyed by sender and amount", () => {
    it("books the rule's payee and category for the remembered amount", async () => {
        const calls = await book("900.00");
        const row = insert(calls);
        expect(row.imported_description).toBe("Rent");
        expect(row.category_id).toBe("cat-rent");
        expect(notice(calls)).toContain("→ Rent");
    });

    it("does not pair a rule-booked credit with a debit as a transfer", async () => {
        const calls = await book("900.00");
        expect(calls.some((c) => c.name === "find_link_candidate")).toBe(false);
    });

    it("keeps any other amount from the same sender as Misc with no category", async () => {
        const calls = await book("50.00");
        const row = insert(calls);
        expect(row.imported_description).toBe("Misc");
        expect(row.category_id).toBeUndefined();
        expect(notice(calls)).not.toContain("→");
    });

    it("asks Jev for no category when the payee is Misc", async () => {
        const calls = await book("50.00");
        expect(calls.some((c) => c.name === "classify_category")).toBe(false);
    });
});
