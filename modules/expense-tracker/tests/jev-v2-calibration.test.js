/**
 * Jev payee prompt `v2` and the calibration dry run. `v2` tells Jev payees are
 * the owner's spending labels, describes each from the owner's bookings, adds
 * the owner's earlier bookings of the same merchant and leaves out options
 * that cannot fit. A calibration dry run scores every variant on an alert,
 * hiding bookings from the alert's own date on. Fixtures are synthetic; every
 * request goes to a URL-routed fetch stub.
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

import { ToolRegistry } from "../src/tools.js";
import { NONE_OPTION, classifyPayee, payeeHistory } from "../src/jev.js";
import { ProcessingService } from "../src/processing.js";

afterEach(() => vi.unstubAllGlobals());

const PAYEES = [
    { id: "p-misc", name: "Misc" },
    { id: "p-food", name: "Food" },
    { id: "p-snack", name: "Snack" },
    { id: "p-salary", name: "Salary" },
    { id: "p-test", name: "Node API test" },
    { id: "p-adj", name: "Manual Balance Adjustment" },
    { id: "p-unused", name: "Passport" },
    { id: "p-acct", name: "Savings", transfer_acct: "a-sav" },
];
const CATEGORIES = [
    { id: "c-food", name: "Food" },
    { id: "c-inc", name: "Income", is_income: true },
];
const row = (payee, amount, date, merchant, category = "c-food", over = {}) => ({
    id: `${payee}-${date}-${amount}`,
    payee,
    amount,
    date,
    category,
    notes: merchant ? `Merchant: ${merchant}` : "",
    ...over,
});
const ROWS = [
    row("p-food", -1200, "2026-09-01", "ACME BURGER 01"),
    row("p-food", -900, "2026-09-03", "ACME BURGER 01"),
    row("p-food", -800, "2026-09-05", "NOODLE HOUSE"),
    row("p-snack", -300, "2026-09-06", "ACME BURGER 01"),
    row("p-salary", 500000, "2026-09-25", null, "c-inc"),
    row("p-salary", 500000, "2026-08-25", null, "c-inc"),
    row("p-salary", 500000, "2026-07-25", null, "c-inc"),
    row("p-test", -100, "2026-09-02", null),
    row("p-adj", -100, "2026-09-02", null),
    // The alert's own row and anything after it must not be seen.
    row("p-snack", -1475, "2026-10-20", "ACME BURGER 01"),
    row("p-snack", -1475, "2026-10-21", "ACME BURGER 01"),
    // A transfer is not a label.
    row("p-food", -5000, "2026-09-07", "ACME BURGER 01", null, { transfer_id: "t1" }),
];

const EVIDENCE = { text: "SGD 14.75 at ACME BURGER 01 on your card.", subject: "Card alert", sender: "alerts@bank.example" };
const CONFIG = { jevApiKey: "jev-k" };

describe("payeeHistory", () => {
    const h = payeeHistory(ROWS, { payees: PAYEES, categories: CATEGORIES, merchant: "ACME BURGER 01", asOf: "2026-10-20" });

    it("counts the owner's earlier bookings of the same merchant, before the alert's date only", () => {
        expect(Object.fromEntries(h.sameMerchant)).toEqual({ Food: 2, Snack: 1 });
    });

    it("skips transfers and records each payee's usual category and merchants", () => {
        const food = h.byName.get("Food");
        expect(food.outflows).toBe(3);
        expect([...food.categories.keys()]).toEqual(["Food"]);
        expect([...food.merchants.keys()]).toEqual(["ACME BURGER 01", "NOODLE HOUSE"]);
        expect(h.byName.get("Salary").merchants.size).toBe(0);
    });
});

/** Answers a choice with `choice` at `confidence` and the evidence check with `noul`. */
function stubJev({ choice = "Food", confidence = 0.9, probabilities, noul = 0.9 } = {}) {
    const bodies = [];
    const fn = vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        const answers = body.questions.payee
            ? { payee: { choice, confidence, probabilities: probabilities || { [choice]: confidence, [NONE_OPTION]: 1 - confidence } } }
            : { evidence: { noul } };
        return { ok: true, status: 200, json: async () => ({ answers }) };
    });
    return { fn, bodies };
}

const history = payeeHistory(ROWS, { payees: PAYEES, categories: CATEGORIES, merchant: "ACME BURGER 01", asOf: "2026-10-20" });
const classify = (fetchImpl, over = {}) =>
    classifyPayee({
        config: CONFIG,
        merchant: "ACME BURGER 01",
        direction: "outgoing",
        amountCents: -1475,
        currency: "SGD",
        evidence: EVIDENCE,
        payees: PAYEES,
        fetchImpl,
        ...over,
    });

