/**
 * Regression tests for issue #73.
 *
 * Every request that names a budget resolved it with a fresh
 * `actual.getBudgets()`, which asks the sync server for its file list, and the
 * resolution runs outside the budget lock. A burst of concurrent requests
 * therefore sent one file-list request each, and the sync server answered the
 * burst with HTTP 429 (over 1,600 logged in one minute after a deploy).
 *
 * The fix shares one budget list between concurrent resolutions and reuses it
 * for a short time, so a burst costs one file-list request.
 *
 * This file owns its module registry for the same reason `read_budget_race`
 * does: `initialized` and the cached list are module state.
 */
const previousDelay = process.env.BUDGET_SWITCH_DELAY_MS;
process.env.BUDGET_SWITCH_DELAY_MS = "0";

jest.mock("fs", () => ({ mkdirSync: jest.fn() }));

afterAll(() => {
    if (previousDelay === undefined) delete process.env.BUDGET_SWITCH_DELAY_MS;
    else process.env.BUDGET_SWITCH_DELAY_MS = previousDelay;
});

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
}));

const actual = require("@actual-app/api");
const server = require("../server");

// jest.setup.js sets ACTUAL_PRIMARY_BUDGET_FILE="test-budget".
const SGD = { name: "test-budget", groupId: "sgd-sync" };
const MYR = { name: "MYR", groupId: "myr-sync" };

function accountsHandler() {
    return mockApp.get.mock.calls.find(([p]) => p === "/accounts")[1];
}

function mockRes() {
    return {
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
    };
}

beforeAll(() => {
    actual.init.mockResolvedValue(undefined);
    actual.downloadBudget.mockResolvedValue(undefined);
    actual.getAccounts.mockResolvedValue([]);
    // Resolve on a later tick, as the real network call does, so concurrent
    // callers overlap the way a burst does in production.
    actual.getBudgets.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([SGD, MYR]), 5)),
    );
});

test("a burst of budget-named requests fetches the budget list once", async () => {
    const handler = accountsHandler();
    const responses = [];
    const burst = [];
    for (let i = 0; i < 20; i++) {
        const res = mockRes();
        responses.push(res);
        const budget = i % 2 === 0 ? "MYR" : "test-budget";
        burst.push(handler({ query: { budget_id: budget }, body: null, params: {} }, res));
    }
    await Promise.all(burst);

    for (const res of responses) expect(res.status).not.toHaveBeenCalled();
    // init() reads the list once to find the primary budget; the 20 requests
    // must share one more read at most, not send one each.
    expect(actual.getBudgets.mock.calls.length).toBeLessThanOrEqual(2);
});

test("the budget list is reused for a minute, then fetched again", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "setTimeout"] });
    try {
        server.resetBudgetListCache();
        const handler = accountsHandler();
        actual.getBudgets.mockClear();
        const req = () => ({ query: { budget_id: "MYR" }, body: null, params: {} });

        await handler(req(), mockRes());
        await handler(req(), mockRes());
        expect(actual.getBudgets).toHaveBeenCalledTimes(1);

        jest.setSystemTime(Date.now() + 61 * 1000);
        await handler(req(), mockRes());
        expect(actual.getBudgets).toHaveBeenCalledTimes(2);
    } finally {
        jest.useRealTimers();
    }
});

test("a rejected budget list is not cached", async () => {
    server.resetBudgetListCache();
    const handler = accountsHandler();
    actual.getBudgets.mockReset();
    actual.getBudgets.mockRejectedValueOnce(new Error("Unauthorized"));
    actual.getBudgets.mockResolvedValue([SGD, MYR]);

    const failed = mockRes();
    await handler({ query: { budget_id: "MYR" }, body: null, params: {} }, failed);
    expect(failed.status).toHaveBeenCalledWith(500);

    const ok = mockRes();
    await handler({ query: { budget_id: "MYR" }, body: null, params: {} }, ok);
    expect(ok.status).not.toHaveBeenCalled();
    expect(actual.getBudgets).toHaveBeenCalledTimes(2);
});
