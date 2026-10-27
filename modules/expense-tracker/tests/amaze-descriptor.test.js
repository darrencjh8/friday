/**
 * Amaze card charges. Every Citi alert for an Amaze charge ends its descriptor
 * with Amaze's own location, `SINGAPORE SGP`, even for spending abroad, and the
 * Phase 1 LLM read the same line as "AMAZE" on one run and "ACMESHOP63" on the
 * next. The descriptor now comes from the alert text, the web search and Jev
 * ignore the Amaze location, and Jev is told where the owner lives so spending
 * elsewhere reads as travel.
 *
 * The alert bodies keep the real alerts' layout; every merchant, amount,
 * time and account number is synthetic, and so are the home locations.
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

import { amazeDescriptor, isAmaze, withoutAmazeLocation } from "../src/amaze.js";
import { merchantQuery, searchMerchant } from "../src/merchant-search.js";
import { NONE_OPTION, alertContext, classifyPayee } from "../src/jev.js";
import { factNamesMerchant } from "../src/memory.js";
import { wikiFacts } from "../src/wiki-knowledge.js";
import { ToolRegistry } from "../src/tools.js";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

afterEach(() => vi.unstubAllGlobals());

/** A real Citi alert body, as the bank lays it out, redacted. */
const citiBody = (details, { date = "22/10/26", amount = "SGD12.34" } = {}) =>
    [
        "Dear Customer,",
        "We would like to inform you that there is a charge made on your Citi Rewards Card:",
        "",
        "",
        "Account Number           : XXXX-XXXX-XXXX-0000",
        `Transaction date         : ${date}`,
        "Transaction time         : 12:00:05",
        `Transaction amount       : ${amount}`,
        `Transaction  details     : ${details}`,
        "",
        "",
        "Thank you for using Citi Alerts.",
        "",
        "Citibank Online",
        "Citibank Singapore Ltd",
        "Co.Reg. No. 000000000K",
    ].join("\n");

/** A real Standard Chartered debit card alert line, redacted. */
const scBody = (merchant, tail = "") =>
    `Dear Valued Customer, Transaction Alert Debit Card Thank you for charging +SGD 10.00 to yr debit card ****0000 on 01-Jan-2026 09:00 AM at ${merchant}${tail}. To modify these alerts, please logon to your Online Banking account.`;

/** The tracker's email text: whitespace collapsed (extractors.js). */
const collapsed = (text) => text.replace(/\s+/g, " ").trim();

describe("amazeDescriptor", () => {
    it.each([
        ["AMAZE* ACMESHOP63 S    SINGAPORE     SGP", "AMAZE* ACMESHOP63 S SINGAPORE SGP"],
        ["AMAZE* ACME HA LONG    SINGAPORE     SGP", "AMAZE* ACME HA LONG SINGAPORE SGP"],
        ["AMAZE* 2EXAMPLE.COM    SINGAPORE     SGP", "AMAZE* 2EXAMPLE.COM SINGAPORE SGP"],
        ["AMAZE* ACMEWHERE     SINGAPORE     SGP", "AMAZE* ACMEWHERE SINGAPORE SGP"],
        ["AMAZE* ACME - RESTA    SINGAPORE     SGP", "AMAZE* ACME - RESTA SINGAPORE SGP"],
    ])("reads the Citi line %s, laid out or collapsed", (details, expected) => {
        expect(amazeDescriptor(citiBody(details))).toBe(expected);
        expect(amazeDescriptor(collapsed(citiBody(details)))).toBe(expected);
    });

    it.each([
        ["AMAZE* ACMEINSURERS", "", "AMAZE* ACMEINSURERS"],
        ["AMAZE* ACME BEANS V", "", "AMAZE* ACME BEANS V"],
        ["AMAZE* RIDECO A-0AB1C", " has been reversed", "AMAZE* RIDECO A-0AB1C"],
    ])("reads the Standard Chartered line %s%s", (merchant, tail, expected) => {
        expect(amazeDescriptor(scBody(merchant, tail))).toBe(expected);
    });

    it("is null for an alert that is not an Amaze charge", () => {
        expect(amazeDescriptor(citiBody("ACME CAFE              SINGAPORE     SGP"))).toBeNull();
        expect(amazeDescriptor("")).toBeNull();
    });

    it("keeps every remembered Amaze key matching, with or without the location", () => {
        // Live keys take both shapes; a key only ever matches inside a longer merchant.
        expect(factNamesMerchant("AMAZE* ACMENOODLE SINGAPORE SGP maps to Food payee",
            amazeDescriptor(citiBody("AMAZE* ACMENOODLE       SINGAPORE     SGP")))).toBe(true);
        expect(factNamesMerchant("AMAZE* ACMEINSURERS maps to Insurance payee",
            amazeDescriptor(citiBody("AMAZE* ACMEINSURERS    SINGAPORE     SGP")))).toBe(true);
        expect(factNamesMerchant("AMAZE* ACMEINSURERS maps to Insurance payee",
            amazeDescriptor(scBody("AMAZE* ACMEINSURERS")))).toBe(true);
    });

    it("tells an Amaze descriptor apart and drops only its own location", () => {
        expect(isAmaze("AMAZE* ACMESHOP63 S SINGAPORE SGP")).toBe(true);
        expect(isAmaze("ACME AMAZE* X")).toBe(false);
        expect(withoutAmazeLocation("AMAZE* ACMESHOP63 S SINGAPORE SGP")).toBe("AMAZE* ACMESHOP63 S");
    });
});

