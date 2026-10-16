/**
 * Mock-based tests for AgentOrchestrator 3-phase pipeline.
 */
import { describe, it, expect, vi } from "vitest";
import { AgentOrchestrator, LLMClient, DeepSeekClient, DOMAIN_BANK_MAP, bankFromSender } from "../src/orchestrator.js";
import { Config } from "../src/config.js";
import { dispatchEmail } from "../src/classify.js";
import { DedupJournal } from "../src/dedup.js";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { OWN_LEGAL_NAME_UPPER } from "./helpers/own-name.js";

function makeConfig(overrides = {}) {
    const defaults = {
        DEEPSEEK_API_KEY: "sk-test",
        ACTUAL_BUDGET_URL: "http://test:5006",
        ACTUAL_BUDGET_PASSWORD: "test-password",
        ACTUAL_PRIMARY_BUDGET_FILE: "test-budget",
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

// ── helpers ─────────────────────────────────────────────────────

function makeTools(overrides = {}) {
    return {
        setEmailContext: vi.fn(),
        getToolSchemas: vi.fn(() => []),
        executeTool: vi.fn(async () => true),
        ...overrides,
    };
}

function fakePhase1Output(overrides = {}) {
    return {
        merchant: "Toast Box",
        amount_cents: -1280,
        date: "2026-06-19",
        currency: "SGD",
        account_id: "acc-1",
        account_name: "DBS Nova",
        budget_id: "budget-sgd",
        action: "insert",
        payee_name: "",
        category_id: "",
        raw_description: "S$12.80 at Toast Box",
        notes: "",
        reasoning: "Matched DBS Nova",
        notify_message:
            "S$12.80 at Toast Box via DBS Nova on 2026-06-19, logged!",
        ...overrides,
    };
}

function fakePhase2Output(phase1, overrides = {}) {
    return {
        ...phase1,
        payee_name: "Toast Box",
        category_id: "cat-food",
        ...overrides,
    };
}

// ═══════════════════════════════════════════════════════════════════

describe("AgentOrchestrator", () => {
    it("constructs with config", () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);
        expect(orch).toBeDefined();
        expect(orch.tools).toBe(tools);
    });

    // ── processEmail (email path) ────────────────────────────────

    it("skips promotional email via Phase 1 skip", async () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);

        orch._runPhase1 = vi.fn().mockResolvedValue(
            fakePhase1Output({
                action: "skip",
                skip: true,
                reasoning: "Promo email",
            }),
        );

        const result = await orch.processEmail("test-1", "raw email");
        expect(result.action).toBe("skipped");
        expect(tools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
    });

    it("notifies when Phase 1 returns null", async () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);

        orch._runPhase1 = vi.fn().mockResolvedValue(null);

        const result = await orch.processEmail("test-2", "raw email");
        expect(result.action).toBe("notified");
        expect(tools.executeTool).toHaveBeenCalledWith(
            "notify_user",
            expect.anything(),
        );
        // Design §7.1: leave unread for retry — do NOT mark email read on uncertainty
        const markCalls = tools.executeTool.mock.calls.filter(
            (c) => c[0] === "mark_email_read",
        );
        expect(markCalls.length).toBe(0);
    });

    it("notifies when Phase 1 has no account_id", async () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);

        orch._runPhase1 = vi
            .fn()
            .mockResolvedValue(
                fakePhase1Output({ account_id: "", action: "insert" }),
            );

        const result = await orch.processEmail("test-3", "raw email");
        expect(result.action).toBe("notified");
        expect(tools.executeTool).toHaveBeenCalledWith(
            "notify_user",
            expect.anything(),
        );
        // Design §7.1: leave unread for retry — do NOT mark email read on uncertainty
        const markCalls = tools.executeTool.mock.calls.filter(
            (c) => c[0] === "mark_email_read",
        );
        expect(markCalls.length).toBe(0);
    });

    it("inserts transaction via full 3-phase flow", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output();
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        const result = await orch.processEmail("test-4", "raw email");

        expect(result.action).toBe("inserted");
        expect(tools.executeTool).toHaveBeenCalledWith(
            "insert_transaction",
            expect.anything(),
        );
        expect(tools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
        expect(tools.executeTool).toHaveBeenCalledWith(
            "notify_user",
            expect.anything(),
        );
    });

    // ── uncertainty paths never mark email read (design §7.1) ────

    it("does not mark email read when Phase 1 null + notify succeeds", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "notify_user") return true;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        orch._runPhase1 = vi.fn().mockResolvedValue(null);

        const result = await orch.processEmail("test-un1", "raw email");

        expect(result.action).toBe("notified");
        const markCalls = tools.executeTool.mock.calls.filter(
            (c) => c[0] === "mark_email_read",
        );
        expect(markCalls.length).toBe(0);
    });

    it("does not mark email read when Phase 1 no-account + notify succeeds", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "notify_user") return true;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        orch._runPhase1 = vi
            .fn()
            .mockResolvedValue(
                fakePhase1Output({ account_id: "", action: "insert" }),
            );

        const result = await orch.processEmail("test-un2", "raw email");

        expect(result.action).toBe("notified");
        const markCalls = tools.executeTool.mock.calls.filter(
            (c) => c[0] === "mark_email_read",
        );
        expect(markCalls.length).toBe(0);
    });

    it("returns notify_failed when Phase 1 null + notify_user fails", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "notify_user") return false;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        orch._runPhase1 = vi.fn().mockResolvedValue(null);

        const result = await orch.processEmail("test-nf1", "raw email");

        expect(result.action).toBe("notify_failed");
        expect(tools.executeTool).toHaveBeenCalledWith(
            "notify_user",
            expect.anything(),
        );
        const markCalls = tools.executeTool.mock.calls.filter(
            (c) => c[0] === "mark_email_read",
        );
        expect(markCalls.length).toBe(0);
    });

    it("returns notify_failed when Phase 1 no-account + notify_user fails", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "notify_user") return false;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        orch._runPhase1 = vi
            .fn()
            .mockResolvedValue(
                fakePhase1Output({ account_id: "", action: "insert" }),
            );

        const result = await orch.processEmail("test-nf2", "raw email");

        expect(result.action).toBe("notify_failed");
        const markCalls = tools.executeTool.mock.calls.filter(
            (c) => c[0] === "mark_email_read",
        );
        expect(markCalls.length).toBe(0);
    });

    it("skips mark_email_read when notify_user fails after successful insert", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "notify_user") return false;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output();
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        const result = await orch.processEmail("test-nf3", "raw email");

        // Transaction was inserted successfully
        expect(result.action).toBe("inserted");
        expect(tools.executeTool).toHaveBeenCalledWith(
            "insert_transaction",
            expect.anything(),
        );
        // But mark_email_read should NOT be called because notification failed
        const markCalls = tools.executeTool.mock.calls.filter(
            (c) => c[0] === "mark_email_read",
        );
        expect(markCalls.length).toBe(0);
    });

    // ── notify_message content assertions ────────────────────────

    it("notify_message includes merchant, amount, account, and date", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output();
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        await orch.processEmail("test-msg", "raw email");

        const notifyCall = tools.executeTool.mock.calls.find(
            (c) => c[0] === "notify_user",
        );
        const { message } = notifyCall[1] || {};
        expect(message).toContain("Toast Box");
        expect(message).toContain("S$");
        expect(message).toContain("DBS Nova");
        expect(message).toContain("2026-06-19");
    });

    it("insert notification is built from Phase 2's resolved payee/category, ignoring Phase 1's raw notify_message", async () => {
        // Phase 1 writes notify_message BEFORE Phase 2 resolves payee_name
        // and category_name, so it can never reflect what actually gets
        // booked. The system must always build the confirmation itself.
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({
            notify_message: "STALE PHASE-1 TEXT, ignore me",
        });
        const p2 = fakePhase2Output(p1, {
            payee_name: "Green Bowl",
            category_name: "Food",
        });
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        await orch.processEmail("test-resolved-payee", "raw email");

        const notifyCall = tools.executeTool.mock.calls.find(
            (c) => c[0] === "notify_user",
        );
        const { message } = notifyCall[1] || {};
        expect(message).toContain("Green Bowl");
        expect(message).toContain("→ Food");
        expect(message).not.toContain("STALE PHASE-1 TEXT");
    });

    it("falls back to the raw merchant text when the resolved payee is the generic Misc bucket", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({ merchant: "Weird POS Descriptor 4471" });
        const p2 = fakePhase2Output(p1, {
            payee_name: "Misc",
            category_name: undefined,
        });
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        await orch.processEmail("test-misc-fallback", "raw email");

        const notifyCall = tools.executeTool.mock.calls.find(
            (c) => c[0] === "notify_user",
        );
        const { message } = notifyCall[1] || {};
        expect(message).toContain("Weird POS Descriptor 4471");
        expect(message).not.toContain("→");
    });

    it("notify_user fallback includes account and date when notify_message is empty", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({ notify_message: "" });
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        await orch.processEmail("test-fallback", "raw email");

        const notifyCall = tools.executeTool.mock.calls.find(
            (c) => c[0] === "notify_user",
        );
        const { message } = notifyCall[1] || {};
        // Fallback should match LLM format: via account on date
        expect(message).toContain("Toast Box");
        expect(message).toContain("S$");
        expect(message).toContain("via DBS Nova");
        expect(message).toContain("2026-06-19");
    });

    it("notify_user fallback uses RM symbol for MYR currency", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({
            notify_message: "",
            currency: "MYR",
            amount_cents: -4600,
            account_name: "Maybank",
            date: "2026-06-20",
        });
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        await orch.processEmail("test-myr", "raw email");

        const notifyCall = tools.executeTool.mock.calls.find(
            (c) => c[0] === "notify_user",
        );
        const { message } = notifyCall[1] || {};
        expect(message).toContain("RM46.00");
        expect(message).toContain("via Maybank");
    });

    // ── category hint + insert failure notifications ────────────

    it("notify_user fallback includes category hint when category_name is set", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({ notify_message: "" });
        const p2 = fakePhase2Output(p1, { category_name: "Food" });
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        await orch.processEmail("test-cat", "raw email");

        const notifyCall = tools.executeTool.mock.calls.find(
            (c) => c[0] === "notify_user",
        );
        const { message } = notifyCall[1] || {};
        expect(message).toContain("→ Food");
    });

    it("notify_user fallback omits category hint when category_name is not set", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({ notify_message: "" });
        const p2 = fakePhase2Output(p1); // no category_name
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        await orch.processEmail("test-nocat", "raw email");

        const notifyCall = tools.executeTool.mock.calls.find(
            (c) => c[0] === "notify_user",
        );
        const { message } = notifyCall[1] || {};
        expect(message).not.toContain("→");
    });

    it("notifies user when insert_transaction fails", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction")
                    throw new Error("AB API down");
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output();
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        const result = await orch.processEmail("test-insfail", "raw email");

        expect(result.action).toBe("error");
        expect(result.details).toContain("AB API down");
        const notifyCall = tools.executeTool.mock.calls.find(
            (c) => c[0] === "notify_user",
        );
        expect(notifyCall).toBeDefined();
        expect(notifyCall[1].message).toContain("Failed to insert");
        expect(notifyCall[1].message).toContain("Toast Box");
        expect(notifyCall[1].message).not.toContain("merge them in Actual");
    });

    it("tells the user to merge an ambiguous payee instead of quoting payee_id (#551)", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction")
                    return {
                        error: 'Payee "Food" is ambiguous; pass payee_id (candidates: aaa, bbb).',
                        code: "AMBIGUOUS_PAYEE",
                    };
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output();
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        await orch.processEmail("test-ambiguous", "raw email");

        const notifyCall = tools.executeTool.mock.calls.find(
            (c) => c[0] === "notify_user",
        );
        expect(notifyCall).toBeDefined();
        // The raw refusal orders the model to pass payee_id; the human reading
        // the notification cannot act on that, so it carries the instruction.
        expect(notifyCall[1].message).toContain("merge them in Actual");
    });

    it("refuses the insert when Phase 1 extracted no amount (#508)", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name, args) => {
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction")
                    return args.amount_cents === undefined
                        ? { error: "amount_cents is required" }
                        : true;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({ amount_cents: undefined });
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        const result = await orch.processEmail("test-noamount", "raw email");

        expect(result.action).toBe("error");
        expect(result.details).toContain("amount_cents is required");
        const insertCall = tools.executeTool.mock.calls.find(
            (c) => c[0] === "insert_transaction",
        );
        // The absent amount must reach the tool as absent: defaulting it to 0
        // here is what booked a wrong-amount transaction.
        expect(insertCall[1].amount_cents).toBeUndefined();
    });

    it("does not treat a missing amount as a 0-cent duplicate (#508)", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name, args) => {
                if (name === "check_duplicate") return true;
                if (name === "insert_transaction")
                    return args.amount_cents === undefined
                        ? { error: "amount_cents is required" }
                        : true;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({ amount_cents: undefined });
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        const result = await orch.processEmail("test-nodup", "raw email");

        expect(result.action).toBe("error");
        // A 0-cent lookback could match an unrelated row and silently drop the
        // alert, so the duplicate check must not run without an amount.
        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "check_duplicate",
            expect.anything(),
        );
        const markCalls = tools.executeTool.mock.calls.filter(
            (c) => c[0] === "mark_email_read",
        );
        expect(markCalls.length).toBe(0);
    });

    it("still checks duplicates for a quoted integer amount (#508)", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return true;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({ amount_cents: "-1280" });
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        const result = await orch.processEmail("test-quoted", "raw email");

        // A quoted integer is bookable, so it must not bypass duplicate
        // detection: the duplicate branch returns before any insert.
        expect(result.action).toBe("duplicate");
        expect(tools.executeTool).toHaveBeenCalledWith(
            "check_duplicate",
            expect.objectContaining({ amount_cents: "-1280" }),
        );
        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "insert_transaction",
            expect.anything(),
        );
    });

    it("omits a malformed amount from the insert-failure notice (#508)", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction")
                    throw new Error(
                        "actual-api 400: Amount must be an integer number of cents",
                    );
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({ amount_cents: "1e3" });
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        await orch.processEmail("test-badamount", "raw email");

        const notify = tools.executeTool.mock.calls.find(
            (c) => c[0] === "notify_user",
        );
        // "1e3" is not a bookable amount, so the alert must not convert it into
        // a plausible-looking "SGD 10" figure.
        expect(notify[1].message).not.toContain("SGD");
        expect(notify[1].message).toContain("actual-api 400");
    });

    it("omits a malformed amount from the success notice and summary (#508)", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction") return { id: "txn-1" };
                if (name === "notify_user") return true;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        // A non-bookable amount only reaches Phase 3 through a direct caller,
        // but the notice must still not turn it into money.
        const p1 = fakePhase1Output({ amount_cents: "1e3" });
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        const result = await orch.processEmail("test-badamount-ok", "raw email");

        const notify = tools.executeTool.mock.calls.find(
            (c) => c[0] === "notify_user",
        );
        expect(notify[1].message).not.toContain("S$");
        expect(notify[1].message).toContain("at Toast Box");
        expect(result.action).toBe("inserted");
        expect(result.details).not.toContain("SGD");
    });

    it("retries when the extracted amount is not a bookable shape (#508)", async () => {
        const config = makeConfig();
        const payload = {
            merchant: "Toast Box",
            amount_cents: "1e3",
            date: new Date().toISOString().slice(0, 10),
            currency: "SGD",
            account_id: "acc-1",
            action: "insert",
        };
        const tools = makeTools({
            getPhase1ToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(async (name) => {
                if (name === "fetch_context")
                    return {
                        accounts: [
                            { id: "acc-1", name: "DBS Nova", closed: false },
                        ],
                        categories: [],
                        payees: [],
                    };
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);
        orch._llm.chat = vi.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify(payload) } }],
        });

        const result = await orch._runPhase1("raw email body", {
            receivedAt: new Date().toISOString(),
        });

        // "1e3" is an extraction failure, not money: the pipeline retries and
        // gives up rather than letting Phase 2 coerce it into a booking.
        expect(result).toBeNull();
        expect(orch._llm.chat.mock.calls.length).toBeGreaterThan(1);
    });

    it.each([
        ["null", null],
        ["an empty string", ""],
        ["true", true],
        ["an array", [500]],
        ['the string "1e3"', "1e3"],
    ])(
        "refuses an LLM movement whose amount is %s (#508)",
        async (_label, amount) => {
            const orch = new AgentOrchestrator(makeConfig(), makeTools());
            // Resolution is a separate concern with its own coverage; stub it so
            // the extractor's own amount handling is what is asserted.
            orch._resolveMovementToOutput = vi.fn(async (m) => m);
            orch._llm.chat = vi.fn().mockResolvedValue({
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                amount,
                                currency: "SGD",
                                direction: "outgoing",
                                occurred_at: "2026-09-01T01:05:00+08:00",
                                from_account: "Vista (-166600)",
                                to_account: "Example Trust (-222000)",
                            }),
                        },
                    },
                ],
            });

            const movement = await orch._llmExtractMovement(
                "raw email body",
                "OCBC",
                "2026-09-01T01:05:00+08:00",
            );

            // A non-shape amount is an extraction failure, not money: Number()
            // would have made null/""/true/[500]/"1e3" bookable (#508).
            expect(movement).toBeNull();
            expect(orch._resolveMovementToOutput).not.toHaveBeenCalled();
        },
    );

    it("still extracts a plain decimal movement amount (#508)", async () => {
        const orch = new AgentOrchestrator(makeConfig(), makeTools());
        orch._resolveMovementToOutput = vi.fn(async (m) => m);
        orch._llm.chat = vi.fn().mockResolvedValue({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            amount: "14.25",
                            currency: "SGD",
                            direction: "outgoing",
                            occurred_at: "2026-09-01T01:05:00+08:00",
                            from_account: "Vista (-166600)",
                            to_account: "Example Trust (-222000)",
                        }),
                    },
                },
            ],
        });

        const movement = await orch._llmExtractMovement(
            "raw email body",
            "OCBC",
            "2026-09-01T01:05:00+08:00",
        );

        expect(movement.amount_cents).toBe(-1425);
    });

    it("does not mark email read when insert_transaction fails", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction")
                    throw new Error("AB API down");
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output();
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        await orch.processEmail("test-insfail2", "raw email");

        const markCalls = tools.executeTool.mock.calls.filter(
            (c) => c[0] === "mark_email_read",
        );
        expect(markCalls.length).toBe(0);
    });

    it("treats a returned insert error as a failed insert (#483)", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "reserve_transfer")
                    return { status: "reserved", entry: { id: "resv-1" } };
                // A transfer inserts only after reading the far side (#598);
                // this budget has no far row, so the insert goes ahead.
                if (name === "find_link_candidate")
                    return { candidate: null, matches: 0 };
                if (name === "insert_transaction")
                    return {
                        error: 'Payee ID "p-transfer" not found in payee list.',
                    };
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output();
        // A transfer carries a reservation, so the failure must not complete it.
        const p2 = fakePhase2Output(p1, {
            payee_id: "p-transfer",
            _transfer: { source_account_id: "a-1", amount_cents: 3000 },
        });
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        const result = await orch.processEmail("test-inserr", "raw email");

        expect(result.action).toBe("error");
        expect(result.details).toContain("p-transfer");
        const notifyCall = tools.executeTool.mock.calls.find(
            (c) => c[0] === "notify_user",
        );
        expect(notifyCall[1].message).toContain("Failed to insert");
        const markCalls = tools.executeTool.mock.calls.filter(
            (c) => c[0] === "mark_email_read",
        );
        expect(markCalls.length).toBe(0);
        const completeCalls = tools.executeTool.mock.calls.filter(
            (c) => c[0] === "complete_transfer",
        );
        expect(completeCalls.length).toBe(0);
    });

    // ── Sender / Subject header prepending for Phase 1 account matching ──

    it("prepends Email-Sender and Subject headers to emailText for Phase 1", async () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output();
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        await orch.processEmail(
            "test-headers",
            "raw email body",
            null,
            "alerts.dbs.com",
            "Card Transaction Alert for 7111",
        );

        const phase1Arg = orch._runPhase1.mock.calls[0][0];
        expect(phase1Arg).toContain("Email-Sender: alerts.dbs.com");
        expect(phase1Arg).toContain("Subject: Card Transaction Alert for 7111");
        expect(phase1Arg).toContain("raw email body");
        // Headers should appear before body. Does NOT prepend "From:".
        expect(phase1Arg).not.toMatch(/^From:\s/);
        const fromIdx = phase1Arg.indexOf("Email-Sender:");
        const bodyIdx = phase1Arg.indexOf("raw email body");
        expect(fromIdx).toBeLessThan(bodyIdx);
    });

    it("excludes Email-Sender header when sender is empty", async () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);

        orch._runPhase1 = vi.fn().mockResolvedValue(fakePhase1Output());
        orch._resolvePhase2 = vi.fn().mockResolvedValue(fakePhase2Output());

        await orch.processEmail(
            "test-no-from",
            "raw email body",
            null,
            "",
            "Card Alert",
        );

        const phase1Arg = orch._runPhase1.mock.calls[0][0];
        expect(phase1Arg).not.toContain("Email-Sender:");
        expect(phase1Arg).toContain("Subject: Card Alert");
    });

    it("excludes Subject header when subject is empty", async () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);

        orch._runPhase1 = vi.fn().mockResolvedValue(fakePhase1Output());
        orch._resolvePhase2 = vi.fn().mockResolvedValue(fakePhase2Output());

        await orch.processEmail(
            "test-no-subject",
            "raw email body",
            null,
            "alerts.dbs.com",
            "",
        );

        const phase1Arg = orch._runPhase1.mock.calls[0][0];
        expect(phase1Arg).toContain("Email-Sender: alerts.dbs.com");
        expect(phase1Arg).not.toContain("Subject:");
    });

    it("handles undefined sender and subject gracefully — no Email-Sender or Subject", async () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);

        orch._runPhase1 = vi.fn().mockResolvedValue(fakePhase1Output());
        orch._resolvePhase2 = vi.fn().mockResolvedValue(fakePhase2Output());

        // Old signature — no from/subject (backward compat)
        await orch.processEmail("test-backcompat", "raw email body", null);

        const phase1Arg = orch._runPhase1.mock.calls[0][0];
        expect(phase1Arg).not.toContain("Email-Sender:");
        expect(phase1Arg).not.toContain("Subject:");
        expect(phase1Arg).toContain("raw email body");
    });

    it("processText does NOT include sender headers", async () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);

        orch._runPhase1 = vi.fn().mockResolvedValue(fakePhase1Output());
        orch._resolvePhase2 = vi.fn().mockResolvedValue(fakePhase2Output());

        await orch.processText("Telegram: S$12.80 at Toast Box");

        const phase1Arg = orch._runPhase1.mock.calls[0][0];
        expect(phase1Arg).not.toContain("Email-Sender:");
        expect(phase1Arg).not.toContain("Subject:");
        expect(phase1Arg).toBe("Telegram: S$12.80 at Toast Box");
    });
});

