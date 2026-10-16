/**
 * Regression tests for issue #506.
 *
 * A mutating request must write into the budget it names, even when a
 * concurrent request switches the active budget between the budget check and
 * the write. `activeSyncId` is the only thing that decides which budget
 * `@actual-app/api` writes into, so it must not change between the check and
 * the write.
 *
 * This file owns its module registry on purpose. `server.test.js` requires
 * `../server` once and never resets modules, so by the time its route tests
 * run, `initialized` is already true and `activeSyncId` is whatever that file
 * seeded. A race test living there would observe an already-active budget and
 * pass on the unfixed base. Do not use `jest.resetModules()` inside
 * `server.test.js` either: `mockApp` accumulates registrations and its
 * `findHandler` returns the first, stale handler.
 *
 * `BUDGET_SWITCH_DELAY_MS` is read when the server module loads. It is set to
 * "0" before the require so the switches in these tests do not wait out the
 * production cooldown. The cooldown can only delay a switch after the first:
 * `lastSwitchTime` starts at 0, so `Date.now() - 0` already exceeds any sane
 * delay. The previous value is restored in `afterAll` because `process.env` is
 * shared by every test file in a jest worker.
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
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
}

/**
 * Put the server in a known state: initialised with SGD active, with the
 * download history cleared so each test starts from an empty call log.
 */
async function primeSgd() {
    await server.init();
    const payees = findHandler("get", "/payees");
    await payees(mockReq({ query: { budget_id: "sgd-sync" } }), mockRes());
    actual.getBudgets.mockClear();
    actual.downloadBudget.mockClear();
}

beforeEach(async () => {
    // Reset only the library mocks: resetting mockApp would drop the route
    // registrations that findHandler reads.
    for (const fn of Object.values(actual)) {
        if (typeof fn.mockReset === "function") fn.mockReset();
    }
    actual.init.mockResolvedValue(undefined);
    actual.getBudgets.mockResolvedValue([SGD, MYR]);
    actual.downloadBudget.mockResolvedValue(undefined);
    actual.getPayees.mockResolvedValue([]);
    actual.getTransactions.mockResolvedValue([]);
    actual.addTransactions.mockResolvedValue(["ok"]);
    actual.updateTransaction.mockResolvedValue(undefined);
    actual.deleteTransaction.mockResolvedValue(undefined);
    await primeSgd();
});

/**
 * Park a MYR switch inside the lock (its downloadBudget never settles), start
 * `invokeA` as a request that names the still-active SGD budget, then let the
 * switch finish. On the unfixed base such a request passes its budget check,
 * queues for the write lock, and then writes after MYR became active.
 */
async function raceWithBudgetSwitch(invokeA) {
    let releaseMyr;
    const myrGate = new Promise((resolve) => {
        releaseMyr = resolve;
    });
    actual.downloadBudget.mockImplementation((syncId) =>
        syncId === "myr-sync" ? myrGate : Promise.resolve(),
    );

    const payees = findHandler("get", "/payees");
    const resB = mockRes();
    const pB = payees(mockReq({ query: { budget_id: "myr-sync" } }), resB);
    await waitFor(
        () =>
            actual.downloadBudget.mock.calls.some(([id]) => id === "myr-sync"),
        "the MYR switch to reach downloadBudget",
    );

    const resA = mockRes();
    const pA = invokeA(resA);
    await flush();

    releaseMyr();
    await pB;
    await pA;

    return {
        resA,
        resB,
        downloads: actual.downloadBudget.mock.calls.map(([id]) => id),
    };
}