describe("classifyPayee v2", () => {
    it("asks for the owner's label, not who received the money", async () => {
        const { fn, bodies } = stubJev();
        await classify(fn, { variant: "v2", history });
        const q = bodies[0].questions.payee;
        expect(q.instructions).toContain("payee labels would the owner use");
        expect(bodies[0].state).toContain("budget labels for what the money was for");
    });

    it("describes each option from the owner's bookings", async () => {
        const { fn, bodies } = stubJev();
        await classify(fn, { variant: "v2", history });
        expect(bodies[0].questions.payee.criteria.Food).toBe(
            "The owner books it under the Food category. Merchants the owner booked to it: ACME BURGER 01, NOODLE HOUSE.",
        );
    });

    it("adds the owner's earlier bookings of the same merchant to the state", async () => {
        const { fn, bodies } = stubJev();
        await classify(fn, { variant: "v2", history });
        expect(bodies[0].state).toContain("The owner's earlier bookings of this same merchant: Food 2x, Snack 1x.");
    });

    it("leaves out bookkeeping, unused and opposite-direction payees", async () => {
        const { fn, bodies } = stubJev();
        await classify(fn, { variant: "v2", history });
        const options = Object.keys(bodies[0].questions.payee.criteria);
        expect(options).toEqual(["Food", "Snack", NONE_OPTION]);
    });

    it("keeps an income payee for money received", async () => {
        const { fn, bodies } = stubJev({ choice: "Salary" });
        await classify(fn, { variant: "v2", history, direction: "incoming", amountCents: 500000 });
        expect(Object.keys(bodies[0].questions.payee.criteria)).toContain("Salary");
    });

    it("v1 stays the default: bare names and the original question", async () => {
        const { fn, bodies } = stubJev();
        await classify(fn, { history });
        const q = bodies[0].questions.payee;
        expect(q.criteria.Food).toBeNull();
        expect(q.instructions).toContain("Which listed payee received it?");
        expect(Object.keys(q.criteria)).toContain("Node API test");
    });
});

describe("classifyPayee fullScores", () => {
    it("still measures margin and evidence after a failed confidence gate", async () => {
        const { fn, bodies } = stubJev({ confidence: 0.63, probabilities: { Food: 0.63, Snack: 0.2, [NONE_OPTION]: 0.17 } });
        const out = await classify(fn, { variant: "v2", history, fullScores: true });
        expect(out.payee).toBeNull();
        expect(out.reason).toBe("low_confidence");
        expect(out.scores).toMatchObject({ choice: "Food", confidence: 0.63, margin: 0.43, evidence: 0.9, variant: "v2" });
        expect(bodies).toHaveLength(2);
    });

    it("live calls stop at the first failed gate", async () => {
        const { fn, bodies } = stubJev({ confidence: 0.63 });
        const out = await classify(fn, {});
        expect(out.reason).toBe("low_confidence");
        expect(bodies).toHaveLength(1);
    });
});

/** Actual, Firecrawl and Jev behind one stub. */
function routed() {
    const seen = { firecrawl: 0, jev: [] };
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url, init = {}) => {
            const json = (body) => ({ ok: true, status: 200, json: async () => body });
            if (String(url).startsWith("https://api.firecrawl.dev/")) {
                seen.firecrawl += 1;
                return json({ success: true, data: { web: [{ title: "Acme Burger", description: "burger restaurant", url: "https://acme.example/" }] } });
            }
            if (String(url).includes("systemone")) {
                const body = JSON.parse(init.body);
                seen.jev.push(body);
                return json(
                    body.questions.payee
                        ? { answers: { payee: { choice: "Food", confidence: 0.8, probabilities: { Food: 0.8, [NONE_OPTION]: 0.2 } } } }
                        : { answers: { evidence: { noul: 0.9 } } },
                );
            }
            if (String(url).includes("/payees")) return json(PAYEES);
            if (String(url).includes("/categories")) return json(CATEGORIES);
            if (String(url).includes("/transactions")) return json(ROWS);
            return json([]);
        }),
    );
    return seen;
}

const registry = (over = {}) =>
    new ToolRegistry({ dedupDbPath: ":memory:", jevApiKey: "jev-k", firecrawlApiKey: "fc-k", ...over }, { search: vi.fn(async () => []), add: vi.fn() });
const CAL_ARGS = {
    merchant: "ACME BURGER 01",
    budget_id: "b1",
    evidence: EVIDENCE,
    direction: "outgoing",
    amount_cents: -1475,
    currency: "SGD",
    as_of: "2026-10-20",
};