// ── Auto-learn: learn_fact → update_fact on contradiction ────

describe("category assignment is not auto-learned", () => {
    it("does not persist a category inferred for a merchant", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "fetch_context")
                    return { categories: [{ id: "cat-cafe", name: "Cafe" }] };
                if (name === "search_memory") return { results: [] };
                if (name === "learn_fact")
                    return {
                        added: false,
                        skipped: true,
                        reason: "contradiction",
                        existing: "Toast Box maps to Food category",
                    };
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);
        orch._runPhase1 = vi.fn().mockResolvedValue(
            fakePhase1Output({
                payee_name: "Toast Box",
                category_id: "",
            }),
        );

        // Don't mock _resolvePhase2 — let it run real code to test the auto-learn path.
        // Mock the LLM call for the category picker.
        orch._llm = {
            chat: vi.fn().mockResolvedValue({
                choices: [
                    { message: { content: '{"category_id": "cat-cafe"}' } },
                ],
            }),
        };

        await orch.processEmail("test-al1", "raw email");

        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "learn_fact",
            expect.objectContaining({ fact: expect.stringContaining("category") }),
        );
        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "update_fact",
            expect.anything(),
        );
    });

    it("does not persist a second independently inferred category", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "fetch_context")
                    return { categories: [{ id: "cat-food", name: "Food" }] };
                if (name === "search_memory") return { results: [] };
                if (name === "learn_fact")
                    return { added: true, skipped: false };
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);
        orch._runPhase1 = vi.fn().mockResolvedValue(
            fakePhase1Output({
                payee_name: "New Merchant",
                category_id: "",
            }),
        );
        orch._llm = {
            chat: vi.fn().mockResolvedValue({
                choices: [
                    { message: { content: '{"category_id": "cat-food"}' } },
                ],
            }),
        };

        await orch.processEmail("test-al2", "raw email");

        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "learn_fact",
            expect.objectContaining({ fact: expect.stringContaining("category") }),
        );
        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "update_fact",
            expect.anything(),
        );
    });

    it("does NOT overwrite a conflicting account-type fact (issue #331)", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name, args) => {
                if (name === "check_duplicate") return false;
                if (name === "fetch_context")
                    return { categories: [{ id: "cat-misc", name: "Misc" }] };
                if (
                    name === "learn_fact" &&
                    args?.fact?.includes("is a bank account")
                )
                    return {
                        added: false,
                        skipped: true,
                        reason: "contradiction",
                        existing: "DBS Nova is a debit card account",
                    };
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({
            account_name: "DBS Nova",
            payee_name: "Toast Box",
            category_id: "cat-misc",
        });
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        await orch.processEmail("test-al3", "raw email");

        // The account type is written once and never overwritten from a
        // booking: doing so let the stored type oscillate with the alert
        // stream, which flips the sign of the next purchase and would undo the
        // cleanup of a wrong type fact. A contradiction is logged instead.
        const learnCalls = tools.executeTool.mock.calls.filter(
            (c) => c[0] === "learn_fact",
        );
        // Positive control. Without it this test also passes when no fact is
        // learned at all, which is the regression it exists to catch.
        expect(learnCalls).toHaveLength(1);
        expect(learnCalls[0][1]).toEqual({
            fact: "DBS Nova is a bank account",
            budget_id: "budget-sgd",
        });
        // Filter form, not `not.toHaveBeenCalledWith`: the account-type block
        // cannot call `update_fact` at all, and a specific `old_text` matcher
        // would also pass for any other argument. This is the assertion the
        // sibling category test already uses.
        const updateCalls = tools.executeTool.mock.calls.filter(
            (c) => c[0] === "update_fact",
        );
        expect(updateCalls).toHaveLength(0);
    });

    it("learns a credit-card account type when the sign was flipped (issue #331)", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "fetch_context")
                    return { categories: [{ id: "cat-misc", name: "Misc" }] };
                return { added: true };
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        // The derived type drives the sign of the next booking, so it is pinned
        // separately from the sign-preserving case above.
        const p1 = fakePhase1Output({
            account_name: "DBS Nova",
            payee_name: "Toast Box",
            category_id: "cat-misc",
            _sign_flipped: true,
        });
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        await orch.processEmail("test-al4", "raw email");

        const learnCalls = tools.executeTool.mock.calls.filter(
            (c) => c[0] === "learn_fact",
        );
        expect(learnCalls).toHaveLength(1);
        expect(learnCalls[0][1]).toEqual({
            fact: "DBS Nova is a credit card account",
            budget_id: "budget-sgd",
        });
    });

    it("silently swallows errors from learn_fact/update_fact without crashing", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "learn_fact") throw new Error("learn boom");
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({
            account_name: "Test Account",
            payee_name: "Toast Box",
            category_id: "cat-food",
        });
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        // Should not throw — learn_fact failure is caught
        const result = await orch.processEmail("test-al4", "raw email");
        expect(result.action).toBe("inserted");
    });
});

