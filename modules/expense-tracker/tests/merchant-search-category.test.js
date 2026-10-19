/**
 * Phase 2 category order for a merchant memory did not know: memory first
 * (keyed on the payee Jev picked), then Jev's category pick using the same
 * search results, then the existing LLM picker. A Jev category is never
 * learned and never applied to a transfer.
 */
import { describe, it, expect, vi } from "vitest";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { Config } from "../src/config.js";

const SEARCH = { query: "ACME CHICKEN Singapore", results: [{ title: "Acme Chicken", description: "chicken rice", host: "acme.example" }] };
const CONTEXT = {
    accounts: [{ id: "acc-1", name: "Card One", closed: false }],
    categories: [{ id: "cat-food", name: "Food" }, { id: "cat-ins", name: "Insurance" }],
    payees: [{ id: "p-food", name: "Food" }],
};

function phase1(over = {}) {
    return {
        merchant: "ACME CHICKEN@T9",
        amount_cents: -1307,
        date: "2026-10-19",
        currency: "SGD",
        account_id: "acc-1",
        account_name: "Card One",
        budget_id: "budget-sgd",
        action: "insert",
        payee_name: "",
        category_id: "",
        raw_description: "SGD 13.07 at ACME CHICKEN@T9",
        _evidence: { text: "SGD 13.07 at ACME CHICKEN@T9", subject: "Alert", sender: "alerts@bank.example" },
        ...over,
    };
}

function orchestrator({ resolve = { payee: "Food", source: "jev", search: SEARCH }, categoryFacts = [], jevCategory = { category_id: "cat-food", category_name: "Food", source: "jev" }, picker = null } = {}) {
    const calls = [];
    const tools = {
        setEmailContext: vi.fn(),
        getToolSchemas: vi.fn(() => []),
        executeTool: vi.fn(async (name, args) => {
            calls.push({ name, args });
            if (name === "search_memory")
                return { results: categoryFacts.filter((f) => f.toLowerCase().includes(String(args.query).toLowerCase())).map((text) => ({ text, score: 1 })) };
            if (name === "resolve_merchant") return resolve;
            if (name === "fetch_context") return CONTEXT;
            if (name === "classify_category") return jevCategory;
            return { results: [] };
        }),
    };
    const orch = new AgentOrchestrator(new Config({ DEEPSEEK_API_KEY: "sk-test", DEDUP_DB_PATH: ":memory:", STATEMENT_DB_PATH: ":memory:" }), tools);
    const chat = vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ category_id: picker }) } }] });
    orch._chat = chat;
    return { orch, calls, chat };
}

const named = (calls, name) => calls.filter((c) => c.name === name);

describe("category order after a Jev payee pick", () => {
    it("memory wins: a payee->category fact is used and Jev is not asked", async () => {
        const { orch, calls, chat } = orchestrator({ categoryFacts: ["Food maps to Food category"] });
        const out = await orch._resolvePhase2(phase1());
        expect(out).toMatchObject({ payee_name: "Food", category_id: "cat-food" });
        expect(named(calls, "classify_category")).toHaveLength(0);
        expect(chat).not.toHaveBeenCalled();
    });

    it("no memory category: Jev picks it from the same search results", async () => {
        const { orch, calls, chat } = orchestrator();
        const out = await orch._resolvePhase2(phase1());
        expect(out).toMatchObject({ payee_name: "Food", category_id: "cat-food", category_name: "Food", category_source: "jev" });
        const [call] = named(calls, "classify_category");
        expect(call.args).toMatchObject({ merchant: "ACME CHICKEN@T9", payee: "Food", budget_id: "budget-sgd", search: SEARCH, direction: "outgoing", currency: "SGD" });
        expect(call.args.evidence.text).toContain("ACME CHICKEN@T9");
        expect(chat).not.toHaveBeenCalled();
    });

    it("Jev declines: the existing LLM picker still runs for a real payee", async () => {
        const { orch, chat } = orchestrator({ jevCategory: { category_id: null, reason: "low_confidence" }, picker: "cat-ins" });
        const out = await orch._resolvePhase2(phase1());
        expect(chat).toHaveBeenCalledTimes(1);
        expect(out.category_id).toBe("cat-ins");
    });

    it("a Jev category id that is not live is ignored", async () => {
        const { orch } = orchestrator({ jevCategory: { category_id: "cat-gone", category_name: "Gone", source: "jev" } });
        const out = await orch._resolvePhase2(phase1());
        expect(out.category_id).not.toBe("cat-gone");
    });

    it("a Misc payee can still get a Jev category, but the LLM picker stays off", async () => {
        const { orch, calls, chat } = orchestrator({ resolve: { payee: "Misc", source: "fallback", search: SEARCH } });
        const out = await orch._resolvePhase2(phase1());
        expect(named(calls, "classify_category")[0].args).toMatchObject({ payee: "Misc", search: SEARCH });
        expect(out).toMatchObject({ payee_name: "Misc", category_id: "cat-food" });
        expect(chat).not.toHaveBeenCalled();
    });

    it("is never asked without the email as evidence", async () => {
        const { orch, calls } = orchestrator();
        await orch._resolvePhase2(phase1({ _evidence: undefined }));
        expect(named(calls, "classify_category")).toHaveLength(0);
    });

    it("never categorises a transfer", async () => {
        const { orch, calls } = orchestrator();
        await orch._resolvePhase2(phase1({ _is_transfer: true }));
        expect(named(calls, "classify_category")).toHaveLength(0);
    });

    it("never learns the Jev category", async () => {
        const { orch, calls } = orchestrator();
        await orch._resolvePhase2(phase1());
        expect(named(calls, "learn_fact")).toHaveLength(0);
    });
});
