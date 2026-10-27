/**
 * Step 2 Tier 1a takes a category fact keyed on the merchant itself. A
 * payee-categories row ("App maps to Fun Money category") is keyed on a payee:
 * a descriptor that merely contains the payee's word ("KOPITIAM FP APP") is not
 * that payee. Such a row is left to Tier 1, which reads the category of the
 * payee the merchant actually resolved to, and Jev answers when that payee has
 * none. A merchant override or a hand-written routing rule still wins.
 *
 * Fixtures are synthetic: no real merchant, person or account data.
 */
import { describe, it, expect, vi } from "vitest";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { Config } from "../src/config.js";

const CONTEXT = {
    accounts: [{ id: "acc-1", name: "Card One", closed: false }],
    categories: [
        { id: "cat-food", name: "Food" },
        { id: "cat-fun", name: "Fun Money" },
        { id: "cat-travel", name: "Travel" },
        { id: "cat-fam", name: "Family Support" },
    ],
    payees: [{ id: "p-food", name: "Food" }, { id: "p-shop", name: "Shopping" }],
};

const PAYEE_ROW = (text) => ({ text, score: 1, payeeCategory: true });
const FACT = (text) => ({ text, score: 1 });

function phase1(merchant, over = {}) {
    return {
        merchant,
        amount_cents: -1307,
        date: "2026-10-19",
        currency: "SGD",
        account_id: "acc-1",
        account_name: "Card One",
        budget_id: "budget-sgd",
        action: "insert",
        payee_name: "",
        category_id: "",
        raw_description: `SGD 13.07 at ${merchant}`,
        _evidence: { text: `SGD 13.07 at ${merchant}`, subject: "Alert", sender: "alerts@bank.example" },
        ...over,
    };
}

/** Memory search matches on words, as the real store does. */
const words = (q) => String(q).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

function orchestrator({ payee, facts, jevCategory = { category_id: "cat-travel", category_name: "Travel", source: "jev" } }) {
    const calls = [];
    const tools = {
        setEmailContext: vi.fn(),
        getToolSchemas: vi.fn(() => []),
        executeTool: vi.fn(async (name, args) => {
            calls.push({ name, args });
            if (name === "search_memory")
                return { results: facts.filter((f) => words(args.query).some((w) => f.text.toLowerCase().includes(w))) };
            if (name === "resolve_merchant") return { payee, source: "jev", search: null };
            if (name === "fetch_context") return CONTEXT;
            if (name === "classify_category") return jevCategory;
            return { results: [] };
        }),
    };
    const orch = new AgentOrchestrator(
        new Config({ DEEPSEEK_API_KEY: "sk-test", DEDUP_DB_PATH: ":memory:", STATEMENT_DB_PATH: ":memory:" }),
        tools,
    );
    orch._chat = vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ category_id: null }) } }] });
    return { orch, calls };
}

const jevAsked = (calls) => calls.some((c) => c.name === "classify_category");

describe("Tier 1a skips a payee's category row", () => {
    it("an APP descriptor gets its own payee's category, not the App payee's", async () => {
        const { orch, calls } = orchestrator({
            payee: "Food",
            facts: [PAYEE_ROW("App maps to Fun Money category"), PAYEE_ROW("Food maps to Food category")],
        });
        const out = await orch._resolvePhase2(phase1("ZZTEST FP APP PAYMEN Singapore SGP"));
        expect(out).toMatchObject({ payee_name: "Food", category_id: "cat-food" });
        expect(jevAsked(calls)).toBe(false);
    });

    it("a WALLET descriptor whose payee has no category falls back to Jev", async () => {
        const { orch, calls } = orchestrator({
            payee: "Shopping",
            facts: [PAYEE_ROW("Wallet maps to Fun Money category")],
        });
        const out = await orch._resolvePhase2(phase1("ZZTEST WALLET TOPUP SGP"));
        expect(out).toMatchObject({ payee_name: "Shopping", category_id: "cat-travel", category_source: "jev" });
        expect(jevAsked(calls)).toBe(true);
    });

    it("a merchant's own category override still wins", async () => {
        const { orch } = orchestrator({
            payee: "Food",
            facts: [FACT("ZZTEST AMAZE TOUR maps to Travel category"), PAYEE_ROW("Food maps to Food category")],
        });
        const out = await orch._resolvePhase2(phase1("ZZTEST AMAZE TOUR"));
        expect(out).toMatchObject({ category_id: "cat-travel" });
    });

    it("a person's category, from their own row, still wins", async () => {
        const { orch } = orchestrator({
            payee: "Food",
            facts: [FACT("PERSON ONE maps to Family Support category"), PAYEE_ROW("Food maps to Food category")],
        });
        const out = await orch._resolvePhase2(phase1("PAYNOW PERSON ONE"));
        expect(out).toMatchObject({ category_id: "cat-fam" });
    });

    it("a hand-written routing rule with no payee line still applies", async () => {
        const { orch } = orchestrator({
            payee: "Food",
            facts: [FACT("Zzresort maps to Travel category"), PAYEE_ROW("Food maps to Food category")],
        });
        const out = await orch._resolvePhase2(phase1("ZZRESORT CAFE SGP"));
        expect(out).toMatchObject({ category_id: "cat-travel" });
    });
});
