/**
 * Issue #720: the Phase 3 "Remember this mapping?" offer, the exact-reference
 * helper, and the HTTP route that must not carry caller-supplied evidence.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("@xenova/transformers", () => ({ pipeline: vi.fn(), env: {} }));

import { exactReference } from "../src/bank-movement.js";

const DEPOSIT = (reference) =>
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
        "Amount: SGD 2.27",
        "Account that money was deposited in: (-166600)",
        `Reference: ${reference}`,
        "",
        "This is an auto-generated email. Please do not reply to this email.",
        "",
    ].join("\r\n");

// The first import of the orchestrator is slow (model and tool graph).
beforeAll(async () => {
    await import("../src/orchestrator.js");
}, 60000);

const JEV = { payee: "Bank Interest", source: "jev", runner_up: "Salary", confidence: 0.93 };

async function book({ raw = DEPOSIT("360 SAVE BONUS"), resolved = JEV, offer, notified = true, text = false } = {}) {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
        executeTool: vi.fn(async (name, args) => {
            calls.push({ name, args });
            if (name === "fetch_context")
                return {
                    accounts: [{ id: "ocbc-111", name: "OCBC 111", closed: false }],
                    categories: [],
                    payees: [{ id: "p1", name: "Bank Interest" }],
                };
            if (name === "search_memory")
                return { results: [{ text: "Account ending 166600 belongs to OCBC 111", score: 1 }] };
            if (name === "resolve_merchant") return resolved;
            if (name === "propose_learning") return offer ?? { offered: true, id: "AB23CD45" };
            if (name === "notify_user") return notified;
            if (name === "check_duplicate" || name === "check_schedule_collision") return false;
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
    if (text) {
        await orch.processText(raw);
    } else {
        await orch.processEmail(1075, Buffer.from(raw), null, "OCBC Alerts <alerts@ocbc.com>", "Deposit alert");
    }
    return { calls, tools };
}

const notice = (calls) => calls.filter((c) => c.name === "notify_user").map((c) => c.args.message).join("\n");

describe("exactReference", () => {
    it("ends the reference where the sender's line ended", () => {
        const lines = "Amount: SGD 2.27\nReference: 360 SAVE BONUS\nThis is an auto-generated email.";
        const flat = "Reference: 360 SAVE BONUS This is an auto-generated email.";
        expect(exactReference(lines, "360 SAVE BONUS This is an auto-generated email.")).toBe("360 SAVE BONUS");
        expect(flat).toContain("360 SAVE BONUS");
    });

    it("keeps the parser's value when the line text disagrees or is empty", () => {
        expect(exactReference("Reference: OTHER", "360 SAVE BONUS")).toBe("360 SAVE BONUS");
        expect(exactReference("", "360 SAVE BONUS")).toBe("360 SAVE BONUS");
        expect(exactReference("Reference:", "")).toBe("");
    });
});

describe("Phase 3 offer for a Jev payee (#720)", () => {
    it("offers to remember the exact descriptor, names the runner-up, and puts no id in the notification", async () => {
        const { calls } = await book();
        const offer = calls.find((c) => c.name === "propose_learning");
        expect(offer.args).toMatchObject({ descriptor: "360 SAVE BONUS", payee: "Bank Interest", runner_up: "Salary" });
        const message = notice(calls);
        expect(message).toContain('Remember "360 SAVE BONUS" as Bank Interest?');
        expect(message).toContain("runner-up Salary");
        expect(message).toContain("93% sure");
        expect(message).toContain("Nothing is saved until you confirm");
        expect(message).not.toContain("AB23CD45");
    });

    it("never writes a fact for a Jev result", async () => {
        const { calls } = await book();
        const learned = calls.filter((c) => c.name === "learn_fact").map((c) => c.args.fact);
        expect(learned.every((fact) => !/maps to/i.test(fact))).toBe(true);
        expect(calls.some((c) => c.name === "confirm_learning")).toBe(false);
    });

    it("books the transaction whether or not the offer is accepted later", async () => {
        const { calls } = await book();
        const insert = calls.find((c) => c.name === "insert_transaction");
        expect(insert.args.imported_description).toBe("Bank Interest");
    });

    it("offers nothing for a memory-sourced payee", async () => {
        const { calls } = await book({ resolved: { payee: "Bank Interest", source: "memory" } });
        expect(calls.some((c) => c.name === "propose_learning")).toBe(false);
        expect(notice(calls)).not.toContain("Remember");
    });

    it("withdraws the offer when the notification was not delivered", async () => {
        const { calls } = await book({ notified: false });
        expect(calls.find((c) => c.name === "withdraw_learning").args).toEqual({ id: "AB23CD45" });
    });

    it("still says the payee was matched, without an offer, when the descriptor is refused", async () => {
        const { calls } = await book({ offer: { offered: false, reason: "unusable_descriptor" } });
        const message = notice(calls);
        expect(message).toContain("Payee matched by AI");
        expect(message).not.toContain("Remember");
    });

    it("never offers the placeholder descriptor of a deposit with no usable reference", async () => {
        const { calls } = await book({ raw: DEPOSIT("0126100100114400") });
        expect(calls.some((c) => c.name === "propose_learning")).toBe(false);
        expect(notice(calls)).not.toContain("Remember");
        const insert = calls.find((c) => c.name === "insert_transaction");
        expect(insert.args.notes).toContain("0126100100114400");
    });

    it("sends the resolver no evidence and offers nothing for a Telegram text", async () => {
        const { calls } = await book({ raw: "Time of deposit: 6:50 AM\nAmount: SGD 2.27\nAccount that money was deposited in: (-166600)\nReference: 360 SAVE BONUS", text: true, resolved: { payee: "Misc", source: "fallback" } });
        const resolve = calls.find((c) => c.name === "resolve_merchant");
        if (resolve) expect(resolve.args.evidence).toBeUndefined();
        expect(calls.some((c) => c.name === "propose_learning")).toBe(false);
    });

    it("sends the resolver the email evidence but no raw MIME header block", async () => {
        const { calls } = await book();
        const resolve = calls.find((c) => c.name === "resolve_merchant");
        expect(resolve.args.evidence.text).not.toMatch(/MIME-Version|Content-Type/);
        expect(resolve.args).toMatchObject({ direction: "incoming", amount_cents: 227, currency: "SGD" });
    });
});