describe("a concurrent budget switch cannot redirect a write (issue #506)", () => {
    test("POST /transactions re-asserts the named budget before it inserts", async () => {
        const post = findHandler("post", "/transactions");

        const { resA, downloads } = await raceWithBudgetSwitch((resA) =>
            post(
                mockReq({
                    body: {
                        budget_id: "sgd-sync",
                        account: "acc-sgd",
                        date: "2026-09-01",
                        amount: -1280,
                        notes: "race A",
                    },
                }),
                resA,
            ),
        );

        // The MYR switch happened first; the insert must have re-asserted SGD
        // after taking the lock, so SGD is the last budget downloaded.
        expect(downloads).toEqual(["myr-sync", "sgd-sync"]);
        expect(actual.addTransactions).toHaveBeenCalledTimes(1);
        const [account, transactions] = actual.addTransactions.mock.calls[0];
        expect(account).toBe("acc-sgd");
        expect(transactions[0].notes).toBe("race A");
        expect(resA.json).toHaveBeenCalledWith(
            expect.objectContaining({ account: "acc-sgd" }),
        );
    });

    test("POST /transactions does not insert while the switch holds the lock", async () => {
        const post = findHandler("post", "/transactions");

        let releaseMyr;
        const myrGate = new Promise((resolve) => {
            releaseMyr = resolve;
        });
        actual.downloadBudget.mockImplementation((syncId) =>
            syncId === "myr-sync" ? myrGate : Promise.resolve(),
        );

        const payees = findHandler("get", "/payees");
        const pB = payees(
            mockReq({ query: { budget_id: "myr-sync" } }),
            mockRes(),
        );
        await waitFor(
            () =>
                actual.downloadBudget.mock.calls.some(
                    ([id]) => id === "myr-sync",
                ),
            "the MYR switch to reach downloadBudget",
        );

        const pA = post(
            mockReq({
                body: {
                    budget_id: "sgd-sync",
                    account: "acc-sgd",
                    date: "2026-09-01",
                    amount: -500,
                },
            }),
            mockRes(),
        );
        await flush();
        expect(actual.addTransactions).not.toHaveBeenCalled();

        releaseMyr();
        await pB;
        await pA;
    });

    test("DELETE /transactions/:id re-asserts the named budget before it deletes", async () => {
        const handler = findHandler("delete", "/transactions/:id");

        const { downloads, resA } = await raceWithBudgetSwitch((resA) =>
            handler(
                mockReq({
                    body: { budget_id: "sgd-sync" },
                    params: { id: "txn-sgd" },
                }),
                resA,
            ),
        );

        expect(downloads).toEqual(["myr-sync", "sgd-sync"]);
        expect(actual.deleteTransaction).toHaveBeenCalledWith("txn-sgd");
        expect(resA.json).toHaveBeenCalledWith(
            expect.objectContaining({ id: "txn-sgd" }),
        );
    });

    test("POST /transactions/:id/clear re-asserts the named budget before it updates", async () => {
        const handler = findHandler("post", "/transactions/:id/clear");

        const { downloads } = await raceWithBudgetSwitch((resA) =>
            handler(
                mockReq({
                    body: { budget_id: "sgd-sync" },
                    params: { id: "txn-sgd" },
                }),
                resA,
            ),
        );

        expect(downloads).toEqual(["myr-sync", "sgd-sync"]);
        expect(actual.updateTransaction).toHaveBeenCalledWith("txn-sgd", {
            cleared: true,
        });
    });

    test("POST /transactions/:id/unclear re-asserts the named budget before it updates", async () => {
        const handler = findHandler("post", "/transactions/:id/unclear");

        const { downloads } = await raceWithBudgetSwitch((resA) =>
            handler(
                mockReq({
                    body: { budget_id: "sgd-sync" },
                    params: { id: "txn-sgd" },
                }),
                resA,
            ),
        );

        expect(downloads).toEqual(["myr-sync", "sgd-sync"]);
        expect(actual.updateTransaction).toHaveBeenCalledWith("txn-sgd", {
            cleared: false,
        });
    });

    test("PATCH /transactions/:id re-asserts the named budget before it updates", async () => {
        const handler = findHandler("patch", "/transactions/:id");

        const { downloads, resA } = await raceWithBudgetSwitch((resA) =>
            handler(
                mockReq({
                    body: { budget_id: "sgd-sync", notes: "patched" },
                    params: { id: "txn-sgd" },
                }),
                resA,
            ),
        );

        expect(downloads).toEqual(["myr-sync", "sgd-sync"]);
        expect(actual.updateTransaction).toHaveBeenCalledWith("txn-sgd", {
            notes: "patched",
        });
        expect(resA.json).toHaveBeenCalledWith(
            expect.objectContaining({ status: "updated", id: "txn-sgd" }),
        );
    });
});

