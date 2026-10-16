/**
 * Regression test for issue #519.
 *
 * `init()` fails fast when the configured primary budget name matches no
 * budget, which is the intended behaviour. `GET /budgets` must still answer in
 * that state: it is the only endpoint that can reveal the real budget names, so
 * a 500 there would hide the typo that caused the failure.
 *
 * This file owns its module registry so the configured primary budget can be
 * left unmatched without disturbing the suites that expect a successful init.
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
    deleteTransaction: jest.fn(),
    updateTransaction: jest.fn(),
}));

const actual = require("@actual-app/api");
require("../server");

function budgetsHandler() {
    const call = mockApp.get.mock.calls.find(([path]) => path === "/budgets");
    return call[1];
}

function mockRes() {
    return {
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
    };
}

beforeEach(() => {
    // Reset only the library stubs: clearing every mock would also wipe the
    // recorded mockApp.get calls that budgetsHandler() reads the route from.
    actual.init.mockReset();
    actual.getBudgets.mockReset();
    actual.downloadBudget.mockReset();
});

test("GET /budgets still lists budgets when the configured primary is missing", async () => {
    // jest.setup.js configures ACTUAL_PRIMARY_BUDGET_FILE="test-budget"; these
    // budgets do not include that name, so init() fails fast.
    actual.init.mockResolvedValue(undefined);
    actual.getBudgets.mockResolvedValue([
        { name: "Other Budget", groupId: "other-1" },
    ]);
    actual.downloadBudget.mockResolvedValue(undefined);
    const res = mockRes();

    await budgetsHandler()({ query: {}, body: null, params: {} }, res);

    expect(actual.downloadBudget).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([
        { name: "Other Budget", groupId: "other-1", cloudFileId: null },
    ]);
});

test("GET /budgets answers 500 when init fails for a non-budget reason", async () => {
    // An authentication failure must not be swallowed by the diagnostic
    // fallback: the real library resolves getBudgets() from local metadata even
    // when init() failed, so a 200 here would report success during an outage.
    actual.init.mockRejectedValue(new Error("Authentication failed"));
    actual.getBudgets.mockResolvedValue([
        { name: "Other Budget", groupId: "other-1" },
    ]);
    const res = mockRes();

    await budgetsHandler()({ query: {}, body: null, params: {} }, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Authentication failed" });
});
