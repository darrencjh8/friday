/**
 * Issue #720: the HTTP tool routes. The learning tools are routed, a caller
 * cannot supply the orchestrator-only `evidence`, and propose_learning is not
 * reachable over HTTP.
 */
import { describe, expect, it, vi } from "vitest";

const { dispatchEmail, executeTool, postMock } = vi.hoisted(() => ({
    dispatchEmail: vi.fn(),
    executeTool: vi.fn(() => true),
    postMock: vi.fn(),
}));

vi.mock("express", () => {
    const app = {
        use: vi.fn(),
        get: vi.fn(),
        post: postMock,
        listen: vi.fn((_port, _host, ready) => {
            // The real server calls back after listen() returns.
            setTimeout(ready, 0);
            return { on: vi.fn() };
        }),
    };
    const express = () => app;
    express.json = vi.fn();
    return { default: express };
});
vi.mock("../src/config.js", () => ({
    Config: { fromEnv: () => ({ memoryPath: "m", dedupDbPath: ":memory:", statementDbPath: ":memory:", processingDbPath: ":memory:" }) },
}));
vi.mock("../src/memory.js", () => ({
    MemoryStore: class {
        listFacts() { return [1]; }
    },
}));
vi.mock("../src/tools.js", () => ({
    ToolRegistry: class {
        setOrchestrator() {}
        setStatementJournal() {}
        setEmailContext() {}
        executeTool(...a) { return executeTool(...a); }
    },
    StatementJournal: class {},
}));
vi.mock("../src/orchestrator.js", () => ({ AgentOrchestrator: class {} }));
vi.mock("../src/statement/orchestrator.js", () => ({ StatementProcessor: class {} }));
vi.mock("../src/dedup.js", () => ({ DedupJournal: class { cleanup() {} } }));
vi.mock("../src/mcp-server.js", () => ({ createMcpServer: vi.fn() }));
vi.mock("../src/classify.js", () => ({ classifyEmail: vi.fn(), dispatchEmail }));
vi.mock("../src/imap.js", () => ({
    ImapIdleHandler: class {
        idleLoop() {
            return Promise.resolve();
        }
    },
}));

describe("index.js tool routes (#720)", () => {
    async function routes() {
        await import("../src/index.js");
        await vi.waitFor(() => expect(postMock).toHaveBeenCalled());
        return new Map(postMock.mock.calls.map(([path, handler]) => [path, handler]));
    }
    const res = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis() });

    it("routes the three learning tools and not propose_learning", async () => {
        const map = await routes();
        for (const path of ["list-pending-learning", "confirm-learning", "decline-learning"]) {
            expect(map.has(`/tools/${path}`)).toBe(true);
        }
        expect(map.has("/tools/propose-learning")).toBe(false);
        expect(map.has("/tools/withdraw-learning")).toBe(false);
    });

    it("strips a caller-supplied evidence field from resolve_merchant", async () => {
        const map = await routes();
        await map.get("/tools/resolve-merchant")({ body: { merchant: "X", evidence: { text: "attacker" } } }, res());
        expect(executeTool).toHaveBeenCalledWith("resolve_merchant", { merchant: "X" });
    });
});