describe("calibrate_jev", () => {
    it("refuses outside a calibration dry run", async () => {
        routed();
        const tools = registry();
        expect(await tools.executeTool("calibrate_jev", CAL_ARGS)).toEqual({ error: "calibration_only" });
        const { result } = await tools.dryRun(() => tools.executeTool("calibrate_jev", CAL_ARGS));
        expect(result).toEqual({ error: "calibration_only" });
    });

    it("scores every variant with one search and records the result, never the email", async () => {
        const seen = routed();
        const tools = registry();
        const { result, calls } = await tools.dryRun(() => tools.executeTool("calibrate_jev", CAL_ARGS), { calibrate: true });
        expect(seen.firecrawl).toBe(1);
        expect(result.v1).toMatchObject({ payee: "Food", reason: "accepted", scores: { variant: "v1" } });
        expect(result.v2).toMatchObject({ payee: "Food", reason: "accepted", scores: { variant: "v2", options: 2 } });
        expect(result.earlier).toEqual({ Food: 2, Snack: 1 });
        expect(calls).toEqual([{ tool: "calibrate_jev", args: { merchant: "ACME BURGER 01", as_of: "2026-10-20" }, result }]);
        expect(JSON.stringify(calls)).not.toContain("on your card");
    });

    it("resolve_merchant in the same calibration run reuses the search", async () => {
        const seen = routed();
        const tools = registry();
        await tools.dryRun(async () => {
            await tools.executeTool("calibrate_jev", CAL_ARGS);
            await tools.executeTool("resolve_merchant", CAL_ARGS);
        }, { calibrate: true });
        expect(seen.firecrawl).toBe(1);
    });

    it("resolve_merchant runs the live variant from config", async () => {
        const seen = routed();
        await registry({ jevPromptVariant: "v2" }).executeTool("resolve_merchant", CAL_ARGS);
        expect(seen.jev[0].questions.payee.instructions).toContain("payee labels would the owner use");
    });
});

describe("jev_calibration request flag", () => {
    const service = () =>
        new ProcessingService({
            orchestrator: { processEmail: vi.fn(async () => ({ action: "inserted" })) },
            statementProcessor: {},
            tools: { dryRun: vi.fn(async (fn, opts) => ({ result: await fn(), calls: [], opts })) },
            journal: { get: vi.fn(), begin: vi.fn(), finish: vi.fn(), release: vi.fn() },
        });
    const evidence = { raw_email_b64: Buffer.from("From: a@b.example\r\nSubject: s\r\n\r\nbody").toString("base64") };

    it("is refused without a dry run", async () => {
        const out = await service().processTransaction({ request_id: "req-00001", evidence, jev_calibration: true });
        expect(out).toMatchObject({ status: "invalid", reason: "bad_jev_calibration" });
    });

    it("is passed to the dry run", async () => {
        const s = service();
        await s.processTransaction({ request_id: "req-00001", evidence, dry_run: true, jev_calibration: true });
        expect(s._tools.dryRun).toHaveBeenCalledWith(expect.any(Function), { calibrate: true });
    });
});

describe("orchestrator calibration hook", () => {
    const DEPOSIT = [
        "From: OCBC Alerts <alerts@ocbc.com>",
        "Subject: Deposit alert",
        "Date: Fri, 9 Oct 2026 06:50:30 +0800",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "A deposit was made in your account. Here are the details:",
        "",
        "Time of deposit: 6:50 AM",
        "Amount: SGD 50.00",
        "Account that money was deposited in: (-166600)",
        "Reference: from ACME PERSON",
        "",
        "For assistance at any time, please call our hotline.",
        "",
    ].join("\r\n");

    async function run(calibrating, facts = ["Account ending 166600 belongs to OCBC 111"]) {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            calibrating: () => calibrating,
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context")
                    return {
                        accounts: [{ id: "ocbc-111", name: "OCBC 111", closed: false }],
                        categories: [{ id: "cat-food", name: "Food" }],
                        payees: [{ id: "p-sal", name: "Salary" }],
                    };
                if (name === "list_facts") return { facts: facts.map((text) => ({ text })) };
                if (name === "search_memory")
                    return { results: [{ text: "Account ending 166600 belongs to OCBC 111", score: 1 }] };
                if (name === "resolve_merchant") return { payee: null };
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
        await orch.processEmail(1300, Buffer.from(DEPOSIT), null, "OCBC Alerts <alerts@ocbc.com>", "Deposit alert");
        return calls;
    }

    it("scores the alert with its date and no web search for a person", async () => {
        const calls = await run(true);
        const [cal] = calls.filter((c) => c.name === "calibrate_jev");
        expect(cal.args).toMatchObject({ merchant: "ACME PERSON", direction: "incoming", amount_cents: 5000, as_of: "2026-10-09", no_search: true });
        expect(cal.args.evidence.text).toContain("ACME PERSON");
    });

    it("never searches a person, even one whose credit matched an amount rule", async () => {
        const calls = await run(true, [
            "Account ending 166600 belongs to OCBC 111",
            "Incoming SGD 50.00 from ACME PERSON maps to Salary payee",
        ]);
        const [cal] = calls.filter((c) => c.name === "calibrate_jev");
        expect(cal.args).toMatchObject({ merchant: "ACME PERSON", no_search: true });
    });

    it("does nothing outside a calibration run", async () => {
        const calls = await run(false);
        expect(calls.some((c) => c.name === "calibrate_jev")).toBe(false);
    });
});
