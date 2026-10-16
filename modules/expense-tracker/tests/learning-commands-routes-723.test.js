/**
 * Issue #723: with Hermes's bot configured, index.js mounts /learning/answer
 * and does not route confirm_learning over HTTP.
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
            memoryPath: "m", dedupDbPath: ":memory:", statementDbPath: ":memory:", processingDbPath: ":memory:",
            telegramBotToken: "1:t", telegramHomeChannel: "5",
        }),
    },
}));
vi.mock("../src/memory.js", () => ({ MemoryStore: class { listFacts() { return [1]; } } }));
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

describe("index.js with Hermes's bot configured (#723)", () => {
    it("mounts the answer route and drops the confirm-learning route", async () => {
        await import("../src/index.js");
        await vi.waitFor(() => expect(postMock).toHaveBeenCalled());
        const paths = postMock.mock.calls.map(([p]) => p);
        expect(paths).toContain("/learning/answer");
        expect(paths).not.toContain("/tools/confirm-learning");
        expect(paths).toContain("/tools/decline-learning");
        expect(paths).toContain("/tools/list-pending-learning");
        expect(paths.filter((p) => p.startsWith("/tools/")).some((p) => /answer|remember|forget/.test(p))).toBe(false);
    });
});
