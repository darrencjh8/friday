/**
 * resolve_merchant and classify_category with web search. Memory always wins;
 * the search runs only on a memory miss, only with the email as evidence, a
 * Jev key and a Firecrawl key. All requests go to a URL-routed fetch stub.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("mailparser", () => ({ simpleParser: vi.fn() }));
vi.mock("../src/dedup.js", () => ({
    DedupJournal: vi.fn(function () {
        this.record = vi.fn();
        this.checkDuplicate = vi.fn(() => false);
        this.checkExact = vi.fn(() => false);
        this.close = vi.fn();
    }),
}));

import { ToolRegistry } from "../src/tools.js";
import { NONE_OPTION } from "../src/jev.js";

afterEach(() => vi.unstubAllGlobals());

const EVIDENCE = { text: "SGD 13.07 at ACME CHICKEN@T9", subject: "Alert", sender: "alerts@bank.example" };
const PAYEES = [{ id: "p-misc", name: "Misc" }, { id: "p-food", name: "Food" }, { id: "p-gro", name: "Groceries" }];
const CATEGORIES = [{ id: "c-food", name: "Food" }, { id: "c-ins", name: "Insurance" }];

function memory(facts = []) {
    return {
        search: vi.fn(async (q) => facts.filter((f) => f.toLowerCase().includes(q.toLowerCase())).map((text) => ({ text, score: 1 }))),
        add: vi.fn(),
    };
}

/** Routes Actual, Firecrawl and Jev requests; records which were made. */
function routedFetch({ payeeChoice = "Food", categoryChoice = "Food", web = [{ title: "Acme Chicken", description: "chicken rice restaurant", url: "https://acme.example/" }] } = {}) {
    const seen = { firecrawl: 0, jev: [], actual: [] };
    const fn = vi.fn(async (url, init = {}) => {
        const json = (body) => ({ ok: true, status: 200, json: async () => body });
        if (String(url).startsWith("https://api.firecrawl.dev/")) {
            seen.firecrawl += 1;
            return json({ success: true, data: { web } });
        }
        if (String(url).includes("systemone")) {
            const body = JSON.parse(init.body);
            seen.jev.push(body);
            if (body.questions.payee)
                return json({ answers: { payee: { choice: payeeChoice, confidence: 0.93, probabilities: { [payeeChoice]: 0.9, [NONE_OPTION]: 0.1 } } } });
            if (body.questions.category)
                return json({ answers: { category: { choice: categoryChoice, confidence: 0.91, probabilities: { [categoryChoice]: 0.88, [NONE_OPTION]: 0.12 } } } });
            return json({ answers: { evidence: { noul: 0.9 } } });
        }
        seen.actual.push(`${init.method || "GET"} ${url}`);
        if (String(url).includes("/payees")) return json(PAYEES);
        if (String(url).includes("/categories")) return json(CATEGORIES);
        return json([]);
    });
    vi.stubGlobal("fetch", fn);
    return seen;
}

function registry(over = {}, facts = []) {
    return new ToolRegistry(
        { dedupDbPath: ":memory:", jevApiKey: "jev-k", firecrawlApiKey: "fc-k", ...over },
        memory(facts),
    );
}

const ARGS = { merchant: "ACME CHICKEN@T9", budget_id: "b1", evidence: EVIDENCE, direction: "outgoing", amount_cents: -1307, currency: "SGD" };