// ── Fix 2: bankFromSender + DOMAIN_BANK_MAP (#263) ──────────────

describe("bankFromSender", () => {
    it("returns OCBC for Notifications@ocbc.com", () => {
        expect(bankFromSender("Notifications@ocbc.com")).toBe("OCBC");
    });

    it("returns DBS for alerts@dbs.com", () => {
        expect(bankFromSender("alerts@dbs.com")).toBe("DBS");
    });

    it("returns UOB for noreply@uobgroup.com", () => {
        expect(bankFromSender("noreply@uobgroup.com")).toBe("UOB");
    });

    it("returns null for unknown domain", () => {
        expect(bankFromSender("support@unknown.com")).toBeNull();
    });

    it("returns null for empty/null input", () => {
        expect(bankFromSender(null)).toBeNull();
        expect(bankFromSender("")).toBeNull();
    });

    it("is case-insensitive", () => {
        expect(bankFromSender("ALERTS@DBS.COM")).toBe("DBS");
    });
});

describe("DOMAIN_BANK_MAP", () => {
    it("covers all banks listed in issue #263", () => {
        const expectedBanks = ["OCBC", "DBS", "UOB", "HSBC", "Trust", "SC", "Maybank", "CIMB", "Ryt"];
        const mappedBanks = Object.values(DOMAIN_BANK_MAP);
        for (const bank of expectedBanks) {
            expect(mappedBanks).toContain(bank);
        }
    });
});

// ── Fix 2: domain-based account pre-filter in Phase 1 (#263) ────

describe("domain account pre-filter", () => {
    it("filters fetch_context accounts to sender bank when senderBank is set", async () => {
        const config = makeConfig();
        const allAccounts = [
            { id: "acc-ocbc", name: "OCBC 111", closed: false },
            { id: "acc-dbs", name: "DBS Account", closed: false },
            { id: "acc-uob", name: "UOB Unity", closed: false },
        ];

        const toolCallsToLlm = [];
        const tools = makeTools({
            getPhase1ToolSchemas: () => [
                { type: "function", function: { name: "fetch_context", parameters: {} } },
            ],
            executeTool: vi.fn(async (name) => {
                if (name === "fetch_context")
                    return { accounts: allAccounts, categories: [], payees: [] };
                if (name === "search_memory") return { results: [] };
                return true;
            }),
        });

        const orch = new AgentOrchestrator(config, tools);
        // Mock LLM to make a fetch_context tool call, then return valid JSON
        let callCount = 0;
        orch._llm = {
            chat: vi.fn(async (messages) => {
                callCount++;
                if (callCount === 1) {
                    // First call: LLM requests fetch_context
                    return {
                        choices: [{
                            message: {
                                tool_calls: [{
                                    id: "tc-1",
                                    function: { name: "fetch_context", arguments: '{"budget_id":"test-budget"}' },
                                }],
                            },
                        }],
                    };
                }
                // Second call: capture what was sent to LLM as tool result
                const toolMsg = messages.find((m) => m.role === "tool");
                if (toolMsg) toolCallsToLlm.push(JSON.parse(toolMsg.content));
                return {
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                merchant: "Test",
                                amount_cents: -100,
                                date: new Date().toISOString().slice(0, 10),
                                currency: "SGD",
                                account_id: "acc-ocbc",
                                account_name: "OCBC 111",
                                skip: false,
                            }),
                        },
                    }],
                };
            }),
        };

        await orch._runPhase1("From: Notifications@ocbc.com\nSubject: OCBC Alert\n\nDeposit", { senderBank: "OCBC" });

        // The tool result sent to LLM should only contain OCBC accounts
        expect(toolCallsToLlm.length).toBe(1);
        expect(toolCallsToLlm[0].accounts).toHaveLength(1);
        expect(toolCallsToLlm[0].accounts[0].name).toBe("OCBC 111");
    });

    it("passes all accounts when senderBank is null (unknown domain)", async () => {
        const config = makeConfig();
        const allAccounts = [
            { id: "acc-ocbc", name: "OCBC 111", closed: false },
            { id: "acc-dbs", name: "DBS Account", closed: false },
        ];

        const toolCallsToLlm = [];
        const tools = makeTools({
            getPhase1ToolSchemas: () => [
                { type: "function", function: { name: "fetch_context", parameters: {} } },
            ],
            executeTool: vi.fn(async (name) => {
                if (name === "fetch_context")
                    return { accounts: allAccounts, categories: [], payees: [] };
                if (name === "search_memory") return { results: [] };
                return true;
            }),
        });

        const orch = new AgentOrchestrator(config, tools);
        let callCount = 0;
        orch._llm = {
            chat: vi.fn(async (messages) => {
                callCount++;
                if (callCount === 1) {
                    return {
                        choices: [{
                            message: {
                                tool_calls: [{
                                    id: "tc-1",
                                    function: { name: "fetch_context", arguments: '{"budget_id":"test-budget"}' },
                                }],
                            },
                        }],
                    };
                }
                const toolMsg = messages.find((m) => m.role === "tool");
                if (toolMsg) toolCallsToLlm.push(JSON.parse(toolMsg.content));
                return {
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                merchant: "Test",
                                amount_cents: -100,
                                date: new Date().toISOString().slice(0, 10),
                                currency: "SGD",
                                account_id: "acc-ocbc",
                                account_name: "OCBC 111",
                                skip: false,
                            }),
                        },
                    }],
                };
            }),
        };

        await orch._runPhase1("From: unknown@random.com\n\nSome email", { senderBank: null });

        // All accounts should be passed through
        expect(toolCallsToLlm.length).toBe(1);
        expect(toolCallsToLlm[0].accounts).toHaveLength(2);
    });
});

// ── Bill payment / transfer email pre-parser (#313) ──────────

