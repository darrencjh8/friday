/**
 * Real-engine coverage for POST /transactions/link-transfer (#620, #598
 * follow-up). Runs the actual route handler against a real @actual-app/api
 * engine on a local temp budget: no network, no sync server.
 *
 * `updateTransaction` applies through batchMessages, so a read issued right
 * after a write can show the state before that write flushed. The test
 * therefore polls (bounded) for the settled pair, then reads twice more to
 * prove it is stable.
 */
const os = require("os");
const path = require("path");
const fs = require("fs");

const mockApp = { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn(), use: jest.fn(), listen: jest.fn() };
jest.mock("express", () => {
    const expr = () => mockApp;
    expr.json = jest.fn(() => "json-mw");
    return expr;
});

// Only the sync-server plumbing is stubbed (init/getBudgets/downloadBudget have
// no server to talk to). Every read and write the route performs goes through
// the real engine on the local budget this test creates.
jest.mock("@actual-app/api", () => {
    const real = jest.requireActual("@actual-app/api");
    return {
        ...real,
        init: jest.fn(async () => {}),
        getBudgets: jest.fn(async () => [{ name: "test-budget", groupId: "local-620" }]),
        downloadBudget: jest.fn(async () => {}),
    };
});
const actual = require("@actual-app/api");
const realEngine = jest.requireActual("@actual-app/api");
require("../server");

const handler = mockApp.post.mock.calls.find(([p]) => p === "/transactions/link-transfer")[1];

async function poll(fn, ok, timeoutMs = 15000, stepMs = 50) {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
        last = await fn();
        if (ok(last) || Date.now() > deadline) return last;
        await new Promise((r) => setTimeout(r, stepMs));
    }
}

describe("link-transfer against the real Actual engine (#620)", () => {
    let dataDir, ids;
    const rowsById = async () => {
        const rows = await actual.getTransactions(undefined, "2000-01-01", "2100-01-01");
        return { rows, byId: new Map(rows.map((r) => [r.id, r])) };
    };

    beforeAll(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "actual-620-"));
        await realEngine.init({ dataDir });
        await actual.runImport("link-transfer-620", async () => {
            const a = await actual.createAccount({ name: "Out" }, 0);
            const b = await actual.createAccount({ name: "In" }, 0);
            const misc = await actual.createPayee({ name: "Misc" });
            await actual.addTransactions(a, [{ date: "2026-09-23", amount: -100000, payee: misc }]);
            await actual.addTransactions(b, [{ date: "2026-09-23", amount: 100000, payee: misc }]);
            ids = { a, b };
        });
    }, 60000);

    afterAll(async () => {
        try { await realEngine.shutdown(); } catch (_) {}
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it("links both legs in place, no counterpart row, and stays stable", async () => {
        const { rows } = await rowsById();
        const out = rows.find((r) => r.account === ids.a);
        const inc = rows.find((r) => r.account === ids.b);
        expect(rows).toHaveLength(2);

        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
        await handler({ query: {}, params: {}, body: { outgoing_id: out.id, incoming_id: inc.id } }, res);
        expect(res.statusCode).toBe(200);

        const linked = (s) =>
            s.byId.get(out.id)?.transfer_id === inc.id && s.byId.get(inc.id)?.transfer_id === out.id;
        const settled = await poll(rowsById, linked);
        expect(linked(settled)).toBe(true);

        // Stability: read twice more after settling.
        for (let i = 0; i < 2; i++) {
            await new Promise((r) => setTimeout(r, 200));
            const s = await rowsById();
            expect(linked(s)).toBe(true);
            expect(s.rows).toHaveLength(2);
            expect(s.byId.get(out.id).category ?? null).toBeNull();
            expect(s.byId.get(inc.id).category ?? null).toBeNull();
        }
    }, 60000);
});
