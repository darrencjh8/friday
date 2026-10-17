/**
 * Issue #783 cutover: once Hermes email intake is live, the IDLE watcher is
 * off and /health says so, so Hermes can wait for it before booking.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Config } from "../src/config.js";

const routes = {};
const idleLoop = vi.fn(() => Promise.resolve());
let cfg = {};

vi.mock("express", () => {
    const app = {
        use: vi.fn(),
        get: vi.fn((path, handler) => {
            routes[path] = handler;
        }),
        post: vi.fn(),
        listen: vi.fn((_port, _host, ready) => {
            setTimeout(ready, 0);
            return { on: vi.fn() };
        }),
    };
    const express = () => app;
    express.json = vi.fn();
    return { default: express };
});
vi.mock("../src/config.js", async (importOriginal) => {
    const real = await importOriginal();
    return { ...real, Config: Object.assign(real.Config, { fromEnv: () => cfg }) };
});
vi.mock("../src/memory.js", () => ({ MemoryStore: class { listFacts() { return [1]; } } }));
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
vi.mock("../src/classify.js", () => ({ classifyEmail: vi.fn(), dispatchEmail: vi.fn() }));
vi.mock("../src/imap.js", () => ({ ImapIdleHandler: class { idleLoop(cb) { return idleLoop(cb); } } }));

const base = { memoryPath: "m", dedupDbPath: ":memory:", statementDbPath: ":memory:", processingDbPath: ":memory:" };

function health() {
    let body;
    routes["/health"]({}, { json: (b) => { body = b; } });
    return body;
}

async function start(extra) {
    cfg = { ...base, ...extra };
    vi.resetModules();
    await import("../src/index.js");
    await vi.waitFor(() => expect(routes["/health"]).toBeTypeOf("function"));
    await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("email watcher switch (#783)", () => {
    beforeEach(() => {
        idleLoop.mockClear();
        delete routes["/health"];
    });

    it("only EMAIL_INTAKE_MODE=live turns the watcher off", () => {
        expect(new Config({ EMAIL_INTAKE_MODE: "live" }).emailWatcher).toBe(false);
        expect(new Config({ EMAIL_INTAKE_MODE: " LIVE " }).emailWatcher).toBe(false);
        expect(new Config({ EMAIL_INTAKE_MODE: "shadow" }).emailWatcher).toBe(true);
        expect(new Config({}).emailWatcher).toBe(true);
    });

    it("live intake: no IDLE loop, and /health reports the watcher off", async () => {
        await start({ emailWatcher: false });
        expect(idleLoop).not.toHaveBeenCalled();
        expect(health()).toEqual({ status: "ok", email_watcher: "off" });
    });

    it("shadow intake: the IDLE loop runs, and /health reports it on", async () => {
        await start({ emailWatcher: true });
        expect(idleLoop).toHaveBeenCalledTimes(1);
        expect(health()).toEqual({ status: "ok", email_watcher: "on" });
    });
});
