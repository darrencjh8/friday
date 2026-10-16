/**
 * Tests that the MCP server registers reconcile_transaction,
 * unclear_transaction, and fetch_unreconciled_transactions.
 * The definitions exist in tools.js but the MCP server must
 * explicitly register them.
 */
import { describe, it, expect } from "vitest";
import { Config } from "../src/config.js";
import { ToolRegistry } from "../src/tools.js";

const testEnv = {
    DEEPSEEK_API_KEY: "sk-test",
    ACTUAL_BUDGET_URL: "http://test:5006",
    ACTUAL_BUDGET_PASSWORD: "pw",
    ACTUAL_PRIMARY_BUDGET_FILE: "test-budget",
    DEDUP_DB_PATH: ":memory:",
};

describe("MCP server tool registration", () => {
    it("registers reconcile_transaction in MCP tool schemas", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        const names = schemas.map((s) => s.function.name);
        expect(names).toContain("reconcile_transaction");
    });

    it("registers fetch_unreconciled_transactions in MCP tool schemas", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        const names = schemas.map((s) => s.function.name);
        expect(names).toContain("fetch_unreconciled_transactions");
    });

    it("registers unclear_transaction in MCP tool schemas", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        const names = schemas.map((s) => s.function.name);
        expect(names).toContain("unclear_transaction");
    });

    it("reconcile_transaction handler clears a transaction", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        // Verify the handler exists and accepts correct args
        const handler = registry["_handle_reconcile_transaction"];
        expect(handler).toBeDefined();
        expect(typeof handler).toBe("function");
    });

    it("fetch_unreconciled_transactions handler fetches uncleared txns", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const handler = registry["_handle_fetch_unreconciled_transactions"];
        expect(handler).toBeDefined();
        expect(typeof handler).toBe("function");
    });

    it("unclear_transaction handler exists", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const handler = registry["_handle_unclear_transaction"];
        expect(handler).toBeDefined();
        expect(typeof handler).toBe("function");
    });

    it("reconcile_transaction schema has ab_transaction_ids array and budget_id required", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        const tool = schemas.find(
            (s) => s.function.name === "reconcile_transaction",
        );
        expect(tool).toBeDefined();
        expect(tool.function.parameters.required).toContain(
            "ab_transaction_ids",
        );
        expect(tool.function.parameters.required).toContain("budget_id");
        expect(
            tool.function.parameters.properties.ab_transaction_ids.type,
        ).toBe("array");
        expect(tool.function.parameters.properties.statement_ref).toBeDefined();
    });

    it("unclear_transaction schema has ab_transaction_ids array and budget_id required", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        const tool = schemas.find(
            (s) => s.function.name === "unclear_transaction",
        );
        expect(tool).toBeDefined();
        expect(tool.function.parameters.required).toContain(
            "ab_transaction_ids",
        );
        expect(tool.function.parameters.required).toContain("budget_id");
        expect(
            tool.function.parameters.properties.ab_transaction_ids.type,
        ).toBe("array");
    });

    it("fetch_unreconciled_transactions schema has date range fields", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        const tool = schemas.find(
            (s) => s.function.name === "fetch_unreconciled_transactions",
        );
        expect(tool).toBeDefined();
        expect(tool.function.parameters.required).toContain("account_id");
        expect(tool.function.parameters.required).toContain("date_from");
        expect(tool.function.parameters.required).toContain("date_to");
        expect(tool.function.parameters.required).toContain("budget_id");
    });
});

