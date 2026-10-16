/**
 * Regression tests for issue #390.
 *
 * The switch and the read used to be two separate critical sections: a route
 * called `ensureBudget(...)`, which took the lock only for the switch, and then
 * read the library's module-global active budget outside the lock. A concurrent
 * cross-budget request could switch the active budget in between, so a read
 * returned the other budget's data.
 *
 * The race test parks a read inside `actual.getAccounts`, lets a second budget
 * switch and finish, then releases the first read. On the unfixed base the
 * parked read sees the second budget's data.
 *
 * This file owns its module registry for the same reason `post_budget_race`
 * does: `initialized` and `activeSyncId` are module state, and
 * `server.test.js` relies on cross-block mock ordering.
 *
 * `BUDGET_SWITCH_DELAY_MS` is read when the server module loads, so it is set to
 * "0" before the require. The previous value is restored in `afterAll` because
 * `process.env` is shared by every test file in a jest worker.
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
const MYR = { name: "MYR", groupId: "myr-sync" };
const SGD_ACCOUNTS = [{ id: "acc-sgd", name: "SGD account" }];
const MYR_ACCOUNTS = [{ id: "acc-myr", name: "MYR account" }];

// @actual-app/api keeps one module-global active budget, so the mock models it:
// downloadBudget moves it, and getAccounts reports whichever budget is active
// at the moment it is called rather than when it was invoked.
let active;
let releaseFirstRead;
let firstReadGate;
let reads;

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

/** Let already-scheduled promise continuations run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Bounded poll, so the test never depends on a fixed sleep being long enough. */
async function waitFor(predicate, what) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
}

/**
 * Wait for `predicate` for up to `ms`, then give up and report whether it held.
 * The unfixed code satisfies the predicate while request A is parked; the fixed
 * code cannot, because B queues behind the lock A now holds across its read, so
 * the caller must stop waiting and release A.
 */
async function waitForOrTimeout(predicate, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return predicate();
}

beforeEach(async () => {
    // Reset only the library mocks: resetting mockApp would drop the route
    // registrations that findHandler reads.
    for (const fn of Object.values(actual)) {
        if (typeof fn.mockReset === "function") fn.mockReset();
    }
    active = "sgd-sync";
    reads = 0;
    actual.init.mockResolvedValue(undefined);
    actual.getBudgets.mockResolvedValue([SGD, MYR]);
    actual.downloadBudget.mockImplementation(async (syncId) => {
        active = syncId;
    });
    actual.getAccounts.mockResolvedValue([]);
    await server.init();
    actual.downloadBudget.mockClear();
    actual.getBudgets.mockClear();
});

describe("a read cannot be redirected by a concurrent budget switch (issue #390)", () => {
    test("GET /accounts returns the budget it named while another budget switches", async () => {
        firstReadGate = new Promise((resolve) => {
            releaseFirstRead = resolve;
        });
        actual.getAccounts.mockImplementation(async () => {
            const isFirstRead = reads === 0;
            reads += 1;
            // Park request A inside its read. On the unfixed base its budget
            // switch has already released the lock, so B can switch underneath.
            if (isFirstRead) await firstReadGate;
            return active === "sgd-sync" ? SGD_ACCOUNTS : MYR_ACCOUNTS;
        });

        const accounts = findHandler("get", "/accounts");
        const resA = mockRes();
        const pA = accounts(
            mockReq({ query: { budget_id: "sgd-sync" } }),
            resA,
        );
        await waitFor(() => reads === 1, "request A to enter its read");

        const resB = mockRes();
        const pB = accounts(
            mockReq({ query: { budget_id: "myr-sync" } }),
            resB,
        );
        await flush();
        // Unfixed: B switches and finishes while A is parked. Fixed: B cannot,
        // because A holds the lock across its read, so this wait times out and
        // A is released first.
        await waitForOrTimeout(() => active === "myr-sync", 200);

        releaseFirstRead();
        await pA;
        await pB;

        expect(resA.json).toHaveBeenCalledWith(SGD_ACCOUNTS);
        expect(resB.json).toHaveBeenCalledWith(MYR_ACCOUNTS);
    });
});

describe("a read that names an unknown budget is refused, not redirected", () => {
    test("GET /accounts answers 400 Unknown budget without reading the active budget", async () => {
        const accounts = findHandler("get", "/accounts");
        const res = mockRes();

        await accounts(
            mockReq({ query: { budget_id: "no-such-budget" } }),
            res,
        );

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: "Unknown budget" });
        expect(actual.getAccounts).not.toHaveBeenCalled();
    });

    test("GET /accounts without a budget_id keeps the active-budget fallback", async () => {
        actual.getAccounts.mockResolvedValue(SGD_ACCOUNTS);
        const accounts = findHandler("get", "/accounts");
        const res = mockRes();

        await accounts(mockReq(), res);

        expect(res.status).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(SGD_ACCOUNTS);
    });
});

describe("GET /budgets deduplicates the library's budget list", () => {
    test("drops duplicate entries that share a sync id", async () => {
        actual.getBudgets.mockResolvedValue([
            {
                name: "test-budget",
                groupId: "sgd-sync",
                cloudFileId: "cloud-sgd",
            },
            {
                name: "test-budget",
                groupId: "sgd-sync",
                cloudFileId: "cloud-sgd",
            },
            { name: "MYR", groupId: "myr-sync", cloudFileId: null },
        ]);
        const handler = findHandler("get", "/budgets");
        const res = mockRes();

        await handler(mockReq(), res);

        expect(res.json).toHaveBeenCalledWith([
            {
                name: "test-budget",
                groupId: "sgd-sync",
                cloudFileId: "cloud-sgd",
            },
            { name: "MYR", groupId: "myr-sync", cloudFileId: null },
        ]);
    });
});