describe("bill payment pre-parser", () => {
    const today = new Date().toISOString().slice(0, 10);

    const dbsBillPaymentEmail = [
        "Email-Sender: ibanking.alert@dbs.com",
        "Subject: digibank Alert - Successful bill payment",
        "",
        "Date: 01 Aug 11:26 (SGT)",
        "Amount: SGD 104.21",
        "From: My Account (A/C ending 7222)",
        "To: Nova (Ref ending 7111)",
    ].join("\n");

    it("parses DBS bill payment deterministically, bypassing LLM", async () => {
        const config = makeConfig();
        const allAccounts = [
            { id: "acc-dbs-main", name: "DBS My Account 7222", closed: false },
            { id: "acc-dbs-nova", name: "DBS Nova Card", closed: false },
        ];
        let llmCalled = false;
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "search_memory") return { results: [] };
                if (name === "fetch_context")
                    return { accounts: allAccounts, categories: [], payees: [] };
                return true;
            }),
        });

        const orch = new AgentOrchestrator(config, tools);
        orch._llm = { chat: vi.fn(() => { llmCalled = true; throw new Error("LLM should not be called"); }) };

        const result = await orch._runPhase1(dbsBillPaymentEmail, { senderBank: "DBS" });

        expect(llmCalled).toBe(false);
        expect(result).toBeDefined();
        expect(result.action).toBe("insert");
        expect(result.merchant).toBe("Nova");
        expect(result.amount_cents).toBe(-10421);
        expect(result.currency).toBe("SGD");
        expect(result.account_id).toBe("acc-dbs-main");
        expect(result.account_name).toBe("DBS My Account 7222");
        expect(result.budget_id).toBe("test-budget");
    });

    it("falls through to LLM for non-bill-payment emails", async () => {
        const config = makeConfig();
        let llmCalled = false;
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "search_memory") return { results: [] };
                if (name === "fetch_context")
                    return { accounts: [{ id: "acc-1", name: "DBS Account", closed: false }], categories: [], payees: [] };
                return true;
            }),
        });

        const orch = new AgentOrchestrator(config, tools);
        orch._llm = {
            chat: vi.fn(async () => {
                llmCalled = true;
                return {
                    choices: [{ message: { content: JSON.stringify({
                        merchant: "Toast Box", amount_cents: -1280,
                        date: today, currency: "SGD",
                        account_id: "acc-1", account_name: "DBS Account",
                        skip: false, reasoning: "test"
                    }) } }],
                };
            }),
        };

        const result = await orch._runPhase1("Email-Sender: alerts@dbs.com\nSubject: Card Alert\n\nSGD 12.80 at Toast Box", { senderBank: "DBS" });

        expect(llmCalled).toBe(true);
        expect(result.merchant).toBe("Toast Box");
    });

    it("matches source account through an identity fact, not display-name suffix", async () => {
        const config = makeConfig();
        const allAccounts = [
            { id: "acc-other", name: "DBS Savings", closed: false },
            { id: "acc-7222", name: "DBS Current 7222", closed: false },
        ];
        let llmCalled = false;
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "search_memory") return { results: [
                    { text: "Account ending 7222 belongs to DBS Current 7222", score: 1 },
                ] };
                if (name === "fetch_context")
                    return { accounts: allAccounts, categories: [], payees: [] };
                return true;
            }),
        });

        const orch = new AgentOrchestrator(config, tools);
        orch._llm = { chat: vi.fn(() => { llmCalled = true; throw new Error("LLM should not be called"); }) };

        const result = await orch._runPhase1(dbsBillPaymentEmail, { senderBank: "DBS" });

        expect(llmCalled).toBe(false);
        expect(result.account_id).toBe("acc-7222");
        expect(result.account_name).toBe("DBS Current 7222");
    });

    it("falls through when a legacy bill-payment identity resolves only to a closed account", async () => {
        const config = makeConfig();
        const allAccounts = [
            { id: "acc-7222", name: "DBS Old 7222", closed: true },
        ];
        let llmCalled = false;
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "search_memory") return { results: [
                    { text: "Account ending 7222 belongs to DBS Old 7222", score: 1 },
                ] };
                if (name === "fetch_context")
                    return { accounts: allAccounts, categories: [], payees: [] };
                return true;
            }),
        });

        const orch = new AgentOrchestrator(config, tools);
        // A deterministic failure stands in for "the LLM answered unusably";
        // a bare Error escaping chat() now counts as an outage (#694).
        orch._llm = { chat: vi.fn(() => { llmCalled = true; throw Object.assign(new Error("LLM unusable"), { deterministic: true }); }) };

        const result = await orch._runPhase1(dbsBillPaymentEmail, { senderBank: "DBS" });

        expect(result).toBeNull();
        expect(llmCalled).toBe(true);
    });

    it("handles non-DBS From/To format without crashing", async () => {
        const config = makeConfig();
        let llmCalled = false;
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "search_memory") return { results: [] };
                if (name === "fetch_context")
                    return { accounts: [{ id: "acc-1", name: "OCBC 111", closed: false }], categories: [], payees: [] };
                return true;
            }),
        });

        const orch = new AgentOrchestrator(config, tools);
        orch._llm = {
            chat: vi.fn(async () => {
                llmCalled = true;
                return {
                    choices: [{ message: { content: JSON.stringify({
                        merchant: "Test", amount_cents: -500,
                        date: today, currency: "SGD",
                        account_id: "acc-1", account_name: "OCBC 111",
                        skip: false, reasoning: "test"
                    }) } }],
                };
            }),
        };

        // Email from another bank with different format
        const emailText = "Email-Sender: noreply@ocbc.com\nSubject: Transfer\n\nYou have transferred SGD 50.00 to account 1234";
        const result = await orch._runPhase1(emailText, { senderBank: "OCBC" });

        expect(llmCalled).toBe(true);
        expect(result.merchant).toBe("Test");
    });
});

// ── Fix 3: date fallback when email body has no date (#263) ─────

describe("_emailBodyHasDate", () => {
    let orch;
    beforeAll(() => {
        const config = makeConfig();
        const tools = makeTools();
        orch = new AgentOrchestrator(config, tools);
    });

    it("returns true for YYYY-MM-DD in body", () => {
        expect(orch._emailBodyHasDate("From: x\nSubject: y\n\nTransaction on 2026-07-01")).toBe(true);
    });

    it("returns true for DD/MM/YYYY in body", () => {
        expect(orch._emailBodyHasDate("From: x\n\nDate: 01/07/2026")).toBe(true);
    });

    it("returns true for DD Mon YYYY in body", () => {
        expect(orch._emailBodyHasDate("From: x\n\n18 Jun 2026 deposit")).toBe(true);
    });

    it("returns true for Mon DD, YYYY in body", () => {
        expect(orch._emailBodyHasDate("From: x\n\nJune 18, 2026")).toBe(true);
    });

    it("returns false when body has only time, no date", () => {
        expect(orch._emailBodyHasDate("From: Notifications@ocbc.com\nSubject: OCBC Alert\n\nTime of deposit: 11:13 AM\nAmount: SGD 16.00")).toBe(false);
    });

    it("returns false for empty body", () => {
        expect(orch._emailBodyHasDate("")).toBe(false);
    });

    it("ignores dates in the From/Subject header block", () => {
        // Date appears ONLY in headers, not in body
        expect(orch._emailBodyHasDate("From: alert-2026-07-01@bank.com\nSubject: Alert 2026-07-01\n\nAmount: SGD 10.00")).toBe(false);
    });
});

// ── Phase 1 memory retrieval (LLM-directed): facts flow via tool messages ──

describe("Phase 1 memory retrieval (LLM-directed)", () => {
    const today = new Date().toISOString().slice(0, 10);

    function phase1Tools(executeTool) {
        return makeTools({
            getPhase1ToolSchemas: () => [
                { type: "function", function: { name: "fetch_context", parameters: {} } },
                { type: "function", function: { name: "search_memory", parameters: {} } },
            ],
            executeTool,
        });
    }
    function toolCall(name, args) {
        return {
            tool_calls: [
                { id: "tc-1", function: { name, arguments: JSON.stringify(args || {}) } },
            ],
        };
    }
    function json(content) {
        return { choices: [{ message: { content: JSON.stringify(content) } }] };
    }
    const baseOut = (accountId, accountName) => ({
        merchant: "Toast Box",
        amount_cents: -1280,
        date: today,
        currency: "SGD",
        account_id: accountId,
        account_name: accountName,
        skip: false,
    });

    it("delivers search_memory results to the LLM as tool messages", async () => {
        const config = makeConfig();
        let capturedMessages = null;
        const tools = phase1Tools(vi.fn(async (name) => {
            if (name === "fetch_context")
                return { accounts: [{ id: "acc-nova", name: "DBS Nova Card", closed: false }], categories: [], payees: [] };
            if (name === "search_memory")
                return { results: [{ text: "Card ending 7111 belongs to DBS Nova Card", score: 0.85 }] };
            return true;
        }));

        const orch = new AgentOrchestrator(config, tools);
        orch._llm = {
            chat: vi
                .fn()
                .mockImplementationOnce(async (messages) => {
                    capturedMessages = messages;
                    return { choices: [{ message: toolCall("search_memory", { query: "7111" }) }] };
                })
                .mockResolvedValueOnce(json(baseOut("acc-nova", "DBS Nova Card"))),
        };

        const result = await orch._runPhase1(
            "From: alerts@dbs.com\nSubject: Card Transaction Alert for 7111\n\nS$12.80 charged",
            { senderBank: "DBS" },
        );

        expect(result.account_id).toBe("acc-nova");
        // The LLM asked for facts and received them as a tool message
        const toolMsgs = capturedMessages.filter((m) => m.role === "tool");
        expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
        expect(JSON.stringify(toolMsgs)).toContain("Card ending 7111 belongs to DBS Nova Card");
        // No pre-fetch injection into the system prompt anymore
        const sysPrompt = capturedMessages.find((m) => m.role === "system")?.content;
        expect(sysPrompt).not.toContain("KNOWN CARD SUFFIXES (from memory");
    });

    it("delivers empty results when memory has no facts", async () => {
        const config = makeConfig();
        let capturedMessages = null;
        const tools = phase1Tools(vi.fn(async (name) => {
            if (name === "fetch_context")
                return { accounts: [{ id: "acc-1", name: "DBS Account", closed: false }], categories: [], payees: [] };
            if (name === "search_memory") return { results: [] };
            return true;
        }));

        const orch = new AgentOrchestrator(config, tools);
        orch._llm = {
            chat: vi
                .fn()
                .mockImplementationOnce(async (messages) => {
                    capturedMessages = messages;
                    return { choices: [{ message: toolCall("search_memory", { query: "7111" }) }] };
                })
                .mockResolvedValueOnce(json(baseOut("acc-1", "DBS Account"))),
        };

        const result = await orch._runPhase1(
            "From: alerts@dbs.com\nSubject: Transfer Alert\n\nTransfer completed",
            { senderBank: "DBS" },
        );

        expect(result.account_id).toBe("acc-1");
        const toolMsgs = capturedMessages.filter((m) => m.role === "tool");
        expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
        expect(toolMsgs[0].content).toContain('"results":[]');
    });

    it("overrides account when LLM picks wrong account despite retrieved suffix facts", async () => {
        const config = makeConfig();
        const tools = phase1Tools(vi.fn(async (name) => {
            if (name === "fetch_context")
                return {
                    accounts: [
                        { id: "acc-nova", name: "DBS Nova Card", closed: false },
                        { id: "acc-alt", name: "DBS Vista Card", closed: false },
                    ],
                    categories: [],
                    payees: [],
                };
            if (name === "search_memory")
                return { results: [{ text: "Card ending 7111 belongs to DBS Nova Card", score: 0.85 }] };
            return true;
        }));

        const orch = new AgentOrchestrator(config, tools);
        orch._llm = {
            chat: vi
                .fn()
                .mockResolvedValueOnce({ choices: [{ message: toolCall("search_memory", { query: "7111" }) }] })
                // LLM picks the WRONG account (Vista instead of Nova)
                .mockResolvedValueOnce(json(baseOut("acc-alt", "DBS Vista Card"))),
        };

        const result = await orch._runPhase1(
            "From: alerts@dbs.com\nSubject: Card Transaction Alert for 7111\n\nS$12.80 charged",
            { senderBank: "DBS" },
        );

        // Safety net overrides from cached tool results
        expect(result).not.toBeNull();
        expect(result.account_id).toBe("acc-nova");
        expect(result.account_name).toBe("DBS Nova Card");
    });

    it("keeps LLM pick when no suffix facts were retrieved", async () => {
        const config = makeConfig();
        const tools = phase1Tools(vi.fn(async (name) => {
            if (name === "fetch_context")
                return {
                    accounts: [
                        { id: "acc-nova", name: "DBS Nova Card", closed: false },
                        { id: "acc-alt", name: "DBS Vista Card", closed: false },
                    ],
                    categories: [],
                    payees: [],
                };
            if (name === "search_memory") return { results: [] };
            return true;
        }));

        const orch = new AgentOrchestrator(config, tools);
        orch._llm = {
            chat: vi
                .fn()
                .mockResolvedValueOnce({ choices: [{ message: toolCall("fetch_context", {}) }] })
                .mockResolvedValueOnce(json(baseOut("acc-alt", "DBS Vista Card"))),
        };

        const result = await orch._runPhase1(
            "From: alerts@dbs.com\nSubject: Card Alert\n\nS$12.80 charged",
            { senderBank: "DBS" },
        );

        expect(result.account_id).toBe("acc-alt");
    });

    it("works via processText path (Telegram) without senderBank", async () => {
        const config = makeConfig();
        const tools = phase1Tools(vi.fn(async (name) => {
            if (name === "fetch_context")
                return { accounts: [{ id: "acc-nova", name: "DBS Nova Card", closed: false }], categories: [], payees: [] };
            if (name === "search_memory")
                return { results: [{ text: "Card ending 7111 belongs to DBS Nova Card", score: 0.80 }] };
            if (name === "check_duplicate") return false;
            return true;
        }));

        const orch = new AgentOrchestrator(config, tools);
        let capturedMessages = null;
        orch._llm = {
            chat: vi
                .fn()
                .mockImplementationOnce(async (messages) => {
                    capturedMessages = messages;
                    return { choices: [{ message: toolCall("search_memory", { query: "7111" }) }] };
                })
                .mockResolvedValueOnce(json(baseOut("acc-nova", "DBS Nova Card"))),
        };

        await orch.processText(
            "From: alerts@dbs.com\nSubject: Card Transaction Alert for 7111\n\nS$12.80 charged",
        );

        // The LLM retrieved facts itself via the search_memory tool
        const searchCalls = tools.executeTool.mock.calls.filter(
            (c) => c[0] === "search_memory",
        );
        expect(searchCalls.length).toBeGreaterThanOrEqual(1);
        const toolMsgs = capturedMessages.filter((m) => m.role === "tool");
        expect(JSON.stringify(toolMsgs)).toContain("Card ending 7111 belongs to DBS Nova Card");
    });
});

