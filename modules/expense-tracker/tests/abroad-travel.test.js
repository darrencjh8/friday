/**
 * Spending abroad books Travel. A memory rule names what was bought, not
 * where: a home brand's branch abroad booked as home shopping, and a merchant
 * with no rule booked Misc. Jev is now asked where the purchase was made, and
 * a charge it cannot place counts as travel when it falls within a day of one
 * it placed abroad.
 *
 * Every merchant, place and home location here is synthetic.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@xenova/transformers", () => ({ pipeline: vi.fn(), env: {} }));
vi.mock("../src/dedup.js", () => ({
    DedupJournal: vi.fn(function () {
        this.record = vi.fn();
        this.checkDuplicate = vi.fn(() => false);
        this.checkExact = vi.fn(() => false);
        this.close = vi.fn();
    }),
}));

import { ABROAD_OPTION, HOME_OPTION, NONE_OPTION, judgeAbroad, leftoverWords } from "../src/jev.js";
import { ToolRegistry } from "../src/tools.js";

afterEach(() => vi.unstubAllGlobals());

const HOMES = ["Springfield", "Shelbyville"];
const EVIDENCE = { sender: "alerts@bank.example", subject: "Card alert", text: "A charge of SGD48.00 at AMAZE* ACMEMART HANOI SINGAPORE SGP" };
const json = (body) => ({ ok: true, status: 200, json: async () => body });

/** A Jev stub: the place answer, then the evidence score. */
function jevStub({ choice, confidence = 0.9, probabilities, evidence = 0.9 }, seen = []) {
    return vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        seen.push(body);
        if (body.questions.place) {
            return json({
                answers: {
                    place: {
                        choice,
                        confidence,
                        probabilities: probabilities || { [choice]: confidence, [ABROAD_OPTION === choice ? HOME_OPTION : ABROAD_OPTION]: 0.05 },
                    },
                },
            });
        }
        return json({ answers: { evidence: { noul: evidence } } });
    });
}

const judge = (fetchImpl, extra = {}) =>
    judgeAbroad({
        config: { jevApiKey: "k" },
        merchant: "AMAZE* ACMEMART HANOI SINGAPORE SGP",
        amountCents: -4800,
        currency: "SGD",
        evidence: EVIDENCE,
        homes: HOMES,
        fetchImpl,
        ...extra,
    });

