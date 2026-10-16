/**
 * Tests for processText — Telegram transaction entry path via 3-phase pipeline.
 * Silent mode: no notify_user, no mark_email_read, no IMAP context.
 */
import { describe, it, expect, vi } from "vitest";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { Config } from "../src/config.js";

function makeConfig(overrides = {}) {
    const defaults = {
        DEEPSEEK_API_KEY: "sk-test",
        ACTUAL_BUDGET_URL: "http://test:5006",
        ACTUAL_BUDGET_PASSWORD: "test-password",
        ACTUAL_PRIMARY_BUDGET_FILE: "Example SGD",
        ACTUAL_BUDGET_ENCRYPTION_PASSWORD: "",
        IMAP_HOST: "imap.example.com",
        IMAP_PORT: "993",
        IMAP_USERNAME: "test@example.com",
        IMAP_PASSWORD: "test-pass",
        OPENCLAW_GATEWAY_URL: "http://openclaw:18800",
        USER_NAME: "TestUser",
        SYSTEM_PROMPT_EXTRA: "",
        DEDUP_DB_PATH: ":memory:",
        STATEMENT_DB_PATH: ":memory:",
        MEMORY_PATH: "data/MEMORY.md",
        LOG_LEVEL: "INFO",
        ...overrides,
    };
    return new Config(defaults);
}

function makeMockTools(overrides = {}) {
    return {
        setEmailContext: vi.fn(),
        getToolSchemas: vi.fn(() => []),
        getPhase1ToolSchemas: vi.fn(() => []),
        executeTool: vi.fn(async (name) => {
            if (name === "search_memory") return { results: [] };
            if (name === "fetch_context")
                return {
                    accounts: [
                        { id: "acc-1", name: "Iota Freedom", closed: false },
                    ],
                    categories: [{ id: "cat-food", name: "Food" }],
                    payees: [{ id: "p-1", name: "Food" }],
                };
            if (name === "check_duplicate") return false;
            if (name === "insert_transaction") return { id: "txn-1" };
            return true;
        }),
        ...overrides,
    };
}

function fakePhase1Output(overrides = {}) {
    return {
        merchant: "KOUFU PTE LTD",
        amount_cents: -190,
        currency: "SGD",
        date: "2026-06-18",
        account_id: "acc-1",
        account_name: "Iota Freedom",
        budget_id: "Example SGD",
        action: "insert",
        payee_name: "",
        category_id: "",
        raw_description: "S$1.90 at KOUFU PTE LTD",
        notes: "",
        reasoning: "Matched Iota Freedom",
        notify_message: "S$1.90 at KOUFU PTE LTD, logged!",
        ...overrides,
    };
}

function fakePhase2Output(phase1, overrides = {}) {
    return {
        ...phase1,
        payee_name: "Food",
        category_id: "cat-food",
        ...overrides,
    };
}

describe("processText", () => {
    it("returns result without calling notify_user (silent mode)", async () => {
        const config = makeConfig();
        const tools = makeMockTools();
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output();
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        const result = await orch.processText(
            "KOUFU PTE LTD S$1.90 charged to your card",
        );

        expect(result.action).toBe("inserted");
        const notifyCalls = tools.executeTool.mock.calls.filter(
            ([name]) => name === "notify_user",
        );
        expect(notifyCalls.length).toBe(0);
    });

    it("processes without IMAP context (no email extraction)", async () => {
        const config = makeConfig();
        const tools = makeMockTools();
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({ merchant: "Shopee", amount_cents: -644 });
        const p2 = fakePhase2Output(p1, {
            payee_name: "Shopee",
            category_id: "cat-shop",
        });
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        const result = await orch.processText(
            "S$6.44 Shopee on Iota Freedom",
        );

        expect(tools.setEmailContext).not.toHaveBeenCalled();
        const markReadCalls = tools.executeTool.mock.calls.filter(
            ([name]) => name === "mark_email_read",
        );
        expect(markReadCalls.length).toBe(0);
        expect(result.action).toBe("inserted");
    });

    it("passes raw text directly (no email header parsing)", async () => {
        const config = makeConfig();
        const tools = makeMockTools();
        const orch = new AgentOrchestrator(config, tools);

        const rawPhoneText = "RM 45.50 at Lotus's";
        const p1 = fakePhase1Output({
            merchant: "Lotus's",
            amount_cents: -4550,
            currency: "MYR",
            budget_id: "Example MYR",
        });
        const p2 = fakePhase2Output(p1, {
            payee_name: "Groceries",
            category_id: "cat-grocery",
        });
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        const result = await orch.processText(rawPhoneText);

        expect(orch._runPhase1).toHaveBeenCalledWith(rawPhoneText);
        expect(result.action).toBe("inserted");
    });

    it("returns notified without notify_user when extraction fails", async () => {
        const config = makeConfig();
        const tools = makeMockTools();
        const orch = new AgentOrchestrator(config, tools);

        orch._runPhase1 = vi.fn().mockResolvedValue(null);

        const result = await orch.processText("garbage text");

        expect(result.action).toBe("notified");
        const notifyCalls = tools.executeTool.mock.calls.filter(
            ([name]) => name === "notify_user",
        );
        expect(notifyCalls.length).toBe(0);
    });

    it("returns duplicate without notify_user", async () => {
        const config = makeConfig();
        const tools = makeMockTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return true;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output();
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        const result = await orch.processText("KOUFU S$1.90");

        expect(result.action).toBe("duplicate");
        const notifyCalls = tools.executeTool.mock.calls.filter(
            ([name]) => name === "notify_user",
        );
        expect(notifyCalls.length).toBe(0);
    });

    it("returns inline notified when Phase 1 has no account_id", async () => {
        const config = makeConfig();
        const tools = makeMockTools();
        const orch = new AgentOrchestrator(config, tools);

        orch._runPhase1 = vi
            .fn()
            .mockResolvedValue(
                fakePhase1Output({ account_id: "", action: "insert" }),
            );

        const result = await orch.processText("S$5.00 at Unknown Place");

        expect(result.action).toBe("notified");
        expect(result.details).toContain("account");
        const notifyCalls = tools.executeTool.mock.calls.filter(
            ([name]) => name === "notify_user",
        );
        expect(notifyCalls.length).toBe(0);
    });
});