describe("resolve_merchant with web search", () => {
    it("on a memory miss, searches and lets Jev pick an existing payee", async () => {
        const seen = routedFetch();
        const out = await registry().executeTool("resolve_merchant", ARGS);
        expect(out).toMatchObject({ payee: "Food", source: "jev" });
        expect(out.search.results[0]).toMatchObject({ host: "acme.example" });
        expect(seen.firecrawl).toBe(1);
        expect(seen.jev[0].state).toContain("chicken rice restaurant");
    });

    it("memory wins: no search and no Jev call", async () => {
        const seen = routedFetch();
        const out = await registry({}, ["ACME CHICKEN@T9 merchant maps to Groceries payee"]).executeTool("resolve_merchant", ARGS);
        expect(out).toEqual({ payee: "Groceries", source: "memory" });
        expect(seen.firecrawl).toBe(0);
        expect(seen.jev).toHaveLength(0);
    });

    it("needs no switch beyond the keys: searches by default", async () => {
        const seen = routedFetch();
        await registry().executeTool("resolve_merchant", ARGS);
        expect(seen.firecrawl).toBe(1);
        expect(seen.jev[0].state).toContain("<search>");
    });

    it("without a Firecrawl key keeps today's email-only Jev call", async () => {
        const seen = routedFetch();
        await registry({ firecrawlApiKey: "" }).executeTool("resolve_merchant", ARGS);
        expect(seen.firecrawl).toBe(0);
        expect(seen.jev[0].state).not.toContain("<search>");
    });

    it("also searches inside a dry run, which writes nothing", async () => {
        const seen = routedFetch();
        const reg = registry();
        const { calls } = await reg.dryRun(() => reg.executeTool("resolve_merchant", ARGS));
        expect(seen.firecrawl).toBe(1);
        expect(calls).toHaveLength(0);
    });

    it("never searches without the email as evidence, a Jev key or a Firecrawl key", async () => {
        const seen = routedFetch();
        const { evidence: _e, ...noEvidence } = ARGS;
        expect(await registry().executeTool("resolve_merchant", noEvidence)).toEqual({ payee: "Misc", source: "fallback" });
        await registry({ jevApiKey: "" }).executeTool("resolve_merchant", ARGS);
        expect(seen.firecrawl).toBe(0);
        await registry({ firecrawlApiKey: "" }).executeTool("resolve_merchant", ARGS);
        expect(seen.firecrawl).toBe(0);
    });

    it("a failed search still lets the email-only Jev call decide", async () => {
        const seen = routedFetch({ web: null });
        const out = await registry().executeTool("resolve_merchant", ARGS);
        expect(seen.firecrawl).toBe(1);
        expect(out.payee).toBe("Food");
        expect(seen.jev[0].state).not.toContain("<search>");
    });

    it("never creates a payee or learns anything", async () => {
        const seen = routedFetch({ payeeChoice: "Acme Chicken" });
        const reg = registry();
        const out = await reg.executeTool("resolve_merchant", ARGS);
        expect(out.payee).toBe("Misc");
        expect(reg._memory.add).not.toHaveBeenCalled();
        // Only reads reach Actual: no payee is created.
        expect(seen.actual.length).toBeGreaterThan(0);
        expect(seen.actual.every((u) => u.startsWith("GET "))).toBe(true);
    });
});

describe("classify_category", () => {
    const CAT_ARGS = { ...ARGS, payee: "Food", search: { query: "q", results: [{ title: "Acme Chicken", description: "chicken rice", host: "acme.example" }] } };

    it("picks a live category with Jev", async () => {
        routedFetch();
        const out = await registry().executeTool("classify_category", CAT_ARGS);
        expect(out).toMatchObject({ category_id: "c-food", category_name: "Food", source: "jev" });
    });

    it("is off without a Jev key", async () => {
        const seen = routedFetch();
        const out = await registry({ jevApiKey: "" }).executeTool("classify_category", CAT_ARGS);
        expect(out.category_id).toBeNull();
        expect(seen.jev).toHaveLength(0);
    });

    it("is not reachable from the tracker's HTTP and MCP tool list", () => {
        const names = registry().getToolSchemas().map((t) => t.function.name);
        expect(names).not.toContain("classify_category");
    });

    it("runs for real inside a dry run, since it writes nothing", async () => {
        routedFetch();
        const reg = registry();
        const { result, calls } = await reg.dryRun(() => reg.executeTool("classify_category", CAT_ARGS));
        expect(result.category_id).toBe("c-food");
        expect(calls).toHaveLength(0);
    });
});

describe("resolve_merchant for a person transaction", () => {
    const PERSON = { ...ARGS, merchant: "ACME PERSON", direction: "incoming", amount_cents: 50000 };

    it("never searches the web for a person, but Jev still reads the email", async () => {
        const seen = routedFetch();
        const out = await registry().executeTool("resolve_merchant", { ...PERSON, no_search: true });
        expect(seen.firecrawl).toBe(0);
        expect(seen.jev.length).toBeGreaterThan(0);
        expect(out).toMatchObject({ payee: "Food", source: "jev" });
        expect(out.search).toBeUndefined();
    });

    it("skips a plain name fact when told memory was already decided", async () => {
        const seen = routedFetch();
        const out = await registry({}, ["ACME PERSON maps to Groceries payee"]).executeTool("resolve_merchant", {
            ...PERSON,
            no_search: true,
            no_memory: true,
        });
        expect(out).toMatchObject({ payee: "Food", source: "jev" });
        expect(seen.firecrawl).toBe(0);
    });
});
