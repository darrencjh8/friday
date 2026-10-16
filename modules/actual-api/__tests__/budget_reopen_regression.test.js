/**
 * Regression tests for issue #549.
 *
 * `@actual-app/api` closes the currently open budget before it fetches the next
 * one, so a `downloadBudget` (or a switch) that fails on the sync server leaves
 * the process with no budget open while `activeSyncId` still names the budget
 * that used to be loaded. Every budget-scoped read then throws the library's
 * "No budget file is open" and the route answers 500 until the process restarts.
 *
 * These tests drive the route, because `withBudget` is the production path and
 * it is not exported.
 *
 * This file owns its module registry for the same reason `read_budget_race`
 * does: `initialized` and `activeSyncId` are module state.
 *
 * `BUDGET_SWITCH_DELAY_MS` is read when the server module loads, so it is set to
 * "0" before the require; `process.env` is shared by every test file in a jest
 * worker, so the previous value is restored in `afterAll`.
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
    getCategories: jest.fn(),
    getPayees: jest.fn(),
    getTransactions: jest.fn(),
    addTransactions: jest.fn(),
    updateTransaction: jest.fn(),
    deleteTransaction: jest.fn(),
    getAccountBalance: jest.fn(),
}));

const actual = require("@actual-app/api");
const server = require("../server");

// jest.setup.js sets ACTUAL_PRIMARY_BUDGET_FILE="test-budget", and init() picks
// the budget whose name matches it.
const SGD = { name: "test-budget", groupId: "sgd-sync" };
const SGD_ACCOUNTS = [{ id: "acc-sgd", name: "SGD account" }];
const NO_BUDGET_OPEN = new Error("No budget file is open");

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

beforeEach(async () => {
    for (const fn of Object.values(actual)) {
        if (typeof fn.mockReset === "function") fn.mockReset();
    }
    actual.init.mockResolvedValue(undefined);
    actual.getBudgets.mockResolvedValue([SGD]);
    actual.downloadBudget.mockResolvedValue(undefined);
    actual.getAccounts.mockResolvedValue(SGD_ACCOUNTS);
    await server.init();
    actual.downloadBudget.mockClear();
    actual.getBudgets.mockClear();
});

describe("a request re-opens the budget the library closed (issue #549)", () => {
    test("GET /accounts re-downloads the named budget when none is open", async () => {
        // The probe inside the switch sees the library's no-budget state; the
        // route's own read then succeeds only because the budget was reopened.
        actual.getAccounts
            .mockRejectedValueOnce(NO_BUDGET_OPEN)
            .mockResolvedValue(SGD_ACCOUNTS);

        const accounts = findHandler("get", "/accounts");
        const res = mockRes();

        await accounts(mockReq({ query: { budget_id: "sgd-sync" } }), res);

        expect(actual.downloadBudget).toHaveBeenCalledWith(
            "sgd-sync",
            expect.any(Object),
        );
        expect(res.status).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(SGD_ACCOUNTS);
    });

    test("GET /accounts re-opens the active budget when the request names none", async () => {
        actual.getAccounts
            .mockRejectedValueOnce(NO_BUDGET_OPEN)
            .mockResolvedValue(SGD_ACCOUNTS);

        const accounts = findHandler("get", "/accounts");
        const res = mockRes();

        await accounts(mockReq(), res);

        expect(actual.downloadBudget).toHaveBeenCalledWith(
            "sgd-sync",
            expect.any(Object),
        );
        expect(res.json).toHaveBeenCalledWith(SGD_ACCOUNTS);
    });

    test("GET /accounts does not re-download while the budget stays open", async () => {
        const accounts = findHandler("get", "/accounts");
        const res = mockRes();

        await accounts(mockReq({ query: { budget_id: "sgd-sync" } }), res);

        expect(actual.downloadBudget).not.toHaveBeenCalled();
        // The probe plus the route's own read: dropping the probe to save the
        // call would leave this at one and reopen unconditionally instead.
        expect(actual.getAccounts).toHaveBeenCalledTimes(2);
        expect(res.json).toHaveBeenCalledWith(SGD_ACCOUNTS);
    });

    test("GET /accounts rethrows a probe failure that is not the no-budget state", async () => {
        actual.getAccounts.mockRejectedValueOnce(
            new Error("spreadsheet is corrupt"),
        );

        const accounts = findHandler("get", "/accounts");
        const res = mockRes();

        await accounts(mockReq({ query: { budget_id: "sgd-sync" } }), res);

        expect(actual.downloadBudget).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            error: "spreadsheet is corrupt",
        });
    });
});
