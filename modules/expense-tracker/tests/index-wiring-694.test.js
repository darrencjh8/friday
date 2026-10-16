/**
 * Issue #694 review finding H1: the IMAP idle callback must hand the dispatch
 * result back to the idle loop, or its llm_unavailable short retry never runs.
 */
import { describe, expect, it, vi } from "vitest";

let idleCallback;
const dispatchEmail = vi.fn();

vi.mock("express", () => {
    const app = {
        use: vi.fn(),
        get: vi.fn(),
        post: vi.fn(),
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
        executeTool() { return true; }
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
        idleLoop(callback) {
            idleCallback = callback;
            return Promise.resolve();
        }
    },
}));

describe("index.js IMAP wiring (#694 H1)", () => {
    it("returns the dispatch result to the idle loop", async () => {
        dispatchEmail.mockResolvedValue({ action: "llm_unavailable" });
        await import("../src/index.js");
        await vi.waitFor(() => expect(idleCallback).toBeTypeOf("function"));

        const result = await idleCallback({ msg_id: "1069", subject: "Card Transaction Alert" });

        expect(result).toEqual({ action: "llm_unavailable" });
    });
});