describe("judgeAbroad", () => {
    it("accepts a confident, evidence-backed outside answer and tells Jev the homes", async () => {
        const seen = [];
        const result = await judge(jevStub({ choice: ABROAD_OPTION }, seen), { context: ["AMAZE LINE"] });
        expect(result).toMatchObject({ abroad: true, confidence: 0.9 });
        expect(seen[0].state).toContain("The owner's home locations: Springfield, Shelbyville.");
        expect(seen[0].state).toContain("AMAZE LINE");
        expect(Object.keys(seen[0].questions.place.criteria)).toEqual([ABROAD_OPTION, HOME_OPTION, NONE_OPTION]);
    });

    it.each([
        ["weak evidence", { choice: ABROAD_OPTION, evidence: 0.5 }, "weak_evidence"],
        ["low confidence", { choice: ABROAD_OPTION, confidence: 0.5 }, "low_confidence"],
        ["a close runner-up", { choice: ABROAD_OPTION, confidence: 0.7, probabilities: { [ABROAD_OPTION]: 0.5, [HOME_OPTION]: 0.4 } }, "close_runner_up"],
        ["the none option", { choice: NONE_OPTION }, "none"],
    ])("refuses %s", async (_label, answer, reason) => {
        expect(await judge(jevStub(answer))).toMatchObject({ abroad: false, reason });
    });

    it("reports a confident home answer", async () => {
        expect(await judge(jevStub({ choice: HOME_OPTION }))).toMatchObject({ abroad: false, home: true });
    });

    it("asks nothing without home locations or evidence", async () => {
        const fetchImpl = vi.fn();
        expect(await judge(fetchImpl, { homes: [] })).toMatchObject({ abroad: false, reason: "no_home" });
        expect(await judge(fetchImpl, { evidence: { text: "" } })).toMatchObject({ abroad: false, reason: "no_evidence" });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe("leftoverWords", () => {
    it.each([
        ["AMAZE* ACMEMART HANOI SINGAPORE SGP", "ACMEMART", ["HANOI"]],
        ["AMAZE* ACMEMART HANOI SINGAPORE SGP", "AMAZE* ACMEMART HANOI SINGAPORE SGP", []],
        ["AMAZE* ACMEMART SINGAPORE SGP", "ACMEMART", []],
        ["AMAZE* RIDECO A-0AB1C", "AMAZE* RIDECO", []],
        ["ACMEMART HO CHI MINH", "ACMEMART", ["CHI", "MINH"]],
    ])("%s under %s leaves %j", (descriptor, key, expected) => {
        expect(leftoverWords(descriptor, key)).toEqual(expected);
    });
});

describe("judge_abroad", () => {
    /** A registry over a stubbed Actual API and Jev. */
    function registry({ answer, rows = [], payees = [{ id: "p-travel", name: "Travel" }], facts = HOMES.map((h) => `Home location: ${h}`) }) {
        const seen = { jev: [], transactions: [] };
        const jev = jevStub(answer, seen.jev);
        vi.stubGlobal("fetch", vi.fn(async (url, init) => {
            const u = String(url);
            if (u.includes("systemone")) return jev(url, init);
            if (u.includes("/payees")) return json(payees);
            if (u.includes("/transactions")) {
                seen.transactions.push(new URL(u).searchParams);
                return json(rows);
            }
            return json([]);
        }));
        const memory = { search: vi.fn(async () => []), add: vi.fn(), listFacts: vi.fn(() => facts) };
        const tools = new ToolRegistry({ dedupDbPath: ":memory:", jevApiKey: "k" }, memory);
        const run = (extra = {}) =>
            tools.executeTool("judge_abroad", {
                merchant: "AMAZE* MPOSACME SINGAPORE SGP",
                budget_id: "b1",
                evidence: EVIDENCE,
                amount_cents: -2000,
                currency: "SGD",
                date: "2026-10-22",
                ...extra,
            });
        return { run, seen };
    }

    it("names the live Travel payee when Jev places the charge abroad", async () => {
        const { run, seen } = registry({ answer: { choice: ABROAD_OPTION } });
        expect(await run()).toMatchObject({ abroad: true, payee: "Travel", source: "abroad" });
        expect(seen.jev[0].state).toContain("Springfield, Shelbyville");
        expect(seen.transactions).toHaveLength(0);
    });

    it("counts a charge Jev cannot place when one within a day was placed abroad", async () => {
        const rows = [
            { date: "2026-10-19", notes: "Abroad: placed outside the home locations" },
            { date: "2026-10-21", notes: "Merchant: AMAZE* ACMEMART HANOI SINGAPORE SGP\n\nAbroad: placed outside the home locations" },
        ];
        const { run, seen } = registry({ answer: { choice: NONE_OPTION }, rows });
        expect(await run({ trip_window: true })).toMatchObject({ abroad: true, payee: "Travel", source: "trip", trip_date: "2026-10-21" });
        expect(seen.transactions[0].get("since_date")).toBe("2026-10-21");
        expect(seen.transactions[0].get("until_date")).toBe("2026-10-23");
    });

    it.each([
        ["only a plain Travel row is near", [{ date: "2026-10-22", notes: "Merchant: AMAZE* RIDECO" }]],
        ["only a trip row is near", [{ date: "2026-10-22", notes: "Trip: within a day of a charge placed abroad (2026-10-21)" }]],
        ["the abroad row is two days away", [{ date: "2026-10-24", notes: "Abroad: placed outside the home locations" }]],
    ])("does not count it when %s", async (_label, rows) => {
        const { run } = registry({ answer: { choice: NONE_OPTION }, rows });
        expect(await run({ trip_window: true })).toMatchObject({ abroad: false });
    });

    it("never reads the trip window after a confident home answer, or unasked", async () => {
        const rows = [{ date: "2026-10-22", notes: "Abroad: placed outside the home locations" }];
        const home = registry({ answer: { choice: HOME_OPTION }, rows });
        expect(await home.run({ trip_window: true })).toMatchObject({ abroad: false });
        expect(home.seen.transactions).toHaveLength(0);
        const unasked = registry({ answer: { choice: NONE_OPTION }, rows });
        expect(await unasked.run()).toMatchObject({ abroad: false });
        expect(unasked.seen.transactions).toHaveLength(0);
    });

    it("never asks about a transfer to one of the owner's accounts", async () => {
        const payees = [{ id: "p-travel", name: "Travel" }, { id: "p-card", name: "Acme Card", transfer_acct: "acc-card" }];
        const { run, seen } = registry({ answer: { choice: ABROAD_OPTION }, payees });
        expect(await run({ payee: "Acme Card" })).toMatchObject({ abroad: false, reason: "transfer" });
        expect(seen.jev).toHaveLength(0);
    });

    it("asks nothing without a home location or a Travel payee", async () => {
        const noHome = registry({ answer: { choice: ABROAD_OPTION }, facts: [] });
        expect(await noHome.run()).toMatchObject({ abroad: false, reason: "no_home" });
        expect(noHome.seen.jev).toHaveLength(0);
        const noTravel = registry({ answer: { choice: ABROAD_OPTION }, payees: [{ id: "p-misc", name: "Misc" }] });
        expect(await noTravel.run()).toMatchObject({ abroad: false, reason: "no_travel_payee" });
        expect(noTravel.seen.jev).toHaveLength(0);
    });
});

describe("the orchestrator books spending abroad as Travel", () => {
    const citiBody = (details) =>
        [
            "Dear Customer,",
            "We would like to inform you that there is a charge made on your Citi Rewards Card:",
            "",
            "Account Number           : XXXX-XXXX-XXXX-0000",
            "Transaction date         : 22/10/26",
            "Transaction amount       : SGD48.00",
            `Transaction  details     : ${details}`,
            "",
            "Thank you for using Citi Alerts.",
        ].join("\n");
    const RAW = (details) =>
        [
            "From: Citi Alerts <alerts@citi.example>",
            "To: holder@example.com",
            "Subject: Citi Alerts - Credit Card/Ready Credit Transaction",
            "Date: Thu, 22 Oct 2026 23:18:30 +0800",
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "",
            citiBody(details),
            "",
        ].join("\r\n");
    const CATEGORIES = [
        { id: "c-groceries", name: "Groceries" },
        { id: "c-travel", name: "Travel" },
    ];

    async function book({ details, merchant, memory = {}, verdict = { abroad: false, reason: "none" } }) {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const accounts = [{ id: "acc-citi", name: "Citi Rewards", closed: false }];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context") {
                    return {
                        accounts,
                        categories: CATEGORIES,
                        payees: [
                            { id: "p-misc", name: "Misc" },
                            { id: "p-shop", name: "Shopping" },
                            { id: "p-travel", name: "Travel" },
                        ],
                    };
                }
                if (name === "search_memory") return { results: (memory[args.query] || []).map((text) => ({ text, score: 1 })) };
                if (name === "list_facts") return { facts: [] };
                if (name === "resolve_merchant") return { payee: "Misc", source: "fallback", search: { results: [{ title: "ACME" }] } };
                if (name === "judge_abroad") return verdict;
                if (name === "check_duplicate") return false;
                if (name === "check_schedule_collision") return false;
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
        const phase1 = {
            merchant,
            amount_cents: -4800,
            date: "2026-10-22",
            currency: "SGD",
            account_id: "acc-citi",
            account_name: "Citi Rewards",
            raw_description: `SGD48.00 at ${merchant}`,
            raw_merchant_descriptor: merchant,
            notes: "",
            skip: false,
            reasoning: "Citi card",
            notify_message: "",
        };
        orch._llm.chat = vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(phase1) } }] });
        await orch.processEmail(1001, Buffer.from(RAW(details)), null, "Citi Alerts <alerts@citi.example>",
            "Citi Alerts - Credit Card/Ready Credit Transaction");
        return {
            calls,
            judged: calls.find((c) => c.name === "judge_abroad"),
            insert: calls.find((c) => c.name === "insert_transaction"),
        };
    }

    const DESCRIPTOR = "AMAZE* ACMEMART HANOI SINGAPORE SGP";
    const RULES = {
        [DESCRIPTOR]: ["ACMEMART maps to Shopping payee", "ACMEMART maps to Groceries category"],
        Travel: ["Travel maps to Travel category"],
    };

    it("books a home brand's rule as Travel when the descriptor's place is abroad", async () => {
        const { judged, insert } = await book({
            details: "AMAZE* ACMEMART HANOI    SINGAPORE     SGP",
            merchant: DESCRIPTOR,
            memory: RULES,
            verdict: { abroad: true, payee: "Travel", source: "abroad" },
        });
        expect(judged.args).toMatchObject({ merchant: DESCRIPTOR, payee: "Shopping", date: "2026-10-22" });
        expect(judged.args.trip_window).toBeUndefined();
        expect(judged.args.search).toBeUndefined();
        expect(insert.args.imported_description).toBe("Travel");
        expect(insert.args.category_id).toBe("c-travel");
        expect(insert.args.notes).toMatch(/^Abroad: placed outside the home locations$/m);
    });

    it("keeps the rule when Jev does not place it abroad", async () => {
        const { judged, insert } = await book({
            details: "AMAZE* ACMEMART HANOI    SINGAPORE     SGP",
            merchant: DESCRIPTOR,
            memory: RULES,
        });
        expect(judged).toBeDefined();
        expect(insert.args.imported_description).toBe("Shopping");
        expect(insert.args.category_id).toBe("c-groceries");
        expect(insert.args.notes).not.toMatch(/Abroad:|Trip:/);
    });

    it("does not ask when the rule names the whole descriptor", async () => {
        const merchant = "AMAZE* ACMEMART SINGAPORE SGP";
        const { judged, insert } = await book({
            details: "AMAZE* ACMEMART    SINGAPORE     SGP",
            merchant,
            memory: { [merchant]: ["ACMEMART maps to Shopping payee"] },
            verdict: { abroad: true, payee: "Travel", source: "abroad" },
        });
        expect(judged).toBeUndefined();
        expect(insert.args.imported_description).toBe("Shopping");
    });

    it("asks about a Misc fallback with its search and the trip window", async () => {
        const merchant = "AMAZE* MPOSACME SINGAPORE SGP";
        const { judged, insert } = await book({
            details: "AMAZE* MPOSACME    SINGAPORE     SGP",
            merchant,
            memory: { Travel: RULES.Travel },
            verdict: { abroad: true, payee: "Travel", source: "trip", trip_date: "2026-10-21" },
        });
        expect(judged.args).toMatchObject({ trip_window: true, search: { results: [{ title: "ACME" }] } });
        expect(insert.args.imported_description).toBe("Travel");
        expect(insert.args.category_id).toBe("c-travel");
        expect(insert.args.notes).toContain("Trip: within a day of a charge placed abroad (2026-10-21)");
        expect(insert.args.notes).not.toMatch(/^Abroad:/m);
    });

    it("leaves a Misc fallback alone when it is not abroad", async () => {
        const { judged, insert } = await book({
            details: "AMAZE* MPOSACME    SINGAPORE     SGP",
            merchant: "AMAZE* MPOSACME SINGAPORE SGP",
        });
        expect(judged).toBeDefined();
        expect(insert.args.imported_description).toBe("Misc");
    });
});
