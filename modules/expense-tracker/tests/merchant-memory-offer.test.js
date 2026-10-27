/**
 * Confirmable merchant memory, so a merchant the user confirmed is never
 * searched again. The offer names a key that matches the merchant's next
 * alerts, may carry the category Jev chose, never names Misc, is sent once per
 * key, and while it waits for an answer the merchant is not searched again.
 * All descriptors are synthetic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("mailparser", () => ({ simpleParser: vi.fn() }));
vi.mock("@xenova/transformers", () => ({ pipeline: vi.fn(), env: {} }));
vi.mock("../src/dedup.js", () => ({
    DedupJournal: vi.fn(function () {
        this.record = vi.fn();
        this.checkDuplicate = vi.fn(() => false);
        this.checkExact = vi.fn(() => false);
        this.close = vi.fn();
    }),
}));

import { ToolRegistry } from "../src/tools.js";
import { PendingLearning, descriptorOf } from "../src/learning.js";
import { merchantKey } from "../src/merchant-search.js";
import { factNamesMerchant } from "../src/memory.js";
import { LearningNotifier, createAnswerHandler, signAnswer } from "../src/learning-notify.js";
import { NONE_OPTION } from "../src/jev.js";

let dir;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "merchant-offer-"));
});
afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
});

const PAYEES = [{ id: "p-misc", name: "Misc" }, { id: "p-food", name: "Food" }, { id: "p-gro", name: "Groceries" }];
const CATEGORIES = [
    { id: "c-fast", name: "Fast Food" },
    { id: "c-food", name: "Food" },
    { id: "c-odd", name: "Food payee X" },
    { id: "c-inc", name: "Salary", is_income: true },
];
const EVIDENCE = { text: "SGD 13.07 at ACMECHICK@T3", subject: "Alert", sender: "alerts@bank.example" };

function routedFetch() {
    const seen = { firecrawl: 0, jev: 0 };
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url, init = {}) => {
            const json = (body) => ({ ok: true, status: 200, json: async () => body });
            const target = String(url);
            if (target.startsWith("https://api.firecrawl.dev/")) {
                seen.firecrawl += 1;
                return json({ success: true, data: { web: [{ title: "Acme Chick", description: "chicken rice", url: "https://acme.example/" }] } });
            }
            if (target.includes("systemone")) {
                seen.jev += 1;
                const body = JSON.parse(init.body);
                if (body.questions.payee)
                    return json({ answers: { payee: { choice: "Food", confidence: 0.93, probabilities: { Food: 0.9, [NONE_OPTION]: 0.1 } } } });
                return json({ answers: { evidence: { noul: 0.9 } } });
            }
            if (target.includes("/payees")) return json(PAYEES);
            if (target.includes("/categories")) return json(CATEGORIES);
            return json([]);
        }),
    );
    return seen;
}

function memoryStore(facts = []) {
    return {
        search: vi.fn(async (q) => facts.filter((f) => f.toLowerCase().includes(String(q).toLowerCase())).map((text) => ({ text, score: 1 }))),
        add: vi.fn(async () => ({ added: true, skipped: false, reason: "" })),
        listFacts: vi.fn(() => []),
    };
}

function registry({ memory = memoryStore(), config = {} } = {}) {
    return new ToolRegistry(
        {
            dedupDbPath: ":memory:",
            jevApiKey: "jev-k",
            firecrawlApiKey: "fc-k",
            pendingLearningPath: join(dir, "pending.json"),
            ...config,
        },
        memory,
    );
}

const propose = (reg, over = {}) =>
    reg.executeTool("propose_learning", { descriptor: "ACMECHICK@T3", payee: "Food", budget_id: "b1", ...over });

describe("merchantKey", () => {
    it.each([
        ["ACMECHICK@T3", "ACMECHICK"],
        ["ACME BREAD_301 SOMEWHERE", "ACME BREAD"],
        ["AMAZE* ACMEINSURE", "ACMEINSURE"],
        ["ACMEPAY 6598516743 SG", "ACMEPAY"],
        ["ACMEGREEN-B PTE. LT", "ACMEGREEN-B"],
        ["ACMESTORE (S) LTD- F", "ACMESTORE"],
        ["ACMEBURGER 930257", "ACMEBURGER"],
        ["360 SAVE BONUS", "360 SAVE BONUS"],
        // Never cut from the middle: the key must match its own descriptor.
        ["ACME 123456 POOLS", "ACME 123456 POOLS"],
        // A generic or short trimmed key falls back to the descriptor.
        ["ABC* FOOD", "ABC* FOOD"],
        ["KOPI@1", "KOPI@1"],
        ["ZE ZE_301", "ZE ZE_301"],
    ])("%s -> %s", (descriptor, key) => {
        expect(merchantKey(descriptor)).toBe(key);
        expect(factNamesMerchant(`${key} maps to Food payee`, descriptor)).toBe(true);
    });

    it("matches the same merchant at another branch", () => {
        expect(factNamesMerchant(`${merchantKey("ACMECHICK@T3")} maps to Food payee`, "ACMECHICK@T1")).toBe(true);
    });

    it("refuses ids, memory grammar and empty text", () => {
        for (const bad of ["0173500420188400", "x maps to Groceries payee", "", null, "@T3", "two\nlines", "ACME\tCHICK"]) {
            expect(merchantKey(bad), String(bad)).toBeNull();
        }
    });

    it("descriptorOf now allows the branch and store separators", () => {
        expect(descriptorOf("ACMECHICK@T3")).toBe("ACMECHICK@T3");
        expect(descriptorOf("ZE ZE_301")).toBe("ZE ZE_301");
    });
});

describe("pending offers keyed by merchant", () => {
    it("keeps one offer per key and budget, with its category and example", () => {
        const store = new PendingLearning(join(dir, "offers.json"));
        const id = store.offer({ descriptor: "ACMECHICK", example: "ACMECHICK@T3", payee: "Food", category: "Food", budgetId: "b1" });
        expect(store.offer({ descriptor: "ACMECHICK", payee: "Groceries", budgetId: "b1" })).toBe(id);
        expect(store.get(id)).toMatchObject({ payee: "Food", category: "Food", example: "ACMECHICK@T3" });
        expect(store.offer({ descriptor: "ACMECHICK", payee: "Food", budgetId: "b2" })).not.toBe(id);
    });
});

describe("propose_learning", () => {
    it("offers the merchant key and says what it was trimmed from", async () => {
        routedFetch();
        const out = await propose(registry());
        expect(out).toMatchObject({ offered: true, key: "ACMECHICK" });
    });

    it("carries an exact live category", async () => {
        routedFetch();
        const reg = registry();
        const out = await propose(reg, { category: "Food" });
        expect(reg._pendingLearning.get(out.id)).toMatchObject({ descriptor: "ACMECHICK", payee: "Food", category: "Food" });
    });

    it("refuses a category that is not an exact live spending category or carries fact grammar", async () => {
        routedFetch();
        for (const category of ["food", "Foo", "Salary", "Food payee X", "Food|x"]) {
            const out = await propose(registry({ config: { pendingLearningPath: join(dir, `${category.length}-${Math.random()}.json`) } }), { category });
            expect(out, category).toMatchObject({ offered: false, reason: "ineligible_category" });
        }
    });

    it("keys an incoming person offer on sender and amount, never the name alone", async () => {
        routedFetch();
        const reg = registry();
        const out = await propose(reg, { descriptor: "ACME PERSON", incoming: { currency: "SGD", amount_cents: 90000 } });
        expect(out).toMatchObject({ offered: true, key: "Incoming SGD 900.00 from ACME PERSON" });
        expect(reg._pendingLearning.get(out.id)).toMatchObject({ descriptor: "Incoming SGD 900.00 from ACME PERSON", payee: "Food" });
    });

    it("refuses an incoming offer with no usable amount or name", async () => {
        routedFetch();
        for (const [descriptor, incoming] of [
            ["ACME PERSON", { currency: "SGD", amount_cents: 0 }],
            ["ACME PERSON", { currency: "SG$", amount_cents: 100 }],
            ["x maps to Food payee", { currency: "SGD", amount_cents: 100 }],
        ]) {
            const out = await propose(registry(), { descriptor, incoming });
            expect(out, descriptor).toMatchObject({ offered: false, reason: "unusable_descriptor" });
        }
    });

    it("never offers Misc, with or without a category", async () => {
        routedFetch();
        expect(await propose(registry(), { payee: "Misc" })).toMatchObject({ offered: false, reason: "ineligible_payee" });
        expect(await propose(registry(), { payee: "Misc", category: "Food" })).toMatchObject({ offered: false, reason: "ineligible_payee" });
    });

    it("sends an offer once per key: a repeat alert sends nothing and returns no id", async () => {
        routedFetch();
        const reg = registry();
        const sink = vi.fn();
        reg.setOfferSink(sink);
        await propose(reg);
        const again = await propose(reg, { descriptor: "ACMECHICK@T1" });
        expect(again).toMatchObject({ offered: false, reason: "already_offered" });
        expect(again.id).toBeUndefined();
        expect(sink).toHaveBeenCalledTimes(1);
    });
});

describe("confirming an offer with a category", () => {
    it("writes the payee fact and the merchant's category fact", async () => {
        routedFetch();
        const memory = memoryStore();
        const reg = registry({ memory, config: { telegramBotToken: "", telegramHomeChannel: "" } });
        const { id } = await propose(reg, { category: "Food" });
        const done = await reg._confirmLearning(id);
        expect(done).toMatchObject({ confirmed: true, fact: "ACMECHICK maps to Food payee", category: "Food" });
        expect(memory.add.mock.calls.map((c) => c[0])).toEqual([
            "ACMECHICK maps to Food payee",
            "ACMECHICK maps to Food category",
        ]);
    });
});

describe("resolve_merchant while an offer waits", () => {
    const ARGS = { merchant: "ACMECHICK@T1", budget_id: "b1", evidence: EVIDENCE, direction: "outgoing", amount_cents: -1307, currency: "SGD" };

    it("reuses the pending answer: no search and no Jev call", async () => {
        const seen = routedFetch();
        const reg = registry();
        await propose(reg, { category: "Food" });
        const out = await reg.executeTool("resolve_merchant", ARGS);
        expect(out).toMatchObject({ payee: "Food", source: "jev", pending: true, category: "Food" });
        expect(seen.firecrawl).toBe(0);
        expect(seen.jev).toBe(0);
    });

    it("searches again once the offer is declined", async () => {
        const seen = routedFetch();
        const reg = registry();
        const { id } = await propose(reg);
        await reg.executeTool("decline_learning", { id });
        await reg.executeTool("resolve_merchant", ARGS);
        expect(seen.firecrawl).toBe(1);
    });

    it("ignores a pending offer from another budget", async () => {
        const seen = routedFetch();
        const reg = registry();
        await propose(reg, { budget_id: "b2" });
        await reg.executeTool("resolve_merchant", ARGS);
        expect(seen.firecrawl).toBe(1);
    });
});

describe("offer text and answer carry the category", () => {
    it("Telegram offer names the key, the example and the category", async () => {
        const fetchFn = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
        await new LearningNotifier({ token: "t", chatId: "1", fetchFn }).sendOffer({
            offer: { id: "AB23CD45", descriptor: "ACMECHICK", example: "ACMECHICK@T3", payee: "Food", category: "Food" },
        });
        const { text } = JSON.parse(fetchFn.mock.calls[0][1].body);
        expect(text).toContain('Remember "ACMECHICK" (from ACMECHICK@T3) as Food, category Food?');
    });

    it("the answer route returns the category", async () => {
        routedFetch();
        const reg = registry();
        const { id } = await propose(reg, { category: "Food" });
        const handler = createAnswerHandler({ registry: reg, token: "t", chatId: "1" });
        const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
        await handler({ body: { id, action: "remember" }, get: () => signAnswer("remember", id, "t") }, res);
        expect(res.json).toHaveBeenCalledWith({ ok: true, result: "remembered", descriptor: "ACMECHICK", payee: "Food", category: "Food" });
    });
});
