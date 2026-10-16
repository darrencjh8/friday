/**
 * Issue #783 Phase 2: index.js mounts the signed processing routes Hermes
 * email-intake calls.
 */
import { describe, expect, it, vi } from "vitest";

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock("express", () => {
    const app = {
        use: vi.fn(),
        get: vi.fn(),
        post: postMock,
        listen: vi.fn((_port, _host, ready) => {
            setTimeout(ready, 0);
            return { on: vi.fn() };
        }),
    };
    const express = () => app;
    express.json = vi.fn();
    return { default: express };
});
vi.mock("../src/config.js", () => ({
    Config: {
        fromEnv: () => ({
            memoryPath: "m", dedupDbPath: ":memory:", statementDbPath: ":memory:",
            processingDbPath: ":memory:", notifySecret: "s",
            telegramBotToken: "1:t", telegramHomeChannel: "5",
        }),
    },
}));
vi.mock("../src/memory.js", () => ({ MemoryStore: class { listFacts() { return [1]; } } }));
vi.mock("../src/processing.js", () => ({
    ProcessingService: class {},
    RequestJournal: class {},
    createProcessHandler: vi.fn(({ kind }) => `handler:${kind}`),
}));
vi.mock("../src/tools.js", () => ({
    ToolRegistry: class {
        setOrchestrator() {}
        setStatementJournal() {}
        setEmailContext() {}
        setLearningNotifier() {}
        executeTool() { return true; }
    },
    StatementJournal: class {},
}));
vi.mock("../src/orchestrator.js", () => ({ AgentOrchestrator: class {} }));
vi.mock("../src/statement/orchestrator.js", () => ({ StatementProcessor: class {} }));
vi.mock("../src/dedup.js", () => ({ DedupJournal: class { cleanup() {} } }));
vi.mock("../src/mcp-server.js", () => ({ createMcpServer: vi.fn() }));
vi.mock("../src/classify.js", () => ({ classifyEmail: vi.fn(), dispatchEmail: vi.fn() }));
vi.mock("../src/imap.js", () => ({ ImapIdleHandler: class { idleLoop() { return Promise.resolve(); } } }));

describe("index.js processing routes (#783)", () => {
    it("mounts /process/transaction and /process/statement with signed handlers", async () => {
        await import("../src/index.js");
        await vi.waitFor(() => expect(postMock).toHaveBeenCalled());
        const routes = Object.fromEntries(postMock.mock.calls.map(([p, h]) => [p, h]));
        expect(routes["/process/transaction"]).toBe("handler:transaction");
        expect(routes["/process/statement"]).toBe("handler:statement");
    });
});