describe("Amaze web search", () => {
    it.each([
        ["AMAZE* ACMESHOP63 S SINGAPORE SGP", "ACMESHOP63 S"],
        ["AMAZE* ACME HA LONG SINGAPORE SGP", "ACME HA LONG"],
        ["AMAZE* ACMEINSURERS", "ACMEINSURERS"],
    ])("searches %s as %s, with no country", (descriptor, query) => {
        expect(merchantQuery(descriptor, "SGD")).toBe(query);
    });

    it("sends no country to Firecrawl for an Amaze charge", async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { web: [] } }) }));
        await searchMerchant({ config: { firecrawlApiKey: "fc" }, descriptor: "AMAZE* ACME HA LONG SINGAPORE SGP", currency: "SGD", fetchImpl });
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(body).toMatchObject({ query: "ACME HA LONG" });
        expect(body.country).toBeUndefined();
    });
});

describe("home locations in the wiki", () => {
    it("reads the Home locations section as facts", () => {
        const dir = mkdtempSync(join(tmpdir(), "wiki-home-"));
        writeFileSync(join(dir, "merchant-payee-mappings.md"), [
            "# Merchant payee mappings",
            "",
            "## Home locations",
            "",
            "- Springfield",
            "- Shelbyville",
            "",
            "## Routing rules",
            "",
            "- Plain Acme is Taxi.",
        ].join("\n"));
        const facts = wikiFacts(dir);
        expect(facts).toContain("Home location: Springfield");
        expect(facts).toContain("Home location: Shelbyville");
        expect(facts).toContain("Plain Acme is Taxi.");
    });
});

const AMAZE_LINE = /Amaze card charge.*SINGAPORE SGP, which is Amaze's own/;

describe("alertContext", () => {
    it("explains an Amaze location and names the owner's home locations", () => {
        const lines = alertContext({
            merchant: "AMAZE* ACMESHOP63 S SINGAPORE SGP",
            facts: ["Home location: Springfield", "AMAZE* RIDECO maps to Travel payee", { text: "Home location: Shelbyville" }],
        });
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(AMAZE_LINE);
        expect(lines[1]).toBe("The owner lives in Springfield and Shelbyville. Spending that the merchant or the evidence clearly places outside these places is usually travel.");
    });

    it("says nothing it does not know", () => {
        expect(alertContext({ merchant: "ACME CAFE", facts: ["ACME CAFE maps to Food payee"] })).toEqual([]);
    });
});