describe("a named budget that does not exist is refused, not redirected", () => {
    const routes = [
        {
            name: "POST /transactions",
            method: "post",
            path: "/transactions",
            request: {
                body: { account: "acc-sgd", date: "2026-09-01", amount: -100 },
            },
            mutation: () => actual.addTransactions,
        },
        {
            name: "DELETE /transactions/:id",
            method: "delete",
            path: "/transactions/:id",
            request: { params: { id: "txn-sgd" } },
            mutation: () => actual.deleteTransaction,
        },
        {
            name: "PATCH /transactions/:id",
            method: "patch",
            path: "/transactions/:id",
            request: { params: { id: "txn-sgd" }, body: { notes: "patched" } },
            mutation: () => actual.updateTransaction,
        },
        {
            name: "POST /transactions/:id/clear",
            method: "post",
            path: "/transactions/:id/clear",
            request: { params: { id: "txn-sgd" } },
            mutation: () => actual.updateTransaction,
        },
        {
            name: "POST /transactions/:id/unclear",
            method: "post",
            path: "/transactions/:id/unclear",
            request: { params: { id: "txn-sgd" } },
            mutation: () => actual.updateTransaction,
        },
    ];

    test.each(routes)(
        "$name answers 400 Unknown budget without mutating or switching",
        async ({ method, path, request, mutation }) => {
            const handler = findHandler(method, path);
            const res = mockRes();

            await handler(
                mockReq({
                    ...request,
                    body: {
                        budget_id: "no-such-budget",
                        ...(request.body || {}),
                    },
                }),
                res,
            );

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({ error: "Unknown budget" });
            expect(mutation()).not.toHaveBeenCalled();
            expect(actual.downloadBudget).not.toHaveBeenCalled();
        },
    );

    test("a request that names no budget keeps the active-budget fallback", async () => {
        const post = findHandler("post", "/transactions");
        const res = mockRes();

        await post(
            mockReq({
                body: {
                    account: "acc-sgd",
                    date: "2026-09-01",
                    amount: -100,
                },
            }),
            res,
        );

        expect(res.status).not.toHaveBeenCalled();
        expect(actual.downloadBudget).not.toHaveBeenCalled();
        expect(actual.addTransactions).toHaveBeenCalledTimes(1);
    });

    test("a POST payload error takes precedence over an unknown budget", async () => {
        const post = findHandler("post", "/transactions");
        const res = mockRes();

        await post(mockReq({ body: { budget_id: "no-such-budget" } }), res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: "Account is required" });
        expect(actual.downloadBudget).not.toHaveBeenCalled();
    });

    test("a PATCH with no updatable fields takes precedence over an unknown budget", async () => {
        const handler = findHandler("patch", "/transactions/:id");
        const res = mockRes();

        await handler(
            mockReq({
                body: { budget_id: "no-such-budget" },
                params: { id: "txn-sgd" },
            }),
            res,
        );

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: "No fields to update" });
        expect(actual.downloadBudget).not.toHaveBeenCalled();
    });
});

describe("the already-active budget path stays cheap and deadlock-free", () => {
    test("POST /transactions with the active budget inserts without a switch", async () => {
        const post = findHandler("post", "/transactions");
        const res = mockRes();

        await post(
            mockReq({
                body: {
                    budget_id: "sgd-sync",
                    account: "acc-sgd",
                    date: "2026-09-01",
                    amount: -100,
                },
            }),
            res,
        );

        expect(actual.downloadBudget).not.toHaveBeenCalled();
        expect(actual.addTransactions).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });

    test("PATCH with no fields still answers 400 without switching budgets", async () => {
        const handler = findHandler("patch", "/transactions/:id");
        const res = mockRes();

        await handler(
            mockReq({
                body: { budget_id: "sgd-sync" },
                params: { id: "txn-sgd" },
            }),
            res,
        );

        expect(res.status).toHaveBeenCalledWith(400);
        expect(actual.downloadBudget).not.toHaveBeenCalled();
        expect(actual.updateTransaction).not.toHaveBeenCalled();
    });
});