describe("DeepSeekClient", () => {
    it("can be instantiated with config", () => {
        const config = makeConfig();
        const client = new DeepSeekClient(config);
        expect(client).toBeDefined();
    });

    it("merges reasoning_content into content when content is empty", () => {
        const config = makeConfig();
        const client = new DeepSeekClient(config);
        const data = {
            choices: [{ message: { reasoning_content: "This is reasoning" } }],
        };
        client._mergeReasoning(data);
        expect(data.choices[0].message.content).toBe("This is reasoning");
    });

    it("does not override existing content with reasoning", () => {
        const config = makeConfig();
        const client = new DeepSeekClient(config);
        const data = {
            choices: [
                {
                    message: {
                        content: "Original content",
                        reasoning_content: "Reasoning",
                    },
                },
            ],
        };
        client._mergeReasoning(data);
        expect(data.choices[0].message.content).toBe("Original content");
    });
});

describe("LLMClient truncation and reasoning-disabled handling", () => {
    it("reasoning: 'disabled' actually suppresses adaptive thinking on the deepseek route with no explicit toolChoice", async () => {
        const config = makeConfig();
        const client = new LLMClient(config);
        const createMock = vi.fn().mockResolvedValue({
            choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        });
        client._client.chat.completions.create = createMock;

        await client.chat(
            [{ role: "user", content: "hi" }],
            undefined,
            undefined,
            { reasoning: "disabled" },
        );

        expect(createMock).toHaveBeenCalledTimes(1);
        expect(createMock.mock.calls[0][0].thinking).toBeUndefined();
    });

    it("still enables adaptive thinking on the deepseek route when reasoning is not disabled", async () => {
        const config = makeConfig();
        const client = new LLMClient(config);
        const createMock = vi.fn().mockResolvedValue({
            choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        });
        client._client.chat.completions.create = createMock;

        await client.chat([{ role: "user", content: "hi" }], undefined, undefined, {
            reasoning: "adaptive",
        });

        expect(createMock.mock.calls[0][0].thinking).toEqual({ type: "adaptive" });
    });

    it("sends adaptive thinking on the deepseek route when no reasoning is requested", async () => {
        const config = makeConfig();
        const client = new LLMClient(config);
        const createMock = vi.fn().mockResolvedValue({
            choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        });
        client._client.chat.completions.create = createMock;

        await client.chat([{ role: "user", content: "hi" }]);

        expect(createMock.mock.calls[0][0].thinking).toEqual({
            type: "adaptive",
        });
    });

    it("maps a low-effort request to adaptive in the phase-1 call shape", async () => {
        const config = makeConfig();
        const client = new LLMClient(config);
        const createMock = vi.fn().mockResolvedValue({
            choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        });
        client._client.chat.completions.create = createMock;

        // Exactly how phase 1 calls it: a tool array, tool_choice "auto", and
        // reasoning "low".
        const tools = [
            {
                type: "function",
                function: { name: "fetch_context", parameters: {} },
            },
        ];
        await client.chat([{ role: "user", content: "hi" }], tools, "auto", {
            reasoning: "low",
        });

        const request = createMock.mock.calls[0][0];
        expect(request.thinking).toEqual({ type: "adaptive" });
        expect(request.tool_choice).toBe("auto");
        // The deepseek route carries no reasoning_effort field at all.
        expect(request).not.toHaveProperty("reasoning_effort");
    });

    it("never puts an effort value on the deepseek thinking field", async () => {
        for (const requested of ["low", "medium", "high", "bogus"]) {
            const config = makeConfig();
            const client = new LLMClient(config);
            const createMock = vi.fn().mockResolvedValue({
                choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
            });
            client._client.chat.completions.create = createMock;

            await client.chat(
                [{ role: "user", content: "hi" }],
                undefined,
                "auto",
                { reasoning: requested },
            );

            expect(createMock.mock.calls[0][0].thinking).toEqual({
                type: "adaptive",
            });
        }
    });

    it("retries when a response has empty content, no tool_calls, and a non-stop finish_reason (truncated)", async () => {
        const config = makeConfig();
        const client = new LLMClient(config);
        const createMock = vi
            .fn()
            .mockResolvedValueOnce({
                choices: [
                    {
                        message: {
                            content: "",
                            reasoning_content: "partial thinking, cut off before the final answer...",
                        },
                        finish_reason: "length",
                    },
                ],
            })
            .mockResolvedValueOnce({
                choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
            });
        client._client.chat.completions.create = createMock;

        const response = await client.chat([{ role: "user", content: "hi" }]);

        expect(createMock).toHaveBeenCalledTimes(2);
        expect(response.choices[0].message.content).toBe('{"ok":true}');
    });

    it("does not treat a healthy tool_calls response as truncated", async () => {
        const config = makeConfig();
        const client = new LLMClient(config);
        const createMock = vi.fn().mockResolvedValue({
            choices: [
                {
                    message: { tool_calls: [{ id: "tc-1", function: { name: "fetch_context", arguments: "{}" } }] },
                    finish_reason: "tool_calls",
                },
            ],
        });
        client._client.chat.completions.create = createMock;

        const response = await client.chat([{ role: "user", content: "hi" }], [{}]);

        expect(createMock).toHaveBeenCalledTimes(1);
        expect(response.choices[0].message.tool_calls).toHaveLength(1);
    });

    it("throws when every retry on the route returns a truncated response", async () => {
        const config = makeConfig();
        const client = new LLMClient(config);
        const createMock = vi.fn().mockResolvedValue({
            choices: [{ message: { content: "" }, finish_reason: "length" }],
        });
        client._client.chat.completions.create = createMock;

        await expect(
            client.chat([{ role: "user", content: "hi" }]),
        ).rejects.toThrow(/truncated or incomplete/i);
        // this._routes[0].retries defaults to 3 for the primary route
        expect(createMock).toHaveBeenCalledTimes(3);
    }, 10000);
});

// ── Statement routing tests ─────────────────────────────────────

describe("dispatchEmail statement routing", () => {
    it("routes transaction emails to the transaction orchestrator", async () => {
        const mockOrchestrator = {
            processEmail: vi.fn().mockResolvedValue({ action: "completed" }),
        };
        const mockStatementProcessor = {
            processStatement: vi
                .fn()
                .mockResolvedValue({ action: "completed" }),
        };
        const mockImapHandler = {
            markRead: vi.fn().mockResolvedValue(undefined),
        };
        const classifyFn = vi.fn().mockResolvedValue("transaction");

        const msg = {
            msg_id: "txn-001",
            raw_email: "SGD 12.80 at Toast Box",
            subject: "Transaction Alert",
            from: "alerts@example.com",
        };

        await dispatchEmail(
            msg,
            classifyFn,
            mockOrchestrator,
            mockImapHandler,
            mockStatementProcessor,
        );

        expect(mockOrchestrator.processEmail).toHaveBeenCalledWith(
            "txn-001",
            "SGD 12.80 at Toast Box",
            mockImapHandler,
            "alerts@example.com",
            "Transaction Alert",
        );
        expect(mockStatementProcessor.processStatement).not.toHaveBeenCalled();
    });

    it("does NOT route statement emails to the transaction orchestrator when statementProcessor is provided", async () => {
        const mockOrchestrator = {
            processEmail: vi.fn().mockResolvedValue({ action: "completed" }),
        };
        const mockStatementProcessor = {
            processStatement: vi
                .fn()
                .mockResolvedValue({ action: "completed" }),
        };
        const mockImapHandler = {
            markRead: vi.fn().mockResolvedValue(undefined),
        };
        const classifyFn = vi.fn().mockResolvedValue("statement");

        const msg = {
            msg_id: "stmt-001",
            raw_email: "Statement CSV data",
            subject: "Monthly Statement",
            from: "bank@example.com",
        };

        await dispatchEmail(
            msg,
            classifyFn,
            mockOrchestrator,
            mockImapHandler,
            mockStatementProcessor,
        );

        expect(mockStatementProcessor.processStatement).toHaveBeenCalled();
        expect(mockOrchestrator.processEmail).not.toHaveBeenCalled();
    });
});

// ==========================================================================
// Transfer detection in _resolvePhase2
// ==========================================================================