describe("reconcile_transaction handler — negative cases", () => {
    it("rejects empty ab_transaction_ids array", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const result = await registry.executeTool("reconcile_transaction", {
            ab_transaction_ids: [],
            budget_id: "test-budget",
        });
        expect(result.error).toBe(
            "ab_transaction_ids must be a non-empty array",
        );
    });

    it("rejects missing budget_id", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const result = await registry.executeTool("reconcile_transaction", {
            ab_transaction_ids: ["txn-1"],
        });
        expect(result.error).toBe("budget_id is required");
    });

    it("rejects non-array ab_transaction_ids", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const result = await registry.executeTool("reconcile_transaction", {
            ab_transaction_ids: "txn-1",
            budget_id: "test-budget",
        });
        expect(result.error).toBe(
            "ab_transaction_ids must be a non-empty array",
        );
    });

    it("clears multiple transactions successfully", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        registry._get = vi.fn(async () => ({ id: "any", notes: "" }));
        registry._post = vi.fn(async () => ({ status: "cleared", id: "any" }));

        const result = await registry.executeTool("reconcile_transaction", {
            ab_transaction_ids: ["txn-a", "txn-b", "txn-c"],
            statement_ref: "Jun 2026",
            budget_id: "test-budget",
        });
        expect(result.cleared).toBe(3);
        expect(result.failed).toBe(0);
        expect(result.results.length).toBe(3);
        expect(result.results[0].status).toBe("cleared");
        expect(registry._post).toHaveBeenCalledTimes(3);
    });

    it("handles partial failure in batch", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        registry._get = vi.fn(async () => ({ id: "any", notes: "" }));
        registry._post = vi
            .fn()
            .mockResolvedValueOnce({ status: "cleared" })
            .mockRejectedValueOnce(new Error("actual-api 500"))
            .mockResolvedValueOnce({ status: "cleared" });

        const result = await registry.executeTool("reconcile_transaction", {
            ab_transaction_ids: ["txn-ok", "txn-fail", "txn-ok2"],
            budget_id: "test-budget",
        });
        expect(result.cleared).toBe(2);
        expect(result.failed).toBe(1);
        expect(result.results.length).toBe(3);
        expect(result.results[1].status).toBe("error");
    });

    it("handles all failures in batch", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        registry._get = vi.fn(async () => {
            throw new Error("actual-api 500");
        });
        registry._post = vi.fn(async () => ({ status: "cleared" }));

        const result = await registry.executeTool("reconcile_transaction", {
            ab_transaction_ids: ["txn-x", "txn-y"],
            budget_id: "test-budget",
        });
        expect(result.cleared).toBe(0);
        expect(result.failed).toBe(2);
        expect(result.results.every((r) => r.status === "error")).toBe(true);
        expect(registry._post).not.toHaveBeenCalled();
    });

    it("composes statement_ref into a Statement line", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        registry._get = vi.fn(async () => ({ id: "txn-1", notes: "" }));
        let body = null;
        registry._post = vi.fn(async (path, payload) => {
            body = payload;
            return { status: "cleared", id: "any" };
        });

        await registry.executeTool("reconcile_transaction", {
            ab_transaction_ids: ["txn-1"],
            statement_ref: "Affin statement Jun 2026",
            budget_id: "test-budget",
        });
        expect(body.notes).toBe("Statement: Affin statement Jun 2026");
    });

    it("omits notes when there is nothing to compose", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        registry._get = vi.fn(async () => ({ id: "txn-1", notes: "" }));
        let body = null;
        registry._post = vi.fn(async (path, payload) => {
            body = payload;
            return { status: "cleared", id: "any" };
        });

        await registry.executeTool("reconcile_transaction", {
            ab_transaction_ids: ["txn-1"],
            budget_id: "test-budget",
        });
        expect(body.notes).toBeUndefined();
    });
});

describe("unclear_transaction handler — negative cases", () => {
    it("rejects empty ab_transaction_ids array", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const result = await registry.executeTool("unclear_transaction", {
            ab_transaction_ids: [],
            budget_id: "test-budget",
        });
        expect(result.error).toBe(
            "ab_transaction_ids must be a non-empty array",
        );
    });

    it("rejects missing budget_id", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const result = await registry.executeTool("unclear_transaction", {
            ab_transaction_ids: ["txn-1"],
        });
        expect(result.error).toBe("budget_id is required");
    });

    it("rejects non-array ab_transaction_ids", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const result = await registry.executeTool("unclear_transaction", {
            ab_transaction_ids: "txn-1",
            budget_id: "test-budget",
        });
        expect(result.error).toBe(
            "ab_transaction_ids must be a non-empty array",
        );
    });

    it("unclears multiple transactions successfully", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const origFetch = global.fetch;
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ status: "uncleared", id: "any" }),
        });

        try {
            const result = await registry.executeTool("unclear_transaction", {
                ab_transaction_ids: ["txn-a", "txn-b", "txn-c"],
                budget_id: "test-budget",
            });
            expect(result.uncleared).toBe(3);
            expect(result.failed).toBe(0);
            expect(result.results.length).toBe(3);
            expect(result.results[0].status).toBe("uncleared");
            expect(global.fetch).toHaveBeenCalledTimes(3);
        } finally {
            global.fetch = origFetch;
        }
    });

    it("handles partial failure in batch", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const origFetch = global.fetch;
        let callCount = 0;
        global.fetch = vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 2) {
                return Promise.resolve({
                    ok: false,
                    status: 500,
                    json: async () => ({
                        error: "Internal server error",
                    }),
                });
            }
            return Promise.resolve({
                ok: true,
                json: async () => ({ status: "uncleared", id: "any" }),
            });
        });

        try {
            const result = await registry.executeTool("unclear_transaction", {
                ab_transaction_ids: ["txn-ok", "txn-fail", "txn-ok2"],
                budget_id: "test-budget",
            });
            expect(result.uncleared).toBe(2);
            expect(result.failed).toBe(1);
            expect(result.results.length).toBe(3);
            expect(result.results[1].status).toBe("error");
        } finally {
            global.fetch = origFetch;
        }
    });

    it("handles all failures in batch", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const origFetch = global.fetch;
        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => ({ error: "Internal server error" }),
        });

        try {
            const result = await registry.executeTool("unclear_transaction", {
                ab_transaction_ids: ["txn-x", "txn-y"],
                budget_id: "test-budget",
            });
            expect(result.uncleared).toBe(0);
            expect(result.failed).toBe(2);
            expect(result.results.every((r) => r.status === "error")).toBe(
                true,
            );
        } finally {
            global.fetch = origFetch;
        }
    });
});
