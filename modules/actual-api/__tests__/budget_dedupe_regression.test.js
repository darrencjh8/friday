/**
 * Regression test for the dedupe wrapper dropping the configured budget name
 * (issue #390 follow-up).
 *
 * The library can list one budget once per DATA_DIR copy: same sync id, often a
 * different name. The shared lookup used to deduplicate by sync id and keep the
 * first twin, so when the twin that carried the configured
 * `ACTUAL_PRIMARY_BUDGET_FILE` name came second, `init()` failed and every read
 * answered 500 `Budget "test-budget" not found`. Duplicates are now harmless in
 * the lookup path, and only `GET /budgets` deduplicates for display.
 *
 * This file owns its module registry because `initialized` and `activeSyncId`
 * are module state and the mocked list must be the twin-bearing one.
 */
jest.mock("fs", () => ({ mkdirSync: jest.fn() }));

const mockApp = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    use: jest.fn(),
    listen: jest.fn(),
};

jest.mock("express", () => {
    const expr = () => mockApp;
    expr.json = jest.fn(() => "json-mw");
    return expr;
});

jest.mock("@actual-app/api", () => ({
    init: jest.fn(),
    getBudgets: jest.fn(),
    downloadBudget: jest.fn(),
    getAccounts: jest.fn(),
    getCategories: jest.fn(),
    getPayees: jest.fn(),
    getTransactions: jest.fn(),
    addTransactions: jest.fn(),
    updateTransaction: jest.fn(),
    deleteTransaction: jest.fn(),
    getAccountBalance: jest.fn(),
}));

// The switch cooldown is read when the server module loads; zero keeps the
// later tests, which request budgets under other sync ids, from waiting.
process.env.BUDGET_SWITCH_DELAY_MS = "0";

const actual = require("@actual-app/api");
require("../server");

// jest.setup.js sets ACTUAL_PRIMARY_BUDGET_FILE="test-budget". The configured
// budget is the SECOND entry on purpose: deduplicating by sync id and keeping
// the first entry dropped it.
const BUDGETS = [
    { name: "Renamed SGD", groupId: "g1", cloudFileId: "cloud-g1" },
    { name: "test-budget", groupId: "g1", cloudFileId: "cloud-g1" },
];
const ACCOUNTS = [{ id: "acc-1", name: "SGD account" }];

function findHandler(method, path) {
    const call = mockApp[method].mock.calls.find(([p]) => p === path);
    return call ? call[1] : null;
}

function mockRes() {
    return {
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
    };
}

function mockReq(overrides = {}) {
    return { query: {}, body: null, params: {}, ...overrides };
}

beforeEach(() => {
    // Reset only the library stubs: resetting mockApp would drop the recorded
    // route registrations that findHandler reads.
    actual.init.mockReset();
    actual.getBudgets.mockReset();
    actual.downloadBudget.mockReset();
    actual.getAccounts.mockReset();
    actual.init.mockResolvedValue(undefined);
    actual.getBudgets.mockResolvedValue(BUDGETS);
    actual.downloadBudget.mockResolvedValue(undefined);
    actual.getAccounts.mockResolvedValue(ACCOUNTS);
});

test("GET /accounts serves the configured budget whose same-id twin is listed first", async () => {
    const handler = findHandler("get", "/accounts");
    const res = mockRes();

    await handler(mockReq({ query: { budget_id: "test-budget" } }), res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(ACCOUNTS);
    expect(actual.downloadBudget).toHaveBeenCalledWith("g1", {
        password: undefined,
    });
});

test("GET /budgets returns one entry per sync id and prefers the configured name", async () => {
    const handler = findHandler("get", "/budgets");
    const res = mockRes();

    await handler(mockReq(), res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([
        { name: "test-budget", groupId: "g1", cloudFileId: "cloud-g1" },
    ]);
});

test("logs dropped duplicates on every GET /budgets call, not once per process", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
        const handler = findHandler("get", "/budgets");
        await handler(mockReq(), mockRes());
        await handler(mockReq(), mockRes());

        const dropLogs = logSpy.mock.calls.filter(
            ([message]) =>
                typeof message === "string" && message.includes("dropped"),
        );
        expect(dropLogs).toHaveLength(2);
        // The drop must name the entry that went away and the entry that stayed,
        // so a name collision between same-sync-id copies is diagnosable.
        for (const [message] of dropLogs) {
            expect(message).toContain('"Renamed SGD"');
            expect(message).toContain("sync id g1");
            expect(message).toContain('kept "test-budget"');
        }
    } finally {
        logSpy.mockRestore();
    }
});

test("GET /budgets keeps the configured name when it is the first twin", async () => {
    // Same-sync-id twins with the configured name first: the later entry must be
    // dropped, not allowed to replace it, because the configured entry already
    // names the budget the process loads.
    actual.getBudgets.mockResolvedValue([
        { name: "test-budget", groupId: "first-1", cloudFileId: "cloud-f1" },
        { name: "Renamed Later", groupId: "first-1", cloudFileId: "cloud-f1" },
    ]);
    const handler = findHandler("get", "/budgets");
    const res = mockRes();

    await handler(mockReq(), res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([
        { name: "test-budget", groupId: "first-1", cloudFileId: "cloud-f1" },
    ]);
});

test("duplicates in the raw getBudgets() list do not break name or sync-id resolution", async () => {
    // The raw library list keeps both twins; only the display route deduplicates.
    // A request that names the budget by its configured name and one that names
    // it by sync id must both resolve it.
    actual.getBudgets.mockResolvedValue([
        { name: "Renamed Again", groupId: "dup-2", cloudFileId: "cloud-d2" },
        { name: "test-budget", groupId: "dup-2", cloudFileId: "cloud-d2" },
    ]);
    actual.getAccounts.mockResolvedValue(ACCOUNTS);

    const byName = mockRes();
    await findHandler("get", "/accounts")(
        mockReq({ query: { budget_id: "test-budget" } }),
        byName,
    );
    expect(byName.status).not.toHaveBeenCalled();
    expect(byName.json).toHaveBeenCalledWith(ACCOUNTS);

    const bySyncId = mockRes();
    await findHandler("get", "/accounts")(
        mockReq({ query: { budget_id: "dup-2" } }),
        bySyncId,
    );
    expect(bySyncId.status).not.toHaveBeenCalled();
    expect(bySyncId.json).toHaveBeenCalledWith(ACCOUNTS);
    expect(actual.downloadBudget).toHaveBeenCalledWith("dup-2", {
        password: undefined,
    });
});