describe("_resolvePhase2 transfer detection", () => {
    it("detects transfer when payee matches an account name", async () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);

        const phase1 = fakePhase1Output({
            merchant: "Touch N Go",
            payee_name: "",
            category_id: "",
            budget_id: "Example MYR",
        });

        // Mock fetch_context to return accounts + payees with transfer_acct
        tools.executeTool.mockImplementation(async (name, args) => {
            if (name === "search_memory") return { results: [] };
            if (name === "resolve_merchant")
                return { payee: "Touch N Go", source: "web" };
            if (name === "fetch_context") {
                return {
                    accounts: [
                        {
                            id: "acct-tng",
                            name: "Touch N Go",
                            closed: false,
                        },
                        {
                            id: "acct-ryt",
                            name: "Ryt Bank",
                            closed: false,
                        },
                    ],
                    categories: [],
                    payees: [
                        {
                            id: "p-transfer",
                            name: "Touch N Go",
                            transfer_acct: "acct-tng",
                        },
                        {
                            id: "p-regular",
                            name: "Touch N Go",
                            transfer_acct: null,
                        },
                    ],
                };
            }
            if (name === "search_memory" && args.query.includes("category"))
                return { results: [] };
            return { results: [] };
        });

        const phase2 = await orch._resolvePhase2(phase1);

        expect(phase2._is_transfer).toBe(true);
        expect(phase2.payee_id).toBe("p-transfer");
        expect(phase2.payee_name).toBe("Touch N Go");
    });

    it("does not flag as transfer when payee does not match any account", async () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);

        const phase1 = fakePhase1Output({
            merchant: "Toast Box",
            payee_name: "",
            category_id: "",
        });

        tools.executeTool.mockImplementation(async (name, args) => {
            if (name === "search_memory") return { results: [] };
            if (name === "resolve_merchant")
                return { payee: "Toast Box", source: "web" };
            if (name === "fetch_context") {
                return {
                    accounts: [
                        {
                            id: "acct-1",
                            name: "DBS Nova",
                            closed: false,
                        },
                    ],
                    categories: [
                        { id: "cat-food", name: "Food" },
                    ],
                    payees: [],
                };
            }
            return { results: [] };
        });

        // Mock LLM chat for the category picker
        orch._llm = {
            chat: vi.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({ category_id: "cat-food" }),
                    },
                }],
            }),
        };

        const phase2 = await orch._resolvePhase2(phase1);

        expect(phase2._is_transfer).toBeUndefined();
        expect(phase2.payee_id).toBeUndefined();
        expect(phase2.payee_name).toBe("Toast Box");
        // Category picker should have run for non-transfer
        expect(phase2.category_id).toBe("cat-food");
    });

    it("skips category LLM picker for transfers", async () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);

        const phase1 = fakePhase1Output({
            merchant: "Touch N Go",
            payee_name: "",
            category_id: "",
            budget_id: "Example MYR",
        });

        tools.executeTool.mockImplementation(async (name, args) => {
            if (name === "search_memory") return { results: [] };
            if (name === "resolve_merchant")
                return { payee: "Touch N Go", source: "web" };
            if (name === "fetch_context") {
                return {
                    accounts: [
                        {
                            id: "acct-tng",
                            name: "Touch N Go",
                            closed: false,
                        },
                    ],
                    categories: [
                        { id: "cat-food", name: "Food" },
                    ],
                    payees: [
                        {
                            id: "p-transfer",
                            name: "Touch N Go",
                            transfer_acct: "acct-tng",
                        },
                    ],
                };
            }
            return { results: [] };
        });

        // Mock LLM — should NOT be called for transfers
        orch._llm = {
            chat: vi.fn(),
        };

        const phase2 = await orch._resolvePhase2(phase1);

        expect(phase2._is_transfer).toBe(true);
        // LLM should not have been called (no category picker for transfers)
        expect(orch._llm.chat).not.toHaveBeenCalled();
        // Category should remain empty for transfers
        expect(phase2.category_id).toBeFalsy();
    });
    it("does not match closed accounts for transfer detection", async () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);

        const phase1 = fakePhase1Output({
            merchant: "Closed Account",
            payee_name: "",
            category_id: "",
            budget_id: "test-budget",
        });

        tools.executeTool.mockImplementation(async (name) => {
            if (name === "search_memory") return { results: [] };
            if (name === "resolve_merchant")
                return { payee: "Closed Account", source: "web" };
            if (name === "fetch_context") {
                return {
                    accounts: [
                        {
                            id: "acct-closed",
                            name: "Closed Account",
                            closed: true,
                        },
                    ],
                    categories: [],
                    payees: [
                        {
                            id: "p-transfer",
                            name: "Closed Account",
                            transfer_acct: "acct-closed",
                        },
                    ],
                };
            }
            return { results: [] };
        });

        orch._llm = { chat: vi.fn() };

        const phase2 = await orch._resolvePhase2(phase1);

        // Should NOT detect as transfer because account is closed
        expect(phase2._is_transfer).toBeUndefined();
        expect(phase2.payee_id).toBeUndefined();
    });

    it("matches account names case-insensitively", async () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);

        const phase1 = fakePhase1Output({
            merchant: "Touch n go",
            payee_name: "",
            category_id: "",
            budget_id: "test-budget",
        });

        tools.executeTool.mockImplementation(async (name) => {
            if (name === "search_memory") return { results: [] };
            if (name === "resolve_merchant")
                return { payee: "touch n go", source: "web" };
            if (name === "fetch_context") {
                return {
                    accounts: [
                        {
                            id: "acct-tng",
                            name: "Touch N Go",
                            closed: false,
                        },
                    ],
                    categories: [],
                    payees: [
                        {
                            id: "p-transfer",
                            name: "Touch N Go",
                            transfer_acct: "acct-tng",
                        },
                    ],
                };
            }
            return { results: [] };
        });

        orch._llm = { chat: vi.fn() };

        const phase2 = await orch._resolvePhase2(phase1);

        // Case-insensitive match: "touch n go" matches "Touch N Go"
        expect(phase2._is_transfer).toBe(true);
        expect(phase2.payee_id).toBe("p-transfer");
    });

    it("survives fetch_context failure without crashing", async () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);

        const phase1 = fakePhase1Output({
            merchant: "Touch N Go",
            payee_name: "",
            category_id: "",
            budget_id: "test-budget",
        });

        tools.executeTool.mockImplementation(async (name) => {
            if (name === "search_memory") return { results: [] };
            if (name === "resolve_merchant")
                return { payee: "Touch N Go", source: "web" };
            if (name === "fetch_context")
                throw new Error("Network error");
            return { results: [] };
        });

        orch._llm = {
            chat: vi.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({ category_id: "cat-food" }),
                    },
                }],
            }),
        };

        const phase2 = await orch._resolvePhase2(phase1);

        // fetch_context failure should not crash; falls through to category resolution
        expect(phase2._is_transfer).toBeUndefined();
        expect(phase2.payee_id).toBeUndefined();
        expect(phase2.payee_name).toBe("Touch N Go");
    });

    it("passes payee_id to insert_transaction via Phase 3", async () => {
        const config = makeConfig();
        // check_duplicate must return false so insert proceeds
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "log_decision") return true;
                if (name === "learn_fact") return { added: true };
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        orch._runPhase1 = vi.fn().mockResolvedValue(
            fakePhase1Output({
                merchant: "Touch N Go",
                budget_id: "Example MYR",
            }),
        );
        orch._resolvePhase2 = vi.fn().mockResolvedValue(
            fakePhase2Output(
                fakePhase1Output({ merchant: "Touch N Go" }),
                {
                    payee_name: "Touch N Go",
                    payee_id: "p-transfer",
                    _is_transfer: true,
                    category_id: null,
                },
            ),
        );

        await orch.processEmail("test-transfer", "Transfer RM30 to Touch N Go");

        // Verify insert_transaction received payee_id
        const insertCall = tools.executeTool.mock.calls.find(
            (c) => c[0] === "insert_transaction",
        );
        expect(insertCall).toBeDefined();
        expect(insertCall[1].payee_id).toBe("p-transfer");
    });

    // Issue #556: two real transfers of the same amount are indistinguishable to
    // the amount+account duplicate check, so a second real transfer was silently
    // dropped (OCBC 360 -> Trust Bank, S$1.00, twice on 2026-09-13). A recognised
    // transfer must book: its event identity comes from the message and the
    // reservation, never from the money.
    it("books a second identical transfer instead of dropping it as a duplicate (#556)", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return true;
                if (name === "reserve_transfer")
                    return { status: "reserved", entry: { id: "resv-2" } };
                // The second identical transfer is booked only after the far
                // side is read and comes back empty (#598, #556).
                if (name === "find_link_candidate")
                    return { candidate: null, matches: 0 };
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({
            amount_cents: -100,
            account_id: "acc-ocbc",
        });
        const p2 = fakePhase2Output(p1, {
            payee_id: "p-transfer",
            _is_transfer: true,
            _transfer: {
                source_account_id: "acc-ocbc",
                destination_account_id: "acc-trust",
                amount_cents: 100,
                budget_id: "budget-sgd",
                occurred_at: "2026-09-13T08:53:20.000Z",
            },
        });
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        const result = await orch.processEmail(
            "test-second-transfer",
            "raw email",
        );

        expect(result.action).toBe("inserted");
        expect(tools.executeTool).toHaveBeenCalledWith(
            "insert_transaction",
            expect.anything(),
        );
    });

    // Issue #557: UOB sends a second "FAST Funds Transfer Status" email naming
    // the transfer but carrying no amount. It booked a 0.00 pair and notified
    // "S$0.00 ... logged"; an alert with no figure must book nothing.
    it("books nothing when the alert carries no amount (#557)", async () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({ amount_cents: 0 });
        const p2 = fakePhase2Output(p1, { amount_cents: 0 });
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        const result = await orch.processEmail(
            "test-zero-amount",
            "raw email",
        );

        expect(result.action).toBe("skipped");
        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "insert_transaction",
            expect.anything(),
        );
        const notify = tools.executeTool.mock.calls.find(
            (c) => c[0] === "notify_user",
        );
        expect(notify[1].message).toContain("no amount");
    });

    it("stays quiet when a silent run finds no amount (#557)", async () => {
        const config = makeConfig();
        const tools = makeTools();
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({ amount_cents: 0 });
        const p2 = fakePhase2Output(p1, { amount_cents: 0 });

        const result = await orch._executePhase3Core(p2, { silent: true });

        expect(result.action).toBe("skipped");
        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "notify_user",
            expect.anything(),
        );
    });

    // Issue #557: the account-name swap recognised a transfer but booked it
    // outside the reservation journal, so a second real transfer of the same
    // amount was dropped by the amount+account lookback.
    it("resolves a PayNow self identity before a merchant memory mapping (#561)", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "list_facts")
                    return {
                        facts: [
                            "TestUser is an OCBC 360 account",
                            "TestUser maps to Spotify payee",
                            "Spotify maps to Spotify category",
                        ],
                    };
                if (name === "search_memory")
                    return {
                        results: [
                            { text: "TestUser maps to Spotify payee", score: 1 },
                            { text: "Spotify maps to Spotify category", score: 1 },
                        ],
                    };
                if (name === "fetch_context")
                    return {
                        accounts: [
                            { id: "trust", name: "Trust Bank", closed: false },
                            { id: "ocbc", name: "OCBC 360", closed: false },
                        ],
                        categories: [{ id: "spotify", name: "Spotify" }],
                        payees: [{ id: "ocbc-transfer", transfer_acct: "ocbc" }],
                    };
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const result = await orch._resolvePhase2({
            merchant: "TestUser",
            amount_cents: -474,
            currency: "SGD",
            account_id: "trust",
            budget_id: "test-budget",
            _is_paynow: true,
        });

        expect(result.payee_name).toBe("OCBC 360");
        expect(result.payee_id).toBe("ocbc-transfer");
        expect(result._is_transfer).toBe(true);
        expect(result.category_id).toBeNull();
        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "search_memory",
            expect.objectContaining({ query: "TestUser" }),
        );
    });

    it("keeps a masked PayNow self identity out of merchant memory (#561)", async () => {
        // The account name is masked in the alert ("T*** B***" for "Trust
        // Bank"), so identity has to come from the live account list, not from
        // a stored fact keyed by the masked string.
        const config = makeConfig({ USER_NAME: "there" });
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "list_facts") return { facts: [] };
                if (name === "search_memory")
                    return { results: [{ text: "T*** B*** maps to Spotify payee", score: 1 }] };
                if (name === "fetch_context")
                    return {
                        accounts: [{ id: "trust", name: "Trust Bank", closed: false }],
                        categories: [{ id: "spotify", name: "Spotify" }],
                        payees: [],
                    };
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const result = await orch._resolvePhase2({
            merchant: "T*** B***",
            amount_cents: -474,
            currency: "SGD",
            account_id: "trust",
            budget_id: "test-budget",
            _is_paynow: true,
        });

        expect(result.payee_name).toBe("Misc");
        expect(result.category_id).toBeNull();
        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "search_memory",
            expect.objectContaining({ query: "T*** B***" }),
        );
    });

    // Issue #561: a PayNow credit that cannot be resolved to an own account is
    // held, never booked as an uncategorised positive inflow (income). The
    // deterministic parser already declines it; the LLM path still fell through
    // to a Misc insert.
    it("holds an unresolved PayNow credit instead of booking it as income (#561)", async () => {
        const config = makeConfig({ USER_NAME: "there" });
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "list_facts") return { facts: [] };
                if (name === "fetch_context")
                    return {
                        accounts: [{ id: "ocbc", name: "OCBC 360", closed: false }],
                        categories: [],
                        payees: [],
                    };
                if (name === "search_memory")
                    return {
                        results: [{ text: `${OWN_LEGAL_NAME_UPPER} maps to Spotify payee`, score: 1 }],
                    };
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({
            merchant: OWN_LEGAL_NAME_UPPER,
            amount_cents: 474,
            account_id: "ocbc",
            _is_paynow: true,
        });
        const p2 = await orch._resolvePhase2(p1);

        expect(p2.payee_name).toBe("Misc");
        expect(p2.category_id).toBeNull();
        expect(p2._is_transfer).toBeUndefined();
        expect(p2._hold_unresolved_paynow).toBe(true);

        const result = await orch._executePhase3Core(p2, { silent: false });

        expect(result.action).toBe("notified");
        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "insert_transaction",
            expect.anything(),
        );
    });

    it("holds a self-identity PayNow credit with no transfer payee (#561)", async () => {
        const config = makeConfig({ USER_NAME: "there" });
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "list_facts") return { facts: [] };
                if (name === "fetch_context")
                    return {
                        accounts: [
                            { id: "trust", name: "Trust Bank", closed: false },
                            { id: "ocbc", name: "OCBC 360", closed: false },
                        ],
                        categories: [{ id: "banking", name: "Banking" }],
                        // No payee carries transfer_acct, so no transfer can be
                        // reserved for the sending account.
                        payees: [],
                    };
                if (name === "search_memory")
                    return {
                        results: [{ text: "Trust Bank maps to Banking category", score: 1 }],
                    };
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({
            merchant: "Trust Bank",
            amount_cents: 474,
            account_id: "ocbc",
            _is_paynow: true,
        });
        const p2 = await orch._resolvePhase2(p1);

        expect(p2.payee_name).toBe("Trust Bank");
        expect(p2.payee_source).toBe("self_identity");
        expect(p2.category_id).toBeNull();
        // No transfer payee exists, so the credit cannot be reserved and must be
        // held rather than booked as an uncategorised inflow.
        expect(p2._hold_unresolved_paynow).toBe(true);

        const result = await orch._executePhase3Core(p2, { silent: false });

        expect(result.action).toBe("notified");
        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "insert_transaction",
            expect.anything(),
        );
    });

    // Issue #574, real redacted alert (2026-09-15, S$1.00): the counterparty
    // bank's own email booked the pair first (journal leg `inserted`), then the
    // Standard Chartered credit alert arrived 49 s later naming the holder —
    // `from ${OWN_LEGAL_NAME_UPPER}|` — a person, so Phase 1 resolved no own account and
    // the old pipeline held a credit that was already recorded.
    it("does not hold a credit whose transfer leg is already inserted (#574)", async () => {
        const config = makeConfig({ USER_NAME: "there" });
        const dbPath = join(
            tmpdir(),
            `dedup-574-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
        );
        const journal = new DedupJournal(dbPath);
        try {
            const reserved = journal.reserveTransfer({
                budget_id: "budget-sgd",
                source_account_id: "trust-891",
                destination_account_id: "sc-bonus",
                currency: "SGD",
                amount_cents: 100,
                occurred_at: "2026-09-15T23:20:02.000Z",
            });
            journal.markTransferInserted(reserved.entry.id, "actual-5920540f");

            const tools = makeTools({
                executeTool: vi.fn(async (name, args) => {
                    if (name === "find_inserted_transfer")
                        return journal.findInsertedTransferInto(args);
                    if (name === "list_facts") return { facts: [] };
                    // The far-side read the #598 fix makes before reserving. These
                    // credits' counterparts are journal legs, not pre-booked
                    // Actual rows, so there is no candidate to link (#574).
                    if (name === "find_link_candidate")
                        return { candidate: null, matches: 0 };
                    if (name === "fetch_context")
                        return {
                            accounts: [
                                { id: "sc-bonus", name: "SC Bonus Saver", closed: false },
                            ],
                            categories: [],
                            payees: [],
                        };
                    if (name === "reserve_transfer")
                        return journal.reserveTransfer(args);
                    // The far-side read the #598 fix makes before reserving:
                    // this credit's other leg is a journal entry, not an
                    // existing Actual row, so there is no candidate here.
                    if (name === "find_link_candidate")
                        return { candidate: null, matches: 0 };
                    return { results: [] };
                }),
            });
            const orch = new AgentOrchestrator(config, tools);

            const p1 = fakePhase1Output({
                merchant: OWN_LEGAL_NAME_UPPER,
                raw_description:
                    `You have received a PayNow/FAST transfer of SGD 1.00 from ${OWN_LEGAL_NAME_UPPER}| on 16-Sep-26 07:19 AM.`,
                amount_cents: 100,
                account_id: "sc-bonus",
                account_name: "SC Bonus Saver",
                _is_paynow: true,
                received_at: "2026-09-15T23:20:51.000Z",
            });
            const p2 = await orch._resolvePhase2(p1);

            expect(p2._hold_unresolved_paynow).toBeUndefined();
            expect(p2._is_transfer).toBe(true);
            expect(p2._transfer).toMatchObject({
                source_account_id: "trust-891",
                destination_account_id: "sc-bonus",
                amount_cents: 100,
            });

            const result = await orch._executePhase3Core(p2, { silent: false });

            expect(result.action).toBe("transfer_counterpart_deduplicated");
            expect(tools.executeTool).not.toHaveBeenCalledWith(
                "notify_user",
                expect.anything(),
            );
            expect(tools.executeTool).not.toHaveBeenCalledWith(
                "insert_transaction",
                expect.anything(),
            );
            expect(tools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
            expect(tools.executeTool).toHaveBeenCalledWith(
                "log_decision",
                expect.objectContaining({
                    action: "transfer_counterpart_deduplicated",
                }),
            );
            // No second reservation was created: the same lookup still sees one
            // leg, not an ambiguous pair.
            expect(journal.reserveTransfer(p2._transfer).status).toBe("inserted");
            // The alert has no `occurred_at`, so the email send time is the
            // anchor the lookup must have used.
            expect(tools.executeTool).toHaveBeenCalledWith(
                "find_inserted_transfer",
                expect.objectContaining({
                    at: "2026-09-15T23:20:51.000Z",
                    destination_account_id: "sc-bonus",
                }),
            );
        } finally {
            journal.close();
            try {
                unlinkSync(dbPath);
            } catch {}
        }
    });

    // Review round 1 on #574: an unrelated OUTGOING leg of the same amount on
    // the credited account is not the credit's counterparty, so the credit must
    // still be held and surfaced.
    it("still holds a credit when only an outgoing leg of the same amount exists (#574)", async () => {
        const config = makeConfig({ USER_NAME: "there" });
        const dbPath = join(
            tmpdir(),
            `dedup-574-out-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
        );
        const journal = new DedupJournal(dbPath);
        try {
            const outgoing = journal.reserveTransfer({
                budget_id: "budget-sgd",
                source_account_id: "sc-bonus",
                destination_account_id: "trust-893",
                currency: "SGD",
                amount_cents: 100,
                occurred_at: "2026-09-15T23:19:30.000Z",
            });
            journal.markTransferInserted(outgoing.entry.id, "actual-outgoing");

            const tools = makeTools({
                executeTool: vi.fn(async (name, args) => {
                    if (name === "find_inserted_transfer")
                        return journal.findInsertedTransferInto(args);
                    if (name === "list_facts") return { facts: [] };
                    // The far-side read the #598 fix makes before reserving. These
                    // credits' counterparts are journal legs, not pre-booked
                    // Actual rows, so there is no candidate to link (#574).
                    if (name === "find_link_candidate")
                        return { candidate: null, matches: 0 };
                    if (name === "fetch_context")
                        return {
                            accounts: [
                                { id: "sc-bonus", name: "SC Bonus Saver", closed: false },
                            ],
                            categories: [],
                            payees: [],
                        };
                    return true;
                }),
            });
            const orch = new AgentOrchestrator(config, tools);

            const p2 = await orch._resolvePhase2(
                fakePhase1Output({
                    merchant: OWN_LEGAL_NAME_UPPER,
                    amount_cents: 100,
                    account_id: "sc-bonus",
                    account_name: "SC Bonus Saver",
                    _is_paynow: true,
                    received_at: "2026-09-15T23:20:51.000Z",
                }),
            );

            expect(p2._hold_unresolved_paynow).toBe(true);
            expect(p2._is_transfer).toBeUndefined();

            const result = await orch._executePhase3Core(p2, { silent: false });

            expect(result.action).toBe("notified");
            expect(tools.executeTool).toHaveBeenCalledWith(
                "notify_user",
                expect.objectContaining({
                    message: expect.stringContaining("could not be matched"),
                }),
            );
        } finally {
            journal.close();
            try {
                unlinkSync(dbPath);
            } catch {}
        }
    });

    it("still holds a person-name credit whose journal leg is a different day (#574)", async () => {
        const config = makeConfig({ USER_NAME: "there" });
        const dbPath = join(
            tmpdir(),
            `dedup-574-miss-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
        );
        const journal = new DedupJournal(dbPath);
        try {
            const reserved = journal.reserveTransfer({
                budget_id: "budget-sgd",
                source_account_id: "trust-891",
                destination_account_id: "sc-bonus",
                currency: "SGD",
                amount_cents: 100,
                occurred_at: "2026-09-12T23:20:02.000Z",
            });
            journal.markTransferInserted(reserved.entry.id, "actual-older");

            const tools = makeTools({
                executeTool: vi.fn(async (name, args) => {
                    if (name === "find_inserted_transfer")
                        return journal.findInsertedTransferInto(args);
                    if (name === "list_facts") return { facts: [] };
                    // The far-side read the #598 fix makes before reserving. These
                    // credits' counterparts are journal legs, not pre-booked
                    // Actual rows, so there is no candidate to link (#574).
                    if (name === "find_link_candidate")
                        return { candidate: null, matches: 0 };
                    if (name === "fetch_context")
                        return {
                            accounts: [
                                { id: "sc-bonus", name: "SC Bonus Saver", closed: false },
                            ],
                            categories: [],
                            payees: [],
                        };
                    return true;
                }),
            });
            const orch = new AgentOrchestrator(config, tools);

            const p2 = await orch._resolvePhase2(
                fakePhase1Output({
                    merchant: OWN_LEGAL_NAME_UPPER,
                    amount_cents: 100,
                    account_id: "sc-bonus",
                    account_name: "SC Bonus Saver",
                    _is_paynow: true,
                    received_at: "2026-09-15T23:20:51.000Z",
                }),
            );

            expect(p2._hold_unresolved_paynow).toBe(true);

            const result = await orch._executePhase3Core(p2, { silent: false });

            expect(result.action).toBe("notified");
            expect(tools.executeTool).toHaveBeenCalledWith(
                "notify_user",
                expect.objectContaining({
                    message: expect.stringContaining("could not be matched"),
                }),
            );
        } finally {
            journal.close();
            try {
                unlinkSync(dbPath);
            } catch {}
        }
    });

    // Review round 1 on #574: a date-only anchor is midnight UTC, not the
    // alert's clock, so a journal window on it proves nothing. With no real
    // timestamp anywhere the credit keeps the pre-existing hold + notify.
    it("does not anchor the journal lookup on a date-only value (#574)", async () => {
        const config = makeConfig({ USER_NAME: "there" });
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "find_inserted_transfer")
                    throw new Error("must not look up without an event clock");
                if (name === "list_facts") return { facts: [] };
                if (name === "fetch_context")
                    return {
                        accounts: [
                            { id: "sc-bonus", name: "SC Bonus Saver", closed: false },
                        ],
                        categories: [],
                        payees: [],
                    };
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p2 = await orch._resolvePhase2(
            fakePhase1Output({
                merchant: OWN_LEGAL_NAME_UPPER,
                amount_cents: 100,
                account_id: "sc-bonus",
                account_name: "SC Bonus Saver",
                _is_paynow: true,
                date: "2026-09-15",
                occurred_at: "2026-09-15",
                received_at: "2026-09-15",
            }),
        );

        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "find_inserted_transfer",
            expect.anything(),
        );
        expect(p2._hold_unresolved_paynow).toBe(true);
    });

    // Review round 1 on #574: a date-only `occurred_at` must not shadow the
    // email's real send clock, and a real `occurred_at` must win over it.
    it("anchors on the first real timestamp and skips a date-only one (#574)", async () => {
        const config = makeConfig({ USER_NAME: "there" });
        const atCalls = [];
        const tools = makeTools({
            executeTool: vi.fn(async (name, args) => {
                if (name === "find_inserted_transfer") {
                    atCalls.push(args.at);
                    return null;
                }
                if (name === "list_facts") return { facts: [] };
                if (name === "fetch_context")
                    return {
                        accounts: [
                            { id: "sc-bonus", name: "SC Bonus Saver", closed: false },
                        ],
                        categories: [],
                        payees: [],
                    };
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        await orch._resolvePhase2(
            fakePhase1Output({
                merchant: OWN_LEGAL_NAME_UPPER,
                amount_cents: 100,
                account_id: "sc-bonus",
                account_name: "SC Bonus Saver",
                _is_paynow: true,
                occurred_at: "2026-09-15",
                received_at: "2026-09-15T23:20:51.000Z",
            }),
        );
        await orch._resolvePhase2(
            fakePhase1Output({
                merchant: OWN_LEGAL_NAME_UPPER,
                amount_cents: 100,
                account_id: "sc-bonus",
                account_name: "SC Bonus Saver",
                _is_paynow: true,
                occurred_at: "2026-09-15T23:20:10.000Z",
                received_at: "2026-09-15T23:20:51.000Z",
            }),
        );

        expect(atCalls).toEqual([
            "2026-09-15T23:20:51.000Z",
            "2026-09-15T23:20:10.000Z",
        ]);
    });

    // Review round 1 on #574: the deterministic movement parser carries its
    // clock on `_transfer`, not on a top-level field, so a structured internal
    // PayNow credit must still reach the journal lookup.
    it("passes the email uid as the claim key, and none for pasted text (#578)", async () => {
        const seen = [];
        const tools = makeTools({
            executeTool: vi.fn(async (name, args) => {
                if (name === "find_inserted_transfer") seen.push(args.alert_id);
                return null;
            }),
        });
        const orch = new AgentOrchestrator(makeConfig({ USER_NAME: "there" }), tools);
        const output = {
            budget_id: "budget-sgd",
            account_id: "sc-bonus",
            amount_cents: 100,
            currency: "SGD",
            occurred_at: "2026-09-15T23:20:02.000Z",
        };
        await orch._findBookedTransferLeg({ ...output, _alert_id: "101" });
        await orch._findBookedTransferLeg(output);
        expect(seen).toEqual(["101", null]);
    });

    // #580 L3: a row's own event time wins over the parser clock on `_transfer`.
    it("anchors on top-level occurred_at before _transfer.occurred_at (#580)", async () => {
        const seen = [];
        const tools = makeTools({
            executeTool: vi.fn(async (name, args) => {
                if (name === "find_inserted_transfer") seen.push(args.at);
                return null;
            }),
        });
        const orch = new AgentOrchestrator(makeConfig({ USER_NAME: "there" }), tools);
        await orch._findBookedTransferLeg({
            budget_id: "budget-sgd",
            account_id: "sc-bonus",
            amount_cents: 100,
            currency: "SGD",
            occurred_at: "2026-09-15T23:20:02.000Z",
            _transfer: { occurred_at: "2026-09-15T23:20:09.000Z" },
        });
        expect(seen).toEqual(["2026-09-15T23:20:02.000Z"]);
    });

    // #580 L2: a date-only value is midnight UTC, not the alert's event time,
    // so it must never anchor the window (the #574 review bug).
    it("skips the lookup for a date-only timestamp (#580)", async () => {
        const executeTool = vi.fn(async () => null);
        const orch = new AgentOrchestrator(
            makeConfig({ USER_NAME: "there" }),
            makeTools({ executeTool }),
        );
        const leg = await orch._findBookedTransferLeg({
            budget_id: "budget-sgd",
            account_id: "sc-bonus",
            amount_cents: 100,
            currency: "SGD",
            occurred_at: "2026-09-15",
        });
        expect(leg).toBeNull();
        expect(executeTool).not.toHaveBeenCalledWith("find_inserted_transfer", expect.anything());
    });

    it("finds the booked leg for a structured internal credit (#574)", async () => {
        const config = makeConfig({ USER_NAME: "there" });
        const dbPath = join(
            tmpdir(),
            `dedup-574-structured-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
        );
        const journal = new DedupJournal(dbPath);
        try {
            const reserved = journal.reserveTransfer({
                budget_id: "budget-sgd",
                source_account_id: "trust-8931",
                destination_account_id: "sc-bonus",
                currency: "SGD",
                amount_cents: 100,
                occurred_at: "2026-09-15T23:20:02.000Z",
            });
            journal.markTransferInserted(reserved.entry.id, "actual-structured");

            const tools = makeTools({
                executeTool: vi.fn(async (name, args) => {
                    if (name === "find_inserted_transfer")
                        return journal.findInsertedTransferInto(args);
                    if (name === "list_facts") return { facts: [] };
                    // The far-side read the #598 fix makes before reserving. These
                    // credits' counterparts are journal legs, not pre-booked
                    // Actual rows, so there is no candidate to link (#574).
                    if (name === "find_link_candidate")
                        return { candidate: null, matches: 0 };
                    if (name === "fetch_context")
                        return {
                            accounts: [
                                { id: "sc-bonus", name: "SC Bonus Saver", closed: false },
                            ],
                            categories: [],
                            payees: [],
                        };
                    if (name === "reserve_transfer")
                        return journal.reserveTransfer(args);
                    return true;
                }),
            });
            const orch = new AgentOrchestrator(config, tools);

            const p2 = await orch._resolvePhase2(
                fakePhase1Output({
                    merchant: OWN_LEGAL_NAME_UPPER,
                    amount_cents: 100,
                    date: "2026-09-15",
                    account_id: "sc-bonus",
                    account_name: "SC Bonus Saver",
                    _is_paynow: true,
                    _structured_movement: true,
                    _is_transfer: true,
                    _transfer: {
                        budget_id: "budget-sgd",
                        source_account_id: "trust-8931",
                        destination_account_id: "sc-bonus",
                        currency: "SGD",
                        amount_cents: 100,
                        occurred_at: "2026-09-15T23:20:02.000Z",
                    },
                }),
            );

            expect(p2._hold_unresolved_paynow).toBeUndefined();
            expect(tools.executeTool).toHaveBeenCalledWith(
                "find_inserted_transfer",
                expect.objectContaining({ at: "2026-09-15T23:20:02.000Z" }),
            );

            const result = await orch._executePhase3Core(p2, { silent: false });

            expect(result.action).toBe("transfer_counterpart_deduplicated");
            expect(tools.executeTool).not.toHaveBeenCalledWith(
                "notify_user",
                expect.anything(),
            );
            expect(tools.executeTool).not.toHaveBeenCalledWith(
                "insert_transaction",
                expect.anything(),
            );
        } finally {
            journal.close();
            try {
                unlinkSync(dbPath);
            } catch {}
        }
    });

    // Review round 2 on #561: pre-seeding Misc for every PayNow killed the
    // learned merchant mapping for ordinary personal-PayNow debits.
    it("keeps the learned merchant payee for a PayNow debit (#561)", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name, args) => {
                if (name === "list_facts") return { facts: [] };
                if (name === "fetch_context")
                    return {
                        accounts: [{ id: "trust", name: "Trust Bank", closed: false }],
                        categories: [{ id: "food", name: "Food" }],
                        payees: [],
                    };
                if (name === "search_memory" && args?.query === "Hawker Chan")
                    return {
                        results: [{ text: "Hawker Chan maps to Hawker Chan payee", score: 1 }],
                    };
                return { results: [] };
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p2 = await orch._resolvePhase2({
            merchant: "Hawker Chan",
            amount_cents: -474,
            currency: "SGD",
            account_id: "trust",
            budget_id: "test-budget",
            action: "insert",
            _is_paynow: true,
        });

        expect(p2.payee_name).toBe("Hawker Chan");
        expect(p2.payee_source).toBe("memory");
        expect(p2._hold_unresolved_paynow).toBeUndefined();
    });

    it("reserves an incoming self-transfer the right way round (#561)", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "list_facts") return { facts: [] };
                if (name === "fetch_context")
                    return {
                        accounts: [
                            { id: "trust", name: "Trust Bank", closed: false },
                            { id: "ocbc", name: "OCBC 360", closed: false },
                        ],
                        categories: [],
                        payees: [{ id: "transfer-trust", transfer_acct: "trust" }],
                    };
                return { results: [] };
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p2 = await orch._resolvePhase2({
            merchant: "Trust Bank",
            amount_cents: 474,
            currency: "SGD",
            account_id: "ocbc",
            account_name: "OCBC 360",
            budget_id: "test-budget",
            action: "insert",
            _is_paynow: true,
        });

        expect(p2._is_transfer).toBe(true);
        expect(p2.category_id).toBeNull();
        expect(p2._hold_unresolved_paynow).toBeUndefined();
        // Sender is the source, the credited account is the destination.
        expect(p2._transfer.source_account_id).toBe("trust");
        expect(p2._transfer.destination_account_id).toBe("ocbc");
    });

    it("reserves an outgoing transfer the right way round (#561)", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "fetch_context")
                    return {
                        accounts: [
                            { id: "ocbc", name: "OCBC 360", closed: false },
                            { id: "trust", name: "Trust Bank", closed: false },
                        ],
                        categories: [],
                        payees: [{ id: "transfer-trust", transfer_acct: "trust" }],
                    };
                return { results: [] };
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        // The alert named the destination account, so the account-name swap
        // supplies the payee. The direction is what this test pins.
        const p2 = await orch._resolvePhase2({
            merchant: "Trust Bank",
            payee_name: "Trust Bank",
            amount_cents: -474,
            currency: "SGD",
            account_id: "ocbc",
            budget_id: "test-budget",
            action: "insert",
        });

        expect(p2._is_transfer).toBe(true);
        expect(p2._transfer.source_account_id).toBe("ocbc");
        expect(p2._transfer.destination_account_id).toBe("trust");
    });

    it("reserves a transfer recognised by account name (#557)", async () => {
        const config = makeConfig();
        const tools = makeTools();
        tools.executeTool.mockImplementation(async (name) => {
            if (name === "fetch_context")
                return {
                    accounts: [
                        { id: "acct-trust", name: "Trust Bank", closed: false },
                    ],
                    categories: [],
                    payees: [
                        {
                            id: "p-trust-transfer",
                            name: "Trust Bank",
                            transfer_acct: "acct-trust",
                        },
                    ],
                };
            return true;
        });
        const orch = new AgentOrchestrator(config, tools);

        const result = await orch._resolvePhase2({
            account_id: "acct-ocbc",
            payee_name: "Trust Bank",
            amount_cents: -100,
            currency: "SGD",
            date: "2026-09-13",
        });

        expect(result._is_transfer).toBe(true);
        expect(result._transfer).toBeDefined();
        // A debit: the booked account pays, so it is the source.
        expect(result._transfer.source_account_id).toBe("acct-ocbc");
        expect(result._transfer.destination_account_id).toBe("acct-trust");
        expect(result._transfer.amount_cents).toBe(100);
        expect(result._transfer.payee_id).toBe("p-trust-transfer");
    });

    it("holds the literal OCBC-to-closed-card FAST incident before a transfer payee can materialise its counterpart (#563)", async () => {
        const tools = makeTools({
            executeTool: vi.fn(async (name, args) => {
                if (name === "fetch_context") return {
                    // fetch_context's production shape omits the closed card but
                    // still exposes its transfer payee.
                    accounts: [{ id: "ocbc", name: "OCBC 360", closed: false }],
                    categories: [],
                    payees: [{ id: "stan-chart-transfer", name: "Stan Chart Card", transfer_acct: "stan-chart" }],
                };
                if (name === "search_memory" && args?.query === "Standard Chartered Bank Singapore")
                    return { results: [{ text: "Standard Chartered Bank Singapore maps to Stan Chart Card payee", score: 1 }] };
                return { results: [] };
            }),
        });
        const orch = new AgentOrchestrator(makeConfig(), tools);
        const resolved = await orch._resolvePhase2({
            merchant: "Standard Chartered Bank Singapore", amount_cents: -250000,
            currency: "SGD", account_id: "ocbc", budget_id: "test-budget", action: "insert",
        });

        expect(resolved).toMatchObject({
            payee_name: "Misc", payee_source: "transfer_destination_refused",
            _hold_unresolved_transfer: true,
        });
        await orch._executePhase3Core(resolved, { silent: false });
        expect(tools.executeTool).not.toHaveBeenCalledWith("insert_transaction", expect.anything());
    });

    it("refuses ambiguous, closed, credit-card, and self transfer destinations (#563)", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name, args) => {
                if (name === "fetch_context")
                    return {
                        accounts: [
                            { id: "ocbc", name: "OCBC 360", closed: false },
                            { id: "bonus", name: "SC Bonus Saver", closed: false },
                            { id: "journeys", name: "SC Journeys Card", closed: false },
                        ],
                        categories: [],
                        payees: [
                            { id: "bonus-transfer", name: "SC Bonus Saver", transfer_acct: "bonus" },
                            { id: "journeys-transfer", name: "SC Journeys Card", transfer_acct: "journeys" },
                            { id: "smart-transfer", name: "SC Smart Card", transfer_acct: "smart" },
                        ],
                    };
                if (name === "search_memory" && args?.query === "Standard Chartered Bank Singapore")
                    return { results: [{ text: "Standard Chartered Bank Singapore maps to SC Bonus Saver payee", score: 1 }] };
                if (name === "search_memory" && args?.query === "SC Journeys Card")
                    return { results: [{ text: "SC Journeys Card is a credit card", score: 1 }] };
                return { results: [] };
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const ambiguous = await orch._resolvePhase2({
            merchant: "Standard Chartered Bank Singapore", amount_cents: -250000,
            currency: "SGD", account_id: "ocbc", budget_id: "test-budget", action: "insert",
        });
        expect(ambiguous).toMatchObject({ payee_name: "Misc", category_id: null });
        expect(ambiguous._is_transfer).toBeUndefined();
        await orch._executePhase3Core(ambiguous, { silent: false });
        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "insert_transaction",
            expect.anything(),
        );

        for (const [account_id, payee_name] of [
            ["bonus", "SC Bonus Saver"],
            ["ocbc", "SC Journeys Card"],
            ["ocbc", "SC Smart Card"],
        ]) {
            const result = await orch._resolvePhase2({
                merchant: payee_name, payee_name, amount_cents: -250000,
                currency: "SGD", account_id, budget_id: "test-budget", action: "insert",
            });
            expect(result._is_transfer).toBeUndefined();
        }
    });
});