describe("Jev sees the context", () => {
    const PAYEES = [
        { id: "p-misc", name: "Misc" },
        { id: "p-travel", name: "Travel" },
        { id: "p-food", name: "Food" },
    ];
    const EVIDENCE = { text: collapsed(citiBody("AMAZE* ACMESHOP63 S    SINGAPORE     SGP")), subject: "Citi Alerts - Credit Card/Ready Credit Transaction", sender: "alerts@citi.example" };

    function jevStub() {
        const bodies = [];
        const fn = vi.fn(async (_url, init) => {
            const body = JSON.parse(init.body);
            bodies.push(body);
            const answers = body.questions.payee
                ? { payee: { choice: "Travel", confidence: 0.8, probabilities: { Travel: 0.8, [NONE_OPTION]: 0.2 } } }
                : { evidence: { noul: 0.9 } };
            return { ok: true, status: 200, json: async () => ({ answers }) };
        });
        return { fn, bodies };
    }

    it.each(["v1", "v2"])("classifyPayee %s puts the context lines in the state", async (variant) => {
        const { fn, bodies } = jevStub();
        await classifyPayee({
            config: { jevApiKey: "k" },
            merchant: "AMAZE* ACMESHOP63 S SINGAPORE SGP",
            direction: "outgoing",
            amountCents: -1234,
            currency: "SGD",
            evidence: EVIDENCE,
            payees: PAYEES,
            variant,
            context: ["CONTEXT LINE ONE"],
            fetchImpl: fn,
        });
        expect(JSON.stringify(bodies[0])).toContain("CONTEXT LINE ONE");
    });

    it("resolve_merchant gives Jev the Amaze line and the wiki's home locations", async () => {
        const seen = { jev: [], firecrawl: [] };
        vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
            const json = (body) => ({ ok: true, status: 200, json: async () => body });
            if (String(url).startsWith("https://api.firecrawl.dev/")) {
                seen.firecrawl.push(JSON.parse(init.body));
                return json({ data: { web: [] } });
            }
            if (String(url).includes("systemone")) {
                const body = JSON.parse(init.body);
                seen.jev.push(body);
                return json(body.questions.payee
                    ? { answers: { payee: { choice: "Travel", confidence: 0.8, probabilities: { Travel: 0.8, [NONE_OPTION]: 0.2 } } } }
                    : { answers: { evidence: { noul: 0.9 } } });
            }
            if (String(url).includes("/payees")) return json(PAYEES);
            return json([]);
        }));
        const memory = {
            search: vi.fn(async () => []),
            add: vi.fn(),
            listFacts: vi.fn(() => ["Home location: Springfield", "Home location: Shelbyville"]),
        };
        const tools = new ToolRegistry({ dedupDbPath: ":memory:", jevApiKey: "k", firecrawlApiKey: "fc" }, memory);
        await tools.executeTool("resolve_merchant", {
            merchant: "AMAZE* ACMESHOP63 S SINGAPORE SGP",
            budget_id: "b1",
            evidence: EVIDENCE,
            direction: "outgoing",
            amount_cents: -1234,
            currency: "SGD",
        });
        expect(seen.firecrawl[0]).toMatchObject({ query: "ACMESHOP63 S" });
        expect(seen.firecrawl[0].country).toBeUndefined();
        const state = JSON.stringify(seen.jev[0]);
        expect(state).toMatch(AMAZE_LINE);
        expect(state).toContain("The owner lives in Springfield and Shelbyville.");
    });
});

describe("Phase 1 takes the Amaze descriptor from the alert", () => {
    const RAW = (details) =>
        [
            "From: Citi Alerts <alerts@citi.example>",
            "To: holder@example.com",
            "Subject: Citi Alerts - Credit Card/Ready Credit Transaction",
            "Date: Thu, 22 Oct 2026 12:00:30 +0800",
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "",
            citiBody(details),
            "",
        ].join("\r\n");

    async function book({ details, llmMerchant, facts = [] }) {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const accounts = [{ id: "acc-citi", name: "Citi Rewards", closed: false }];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context") return { accounts, categories: [], payees: [{ id: "p-misc", name: "Misc" }] };
                if (name === "search_memory") return { results: facts.map((text) => ({ text, score: 1 })) };
                if (name === "list_facts") return { facts };
                if (name === "resolve_merchant") return { payee: "Misc", source: "fallback" };
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
        // What the LLM returned on a real run: the merchant read loosely.
        const phase1 = {
            merchant: llmMerchant,
            amount_cents: -1234,
            date: "2026-10-22",
            currency: "SGD",
            account_id: "acc-citi",
            account_name: "Citi Rewards",
            raw_description: `SGD12.34 at ${llmMerchant}`,
            raw_merchant_descriptor: llmMerchant,
            notes: "",
            skip: false,
            reasoning: "Citi card",
            notify_message: "",
        };
        orch._llm.chat = vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(phase1) } }] });
        await orch.processEmail(1001, Buffer.from(RAW(details)), null, "Citi Alerts <alerts@citi.example>",
            "Citi Alerts - Credit Card/Ready Credit Transaction");
        return calls;
    }

    it.each(["AMAZE", "ACMESHOP63", "AMAZE* ACMESHOP63"])("uses the alert's descriptor when the LLM read %s", async (llmMerchant) => {
        const calls = await book({ details: "AMAZE* ACMESHOP63 S    SINGAPORE     SGP", llmMerchant });
        const resolve = calls.find((c) => c.name === "resolve_merchant");
        expect(resolve.args.merchant).toBe("AMAZE* ACMESHOP63 S SINGAPORE SGP");
        const insert = calls.find((c) => c.name === "insert_transaction");
        expect(insert.args.notes).toContain("AMAZE* ACMESHOP63 S SINGAPORE SGP");
    });

    it("books a remembered Amaze merchant whose key keeps the location", async () => {
        const calls = await book({
            details: "AMAZE* ACMENOODLE       SINGAPORE     SGP",
            llmMerchant: "ACMENOODLE",
            facts: ["AMAZE* ACMENOODLE SINGAPORE SGP maps to Food payee"],
        });
        expect(calls.some((c) => c.name === "resolve_merchant")).toBe(false);
        const insert = calls.find((c) => c.name === "insert_transaction");
        expect(insert.args.imported_description).toBe("Food");
    });
});
