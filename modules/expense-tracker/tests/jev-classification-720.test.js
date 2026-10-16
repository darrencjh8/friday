/**
 * Issue #720: an incoming OCBC deposit whose only identity is its Reference
 * line (`360 SAVE BONUS`) was booked as `Unidentified deposit` / `Misc`, its
 * reference dropped, and the payee resolver never consulted. The shared flow
 * now keeps the exact reference and the full email as evidence and lets the
 * payee resolver (memory, then Jev, then Misc) decide.
 */
import { describe, it, expect, vi } from "vitest";

// The embedding runtime needs a native image library this suite never uses.
vi.mock("@xenova/transformers", () => ({ pipeline: vi.fn(), env: {} }));

const RAW_DEPOSIT = [
    "From: OCBC Alerts <alerts@ocbc.com>",
    "To: holder@example.com",
    "Subject: Deposit alert",
    "Date: Fri, 9 Oct 2026 06:50:30 +0800",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Dear Valued Customer,",
    "",
    "A deposit was made in your account. Here are the details:",
    "",
    "Time of deposit: 6:50 AM",
    "Amount: SGD 2.27",
    "Account that money was deposited in: (-166600)",
    "Reference: 360 SAVE BONUS",
    "",
    "This is an auto-generated email. Please do not reply to this email.",
    "Visit ocbc.com for more information.",
    "",
].join("\r\n");

const ACCOUNTS = [{ id: "ocbc-111", name: "OCBC 111", closed: false }];
const PAYEES = [
    { id: "p-misc", name: "Misc" },
    { id: "p-interest", name: "Bank Interest" },
    { id: "p-ocbc-360", name: "OCBC 360", transfer_acct: "ocbc-360" },
];

async function bookDeposit({ resolve }) {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
        executeTool: vi.fn(async (name, args) => {
            calls.push({ name, args });
            if (name === "fetch_context")
                return { accounts: ACCOUNTS, categories: [], payees: PAYEES };
            if (name === "search_memory")
                return args.query === "360 SAVE BONUS"
                    ? { results: [] }
                    : { results: [{ text: "Account ending 166600 belongs to OCBC 111", score: 1 }] };
            if (name === "resolve_merchant") return resolve(args);
            if (name === "check_duplicate") return false;
            if (name === "check_schedule_collision") return false;
            if (name === "find_link_candidate") return { candidate: null, matches: 0 };
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
    const result = await orch.processEmail(1075, Buffer.from(RAW_DEPOSIT), null, "OCBC Alerts <alerts@ocbc.com>", "Deposit alert");
    return { result, calls };
}

describe("one-sided deposit classification (#720)", () => {
    it("ocbc 360 save bonus deposit reaches the payee resolver with its exact reference", async () => {
        const { calls } = await bookDeposit({ resolve: () => ({ payee: "Misc", source: "fallback" }) });
        const resolve = calls.find((c) => c.name === "resolve_merchant");
        expect(resolve, "the payee resolver must run for an unclassified deposit").toBeDefined();
        expect(resolve.args.merchant).toBe("360 SAVE BONUS");
        expect(resolve.args.evidence.text).toContain("Reference: 360 SAVE BONUS");
        expect(resolve.args.evidence.subject).toBe("Deposit alert");
    });

    it("books the resolver's payee and keeps the reference in the notes", async () => {
        const { calls } = await bookDeposit({
            resolve: () => ({ payee: "Bank Interest", source: "jev" }),
        });
        const insert = calls.find((c) => c.name === "insert_transaction");
        expect(insert.args).toMatchObject({ imported_description: "Bank Interest", amount_cents: 227 });
        expect(insert.args.notes).toContain("360 SAVE BONUS");
    });

    it("leaves Misc when the resolver has no confident answer", async () => {
        const { calls } = await bookDeposit({ resolve: () => ({ payee: "Misc", source: "fallback" }) });
        const insert = calls.find((c) => c.name === "insert_transaction");
        expect(insert.args.imported_description).toBe("Misc");
    });
});
