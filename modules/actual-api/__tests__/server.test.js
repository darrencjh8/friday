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
    getAccountBalance: jest.fn(),
    getBudgetMonth: jest.fn(),
    getSchedules: jest.fn(),
}));

const { getBudgetId, buildTransaction, readWindow } = require("../server");

describe("getBudgetId", () => {
    test("returns budget_id from query param", () => {
        const req = { query: { budget_id: "abc123" }, body: {} };
        expect(getBudgetId(req)).toBe("abc123");
    });

    test("returns budget_id from body when query is absent", () => {
        const req = { query: {}, body: { budget_id: "body-id" } };
        expect(getBudgetId(req)).toBe("body-id");
    });

    test("query param takes priority over body", () => {
        const req = {
            query: { budget_id: "query-wins" },
            body: { budget_id: "body-loses" },
        };
        expect(getBudgetId(req)).toBe("query-wins");
    });

    test("returns empty string when neither query nor body has budget_id", () => {
        expect(getBudgetId({ query: {}, body: {} })).toBe("");
        expect(getBudgetId({ query: {} })).toBe("");
    });

    test("returns empty string when body is null", () => {
        const req = { query: {}, body: null };
        expect(getBudgetId(req)).toBe("");
    });

    test("returns empty string when body is undefined", () => {
        const req = { query: {} };
        expect(getBudgetId(req)).toBe("");
    });
});

describe("buildTransaction", () => {
    test("constructs transaction with all fields provided", () => {
        const body = {
            account: "acc-1",
            date: "2025-06-01",
            amount: -1280,
            payee_name: "NTUC FairPrice",
            imported_payee: "FAIRPRICE SINGAPORE",
            notes: "Groceries",
            category: "abc-cat-1",
        };
        const txn = buildTransaction(body);
        expect(txn).toEqual({
            account: "acc-1",
            date: "2025-06-01",
            amount: -1280,
            payee_name: "NTUC FairPrice",
            imported_payee: "FAIRPRICE SINGAPORE",
            notes: "Groceries",
            cleared: false,
            category: "abc-cat-1",
        });
    });

    test("uses account_id when account is missing", () => {
        const body = { account_id: "acc-2", amount: 500 };
        const txn = buildTransaction(body);
        expect(txn.account).toBe("acc-2");
    });

    test("account takes priority over account_id", () => {
        const body = { account: "primary", account_id: "fallback" };
        const txn = buildTransaction(body);
        expect(txn.account).toBe("primary");
    });

    test("payee_name falls back to imported_payee", () => {
        const body = { imported_payee: "SHOPEE SINGAPORE" };
        const txn = buildTransaction(body);
        expect(txn.payee_name).toBe("SHOPEE SINGAPORE");
        expect(txn.imported_payee).toBe("SHOPEE SINGAPORE");
    });

    test("imported_payee falls back to payee_name", () => {
        const body = { payee_name: "Grab" };
        const txn = buildTransaction(body);
        expect(txn.payee_name).toBe("Grab");
        expect(txn.imported_payee).toBe("Grab");
    });

    test("payee_name takes priority over imported_payee", () => {
        const body = { payee_name: "Priority", imported_payee: "Fallback" };
        const txn = buildTransaction(body);
        expect(txn.payee_name).toBe("Priority");
        expect(txn.imported_payee).toBe("Fallback");
    });

    test("payee_name is undefined when both payee fields are missing", () => {
        const body = {};
        const txn = buildTransaction(body);
        expect(txn.payee_name).toBeUndefined();
    });

    test("date defaults to today in YYYY-MM-DD format", () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2025-06-15T10:30:00Z"));
        const txn = buildTransaction({});
        expect(txn.date).toBe("2025-06-15");
        jest.useRealTimers();
    });

    test("amount defaults to 0", () => {
        const txn = buildTransaction({});
        expect(txn.amount).toBe(0);
    });

    test("amount 0 is preserved (not replaced despite falsy)", () => {
        const txn = buildTransaction({ amount: 0 });
        expect(txn.amount).toBe(0);
    });

    test("notes defaults to empty string", () => {
        const txn = buildTransaction({});
        expect(txn.notes).toBe("");
    });

    test("cleared is always false", () => {
        const txn = buildTransaction({ amount: 100 });
        expect(txn.cleared).toBe(false);
    });

    test("category is added only when provided", () => {
        expect(buildTransaction({})).not.toHaveProperty("category");
        expect(buildTransaction({ category: "cat-x" })).toHaveProperty(
            "category",
            "cat-x",
        );
    });

    test("category is not added when it is an empty string (falsy)", () => {
        const txn = buildTransaction({ category: "" });
        expect(txn).not.toHaveProperty("category");
    });

    test("empty body produces valid defaults", () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        const txn = buildTransaction({});
        expect(txn).toEqual({
            account: undefined,
            date: "2025-01-01",
            amount: 0,
            payee_name: undefined,
            imported_payee: undefined,
            notes: "",
            cleared: false,
        });
        jest.useRealTimers();
    });
});

describe("Route handlers", () => {
    const actual = require("@actual-app/api");

    function findHandler(method, path) {
        const call = mockApp[method].mock.calls.find(([p]) => p === path);
        return call ? call[1] : null;
    }

    function mockReq(overrides = {}) {
        return { query: {}, body: null, params: {}, ...overrides };
    }

    function mockRes() {
        return {
            json: jest.fn().mockReturnThis(),
            status: jest.fn().mockReturnThis(),
        };
    }

    beforeEach(() => {
        actual.init.mockReset();
        actual.getBudgets.mockReset();
        actual.downloadBudget.mockReset();
        actual.getTransactions.mockReset();
        actual.updateTransaction.mockReset();
        actual.addTransactions.mockReset();
        actual.deleteTransaction.mockReset();
        actual.getBudgetMonth.mockReset();
        actual.getSchedules && actual.getSchedules.mockReset();

        actual.init.mockResolvedValue(undefined);
        actual.getBudgets.mockResolvedValue([
            { name: "test-budget", groupId: "g1" },
        ]);
        actual.downloadBudget.mockResolvedValue(undefined);
        actual.getTransactions.mockResolvedValue([]);
        actual.updateTransaction.mockResolvedValue(undefined);
        actual.addTransactions.mockResolvedValue(["txn-new"]);
        actual.deleteTransaction.mockResolvedValue(undefined);
        actual.getBudgetMonth.mockResolvedValue({ month: "2026-08" });
    });

    test("GET /schedules returns the schedule list", async () => {
        actual.getSchedules = jest.fn().mockResolvedValue([
            { id: "s1", name: "Prepare: Rent", next_date: "2026-09-19" },
        ]);
        const handler = findHandler("get", "/schedules");
        const res = mockRes();
        await handler(mockReq({ query: { budget_id: "test-budget" } }), res);
        expect(res.json).toHaveBeenCalledWith([
            { id: "s1", name: "Prepare: Rent", next_date: "2026-09-19" },
        ]);
    });

    test("GET /schedules answers an empty list rather than failing", async () => {
        actual.getSchedules = jest.fn().mockResolvedValue(null);
        const handler = findHandler("get", "/schedules");
        const res = mockRes();
        await handler(mockReq({ query: { budget_id: "test-budget" } }), res);
        expect(res.json).toHaveBeenCalledWith([]);
    });

    test("GET /schedules rejects an unknown budget", async () => {
        actual.getSchedules = jest.fn().mockResolvedValue([]);
        const handler = findHandler("get", "/schedules");
        const res = mockRes();
        await handler(mockReq({ query: { budget_id: "nope" } }), res);
        expect(res.status).toHaveBeenCalledWith(400);
    });

    test("GET /health returns { status: 'ok' }", () => {
        const handler = findHandler("get", "/health");
        const req = mockReq();
        const res = mockRes();
        handler(req, res);
        expect(res.json).toHaveBeenCalledWith({ status: "ok" });
    });

    test("GET /transactions filters out cleared when cleared=false", async () => {
        actual.getTransactions.mockResolvedValue([
            { id: "1", cleared: false, amount: 100 },
            { id: "2", cleared: true, amount: 200 },
            { id: "3", cleared: false, amount: 300 },
        ]);
        const handler = findHandler("get", "/transactions");
        const req = mockReq({
            query: { cleared: "false", account_id: "acc1" },
        });
        const res = mockRes();

        await handler(req, res);

        expect(res.json).toHaveBeenCalledWith([
            { id: "1", cleared: false, amount: 100 },
            { id: "3", cleared: false, amount: 300 },
        ]);
    });

    test("GET /transactions returns all when cleared is not 'false'", async () => {
        actual.getTransactions.mockResolvedValue([
            { id: "1", cleared: false, amount: 100 },
            { id: "2", cleared: true, amount: 200 },
        ]);
        const handler = findHandler("get", "/transactions");
        const req = mockReq({ query: { account_id: "acc1" } });
        const res = mockRes();

        await handler(req, res);

        expect(res.json).toHaveBeenCalledWith([
            { id: "1", cleared: false, amount: 100 },
            { id: "2", cleared: true, amount: 200 },
        ]);
    });

    test("POST /transactions/:id/clear sets cleared directly without getTransaction", async () => {
        const handler = findHandler("post", "/transactions/:id/clear");
        const req = mockReq({
            params: { id: "txn-2" },
            body: { notes: "Statement May 2026" },
        });
        const res = mockRes();

        await handler(req, res);

        expect(actual.updateTransaction).toHaveBeenCalledWith("txn-2", {
            cleared: true,
            notes: "Statement May 2026",
        });
        expect(res.json).toHaveBeenCalledWith({
            status: "cleared",
            id: "txn-2",
        });
    });

    test("POST /transactions/:id/clear clears without notes", async () => {
        const handler = findHandler("post", "/transactions/:id/clear");
        const req = mockReq({
            params: { id: "txn-3" },
            body: {},
        });
        const res = mockRes();

        await handler(req, res);

        expect(actual.updateTransaction).toHaveBeenCalledWith("txn-3", {
            cleared: true,
        });
    });

    test("POST /transactions/:id/unclear sets cleared to false", async () => {
        const handler = findHandler("post", "/transactions/:id/unclear");
        const req = mockReq({
            params: { id: "txn-2" },
            body: {},
        });
        const res = mockRes();

        await handler(req, res);

        expect(actual.updateTransaction).toHaveBeenCalledWith("txn-2", {
            cleared: false,
        });
        expect(res.json).toHaveBeenCalledWith({
            status: "uncleared",
            id: "txn-2",
        });
    });

    test("route error returns 500 with error.message in JSON body", async () => {
        actual.getTransactions.mockRejectedValue(
            new Error("DB connection failed"),
        );
        const handler = findHandler("get", "/transactions");
        const req = mockReq();
        const res = mockRes();

        await handler(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            error: "DB connection failed",
        });
    });

    test("DELETE /transactions/:id deletes and returns confirmation", async () => {
        actual.deleteTransaction.mockResolvedValue(undefined);
        const handler = findHandler("delete", "/transactions/:id");
        const req = mockReq({ params: { id: "del-1" } });
        const res = mockRes();

        await handler(req, res);

        expect(actual.deleteTransaction).toHaveBeenCalledWith("del-1");
        expect(res.json).toHaveBeenCalledWith({
            status: "deleted",
            id: "del-1",
        });
    });

    describe("PATCH /transactions/:id", () => {
        it("forwards a null category to clear it", async () => {
            const handler = findHandler("patch", "/transactions/:id");
            const req = mockReq({
                params: { id: "txn-clear-category" },
                body: { category: null },
            });
            const res = mockRes();

            await handler(req, res);

            expect(actual.updateTransaction).toHaveBeenCalledWith(
                "txn-clear-category",
                { category: null },
            );
        });

        it("passes partial fields to actual.updateTransaction", async () => {
            const handler = findHandler("patch", "/transactions/:id");
            const req = mockReq({
                params: { id: "txn-5" },
                body: { payee: "Food", notes: "test" },
            });
            const res = mockRes();

            await handler(req, res);

            expect(actual.updateTransaction).toHaveBeenCalledWith("txn-5", {
                payee: "Food",
                notes: "test",
            });
        });

        it.each([
            ["a fractional amount", 12.34],
            ["an exponent string", "1e3"],
            ["null", null],
        ])(
            "returns 400 and does not update for %s",
            async (_label, amount) => {
                const handler = findHandler("patch", "/transactions/:id");
                const req = mockReq({
                    params: { id: "txn-invalid-amount" },
                    body: { amount },
                });
                const res = mockRes();

                await handler(req, res);

                expect(res.status).toHaveBeenCalledWith(400);
                expect(res.json).toHaveBeenCalledWith({
                    error: "Amount must be an integer number of cents",
                });
                expect(actual.updateTransaction).not.toHaveBeenCalled();
            },
        );

        it("forwards a safe integer amount exactly", async () => {
            const handler = findHandler("patch", "/transactions/:id");
            const req = mockReq({
                params: { id: "txn-safe-amount" },
                body: { amount: Number.MAX_SAFE_INTEGER },
            });
            const res = mockRes();

            await handler(req, res);

            expect(actual.updateTransaction).toHaveBeenCalledWith(
                "txn-safe-amount",
                { amount: Number.MAX_SAFE_INTEGER },
            );
            expect(res.json).toHaveBeenCalledWith({
                status: "updated",
                id: "txn-safe-amount",
            });
        });

        it("coerces a plain integer string amount before updating", async () => {
            const handler = findHandler("patch", "/transactions/:id");
            const req = mockReq({
                params: { id: "txn-string-amount" },
                body: { amount: "500" },
            });
            const res = mockRes();

            await handler(req, res);

            expect(actual.updateTransaction).toHaveBeenCalledWith(
                "txn-string-amount",
                { amount: 500 },
            );
            expect(res.json).toHaveBeenCalledWith({
                status: "updated",
                id: "txn-string-amount",
            });
        });

        it("returns { status: 'updated', id } on success", async () => {
            const handler = findHandler("patch", "/transactions/:id");
            const req = mockReq({
                params: { id: "txn-6" },
                body: { payee: "Coffee" },
            });
            const res = mockRes();

            await handler(req, res);

            expect(res.json).toHaveBeenCalledWith({
                status: "updated",
                id: "txn-6",
            });
        });

        it("returns 400 when body has no updatable fields", async () => {
            const handler = findHandler("patch", "/transactions/:id");
            const req = mockReq({
                params: { id: "txn-7" },
                body: {},
            });
            const res = mockRes();

            await handler(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({
                error: "No fields to update",
            });
        });

        it("returns 500 on API error", async () => {
            actual.updateTransaction.mockRejectedValue(
                new Error("Update failed"),
            );
            const handler = findHandler("patch", "/transactions/:id");
            const req = mockReq({
                params: { id: "txn-8" },
                body: { notes: "boom" },
            });
            const res = mockRes();

            await handler(req, res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.json).toHaveBeenCalledWith({
                error: "Update failed",
            });
        });
    });
});

describe("GET /budgets", () => {
    const actual = require("@actual-app/api");

    function findHandler(method, path) {
        const call = mockApp[method].mock.calls.find(([p]) => p === path);
        return call ? call[1] : null;
    }

    function mockReq(overrides = {}) {
        return { query: {}, body: null, params: {}, ...overrides };
    }

    function mockRes() {
        return {
            json: jest.fn().mockReturnThis(),
            status: jest.fn().mockReturnThis(),
        };
    }

    beforeEach(() => {
        actual.init.mockReset();
        actual.getBudgets.mockReset();
        actual.init.mockResolvedValue(undefined);
    });

    test("returns formatted budget list", async () => {
        actual.getBudgets.mockResolvedValue([
            { name: "My Budget", groupId: "g1", cloudFileId: "c1" },
            { name: "MYR Budget", groupId: "g2", cloudFileId: null },
        ]);
        const handler = findHandler("get", "/budgets");
        const res = mockRes();

        await handler(mockReq(), res);

        expect(res.json).toHaveBeenCalledWith([
            { name: "My Budget", groupId: "g1", cloudFileId: "c1" },
            { name: "MYR Budget", groupId: "g2", cloudFileId: null },
        ]);
    });

    test("returns 500 on API error", async () => {
        actual.getBudgets.mockRejectedValue(new Error("Boom"));
        const handler = findHandler("get", "/budgets");
        const res = mockRes();

        await handler(mockReq(), res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: "Boom" });
    });
});

describe("GET /budget-month", () => {
    const actual = require("@actual-app/api");

    function findHandler(method, path) {
        const call = mockApp[method].mock.calls.find(([p]) => p === path);
        return call ? call[1] : null;
    }

    function mockReq(overrides = {}) {
        return { query: {}, body: null, params: {}, ...overrides };
    }

    function mockRes() {
        return {
            json: jest.fn().mockReturnThis(),
            status: jest.fn().mockReturnThis(),
        };
    }

    beforeEach(() => {
        actual.init.mockReset();
        actual.getBudgets.mockReset();
        actual.downloadBudget.mockReset();
        actual.getBudgetMonth.mockReset();

        actual.init.mockResolvedValue(undefined);
        actual.getBudgets.mockResolvedValue([
            { name: "test-budget", groupId: "g1" },
        ]);
        actual.downloadBudget.mockResolvedValue(undefined);
        actual.getBudgetMonth.mockResolvedValue({ month: "2026-08" });
    });

    test("rejects an impossible month before calling Actual", async () => {
        const handler = findHandler("get", "/budget-month");
        const res = mockRes();

        await handler(mockReq({ query: { month: "2026-13" } }), res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            error: "month must be YYYY-MM",
        });
        expect(actual.getBudgetMonth).not.toHaveBeenCalled();
        expect(actual.getBudgets).not.toHaveBeenCalled();
    });

    test("passes a valid month through", async () => {
        const handler = findHandler("get", "/budget-month");
        const res = mockRes();

        await handler(mockReq({ query: { month: "2026-08" } }), res);

        expect(actual.getBudgetMonth).toHaveBeenCalledWith("2026-08");
        expect(res.json).toHaveBeenCalledWith({ month: "2026-08" });
    });
});

describe("GET /transactions/:id", () => {
    const actual = require("@actual-app/api");

    function findHandler(method, path) {
        const call = mockApp[method].mock.calls.find(([p]) => p === path);
        return call ? call[1] : null;
    }

    function mockReq(overrides = {}) {
        return { query: {}, body: null, params: {}, ...overrides };
    }

    function mockRes() {
        return {
            json: jest.fn().mockReturnThis(),
            status: jest.fn().mockReturnThis(),
        };
    }

    beforeEach(() => {
        actual.init.mockReset();
        actual.getBudgets.mockReset();
        actual.downloadBudget.mockReset();
        actual.getTransactions.mockReset();
        actual.init.mockResolvedValue(undefined);
        actual.getBudgets.mockResolvedValue([
            { name: "test-budget", groupId: "g1" },
        ]);
        actual.downloadBudget.mockResolvedValue(undefined);
    });

    test("returns single transaction by ID", async () => {
        actual.getTransactions.mockResolvedValue([
            { id: "other-transaction" },
            {
                id: "txn-42",
                date: "2026-06-17",
                amount: -1280,
                payee: "Toast Box",
            },
        ]);
        const handler = findHandler("get", "/transactions/:id");
        const res = mockRes();

        await handler(mockReq({ params: { id: "txn-42" } }), res);

        expect(actual.getTransactions).toHaveBeenCalledWith(
            undefined,
            "1970-01-01",
            expect.any(String),
        );
        expect(res.json).toHaveBeenCalledWith({
            id: "txn-42",
            date: "2026-06-17",
            amount: -1280,
            payee: "Toast Box",
        });
    });

    test("returns notes in single transaction by ID (notes transport)", async () => {
        actual.getTransactions.mockResolvedValue([
            {
                id: "txn-43",
                notes: "Merchant: WWW.TADA.G* N01A04E712\nStatement: Epsilon Nova | 2026-06-01..2026-06-30\n\nuser note",
            },
        ]);
        const handler = findHandler("get", "/transactions/:id");
        const res = mockRes();

        await handler(mockReq({ params: { id: "txn-43" } }), res);

        expect(res.json).toHaveBeenCalledWith({
            id: "txn-43",
            notes: "Merchant: WWW.TADA.G* N01A04E712\nStatement: Epsilon Nova | 2026-06-01..2026-06-30\n\nuser note",
        });
    });

    test("returns 404 when transaction not found", async () => {
        actual.getTransactions.mockResolvedValue([{ id: "another-transaction" }]);
        const handler = findHandler("get", "/transactions/:id");
        const res = mockRes();

        await handler(mockReq({ params: { id: "missing" } }), res);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({
            error: "Transaction not found",
        });
    });

    test("returns 500 on API error", async () => {
        actual.getTransactions.mockRejectedValue(new Error("DB down"));
        const handler = findHandler("get", "/transactions/:id");
        const res = mockRes();

        await handler(mockReq({ params: { id: "err" } }), res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: "DB down" });
    });
});

describe("POST /transactions enriched response", () => {
    const actual = require("@actual-app/api");

    function findHandler(method, path) {
        const call = mockApp[method].mock.calls.find(([p]) => p === path);
        return call ? call[1] : null;
    }

    function mockReq(overrides = {}) {
        return { query: {}, body: null, params: {}, ...overrides };
    }

    function mockRes() {
        return {
            json: jest.fn().mockReturnThis(),
            status: jest.fn().mockReturnThis(),
        };
    }

    // The handler snapshots rows before the insert and reads them back after,
    // so tests supply both responses in order.
    function readBack(before, after) {
        actual.getTransactions
            .mockResolvedValueOnce(before)
            .mockResolvedValueOnce(after);
    }

    // Date-aware read-back: the snapshot only sees the rows that existed before
    // the insert, and the read-back sees those plus the inserted one. Rows are
    // only visible when the requested window covers their date, so the test
    // proves the caller widened the window instead of the mock ignoring its
    // arguments.
    function readBackDated(before, after) {
        actual.getTransactions.mockImplementation(
            async (account, start, end) => {
                const visible = (rows) =>
                    rows.filter(
                        (row) =>
                            (!account || row.account === account) &&
                            row.date >= start &&
                            row.date <= end,
                    );
                return visible(
                    actual.getTransactions.mock.calls.length === 1
                        ? before
                        : after,
                );
            },
        );
    }

    beforeEach(() => {
        actual.init.mockReset();
        actual.getBudgets.mockReset();
        actual.downloadBudget.mockReset();
        actual.addTransactions.mockReset();
        actual.getTransactions.mockReset();
        actual.init.mockResolvedValue(undefined);
        actual.getBudgets.mockResolvedValue([
            { name: "test-budget", groupId: "g1" },
        ]);
        actual.downloadBudget.mockResolvedValue(undefined);
        // @actual-app/api resolves addTransactions to the string "ok", so the
        // insert handler must read the created transaction back to name it.
        actual.addTransactions.mockResolvedValue("ok");
        actual.getTransactions.mockResolvedValue([]);
    });

    test("inserts with runTransfers so a transfer payee creates its counterpart", async () => {
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    payee: "transfer-payee-id",
                    notes: "Transfer",
                },
            }),
            res,
        );

        expect(actual.addTransactions).toHaveBeenCalledWith(
            "acc-1",
            [
                expect.objectContaining({
                    account: "acc-1",
                    amount: -425,
                    payee: "transfer-payee-id",
                }),
            ],
            { runTransfers: true },
        );
    });

    test("returns full transaction with id, account, date, amount, payee_name, notes, category, cleared", async () => {
        readBack([], [
            {
                id: "new-id-99",
                account: "acc-1",
                date: "2026-06-17",
                amount: -425,
                notes: "Transport",
                category: "cat-transport",
                sort_order: 7,
            },
        ]);
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    payee_name: "BUS/MRT",
                    notes: "Transport",
                    category: "cat-transport",
                },
            }),
            res,
        );

        expect(res.json).toHaveBeenCalledWith({
            id: "new-id-99",
            account: "acc-1",
            date: "2026-06-17",
            amount: -425,
            payee_name: "BUS/MRT",
            notes: "Transport",
            category: "cat-transport",
            cleared: false,
        });
    });

    test("echoes persisted category and notes, not the request body", async () => {
        readBack([], [
            {
                id: "transfer-src",
                account: "acc-1",
                date: "2026-06-17",
                amount: -425,
                payee: "transfer-payee-id",
                notes: "rewritten by rule",
                category: null,
                sort_order: 3,
            },
        ]);
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    payee: "transfer-payee-id",
                    notes: "Transfer",
                    category: "cat-transport",
                },
            }),
            res,
        );

        const body = res.json.mock.calls[0][0];
        expect(body.id).toBe("transfer-src");
        expect(body.category).toBeNull();
        expect(body.notes).toBe("rewritten by rule");
    });

    test("returns a null id when the inserted row cannot be read back", async () => {
        actual.getTransactions.mockResolvedValue([]);
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                },
            }),
            res,
        );

        expect(res.json.mock.calls[0][0].id).toBeNull();
    });

    test("reports a null id when a concurrent insert makes two rows look new", async () => {
        // Both rows are absent from the snapshot: the second is a concurrent
        // POST on the same account inside the window. Nothing distinguishes
        // them, so no id may be claimed.
        readBack(
            [],
            [
                {
                    id: "mine",
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    sort_order: 1,
                },
                {
                    id: "theirs",
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -500,
                    sort_order: 9,
                },
            ],
        );
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                },
            }),
            res,
        );

        expect(res.json.mock.calls[0][0].id).toBeNull();
    });

    test("does not return a pre-existing row as the inserted id", async () => {
        readBack(
            [
                {
                    id: "older",
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    sort_order: 1,
                },
            ],
            [
                {
                    id: "older",
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    sort_order: 1,
                },
            ],
        );
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                },
            }),
            res,
        );

        expect(res.json.mock.calls[0][0].id).toBeNull();
    });

    test("still returns 200 when the read-back query fails", async () => {
        actual.getTransactions
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error("read-back failed"));
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    notes: "Transport",
                },
            }),
            res,
        );

        expect(res.status).not.toHaveBeenCalled();
        expect(res.json.mock.calls[0][0]).toMatchObject({
            id: null,
            notes: "Transport",
        });
    });

    test("category is null when not provided", async () => {
        readBack(
            [
                {
                    id: "id-100",
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -100,
                    sort_order: 1,
                },
            ],
            [
                {
                    id: "id-100",
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -100,
                    sort_order: 1,
                },
            ],
        );
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -100,
                },
            }),
            res,
        );

        expect(res.json.mock.calls[0][0].category).toBeNull();
    });

    test("reads back over the request date and its neighbours", async () => {
        readBack([], []);
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                },
            }),
            res,
        );

        // A rule can move the inserted row by a day, so the snapshot and the
        // read-back must cover the same widened window.
        expect(actual.getTransactions).toHaveBeenNthCalledWith(
            1,
            "acc-1",
            "2026-06-16",
            "2026-06-18",
        );
        expect(actual.getTransactions).toHaveBeenNthCalledWith(
            2,
            "acc-1",
            "2026-06-16",
            "2026-06-18",
        );
        // The diff only means anything while both calls ask for the same rows,
        // so pin the two windows against each other. The literals above cannot
        // catch an asymmetry by themselves, because both spell the dates out.
        const calls = actual.getTransactions.mock.calls;
        expect(calls[0][0]).toBe(calls[1][0]);
        expect(calls[0][1]).toBe(calls[1][1]);
        expect(calls[0][2]).toBe(calls[1][2]);
    });

    test("reports the persisted amount as a number when the row carries a string", async () => {
        readBack(
            [],
            [
                {
                    id: "only-new",
                    account: "acc-1",
                    date: "2026-06-17",
                    // Deliberately different from the request amount below, so
                    // the assertion can only pass if the persisted string was
                    // parsed rather than the request echoed.
                    amount: "-999",
                    sort_order: 1,
                },
            ],
        );
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                },
            }),
            res,
        );

        const body = res.json.mock.calls[0][0];
        expect(body.id).toBe("only-new");
        expect(body.amount).toBe(-999);
        expect(typeof body.amount).toBe("number");
    });

    test("falls back to the request amount when the persisted amount is not numeric", async () => {
        readBack(
            [],
            [
                {
                    id: "only-new",
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: "n/a",
                    sort_order: 1,
                },
            ],
        );
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                },
            }),
            res,
        );

        const body = res.json.mock.calls[0][0];
        expect(body.id).toBe("only-new");
        // Reporting 0 would claim the row holds no cents.
        expect(body.amount).toBe(-425);
    });

    test("echoes a persisted zero instead of falling back to the request", async () => {
        readBack(
            [],
            [
                {
                    id: "only-new",
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: 0,
                    sort_order: 1,
                },
            ],
        );
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                },
            }),
            res,
        );

        // Regression guard: a future falsiness-based fallback must still echo
        // zero, a legitimate persisted amount.
        expect(res.json.mock.calls[0][0].amount).toBe(0);
    });

    test.each([
        ["a non-numeric string", "n/a"],
        ["null", null],
        ["an empty string", ""],
        ["a blank string", "   "],
        ["a hex string", "0x10"],
        ["an exponent string", "1e3"],
        ["a boolean", true],
        ["an array", [5]],
        // The response is the amount a caller may report as booked, so a value
        // that is not a safe integer of cents must not be echoed as exact.
        ["a fractional number", 12.34],
        [
            "a number outside the safe-integer range",
            Number.MAX_SAFE_INTEGER + 1,
        ],
        ["a digit string outside the safe-integer range", "9007199254740993"],
    ])(
        "falls back to the request amount when the persisted amount is %s",
        async (_label, amount) => {
            readBack(
                [],
                [
                    {
                        id: "only-new",
                        account: "acc-1",
                        date: "2026-06-17",
                        amount,
                        sort_order: 1,
                    },
                ],
            );
            const handler = findHandler("post", "/transactions");
            const res = mockRes();

            await handler(
                mockReq({
                    body: {
                        account: "acc-1",
                        date: "2026-06-17",
                        amount: -425,
                    },
                }),
                res,
            );

            const body = res.json.mock.calls[0][0];
            expect(body.id).toBe("only-new");
            // Reporting 0 would claim a row holds no cents when the amount is
            // simply absent.
            expect(body.amount).toBe(-425);
        },
    );

    test("echoes the coerced request amount as a number when nothing is attributed", async () => {
        readBack([], []);
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: "-425",
                },
            }),
            res,
        );

        expect(res.json.mock.calls[0][0].amount).toBe(-425);
        expect(typeof res.json.mock.calls[0][0].amount).toBe("number");
    });

    test("prefers the persisted cleared flag when a rule clears the row", async () => {
        readBack(
            [],
            [
                {
                    id: "cleared-by-rule",
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    cleared: true,
                    sort_order: 1,
                },
            ],
        );
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                },
            }),
            res,
        );

        expect(res.json.mock.calls[0][0].cleared).toBe(true);
    });

    test("finds the inserted row when a rule moves it to an adjacent date", async () => {
        // The row only ever exists on the neighbour date, so a read-back scoped
        // to the request date alone yields a null id.
        readBackDated(
            [],
            [
                {
                    id: "moved-by-rule",
                    account: "acc-1",
                    date: "2026-06-18",
                    amount: -425,
                    sort_order: 2,
                },
            ],
        );
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                },
            }),
            res,
        );

        expect(res.json.mock.calls[0][0].id).toBe("moved-by-rule");
    });

    test("does not claim a pre-existing neighbour row on the widened window", async () => {
        // The row is visible to both reads, but only when the requested window
        // covers it. A narrower read-back would see a row that the narrower
        // snapshot saw too, and a snapshot narrower than the read-back would
        // make this pre-existing row look new.
        actual.getTransactions.mockImplementation(
            async (account, start, end) => {
                const row = {
                    id: "yesterday",
                    account: "acc-1",
                    date: "2026-06-16",
                    amount: -425,
                    sort_order: 1,
                };
                return row.date >= start && row.date <= end ? [row] : [];
            },
        );
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                },
            }),
            res,
        );

        expect(res.json.mock.calls[0][0].id).toBeNull();
    });

    test("never guesses the id when the pre-insert snapshot fails", async () => {
        actual.getTransactions
            .mockRejectedValueOnce(new Error("snapshot failed"))
            .mockResolvedValueOnce([
                {
                    id: "someone-elses-row",
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    sort_order: 4,
                },
            ]);
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    notes: "Transport",
                },
            }),
            res,
        );

        // Without a reliable snapshot a row on the window cannot be proven new,
        // so the response reports no id instead of naming a stranger's row.
        expect(res.status).not.toHaveBeenCalled();
        expect(res.json.mock.calls[0][0]).toMatchObject({
            id: null,
            notes: "Transport",
            amount: -425,
        });
    });

    test("prefers persisted amount and date when a rule rewrites them", async () => {
        readBack(
            [],
            [
                {
                    id: "rewritten",
                    account: "acc-1",
                    date: "2026-06-18",
                    amount: -999,
                    notes: "Transport",
                    sort_order: 5,
                },
            ],
        );
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    payee_name: "BUS/MRT",
                    notes: "Transport",
                },
            }),
            res,
        );

        const body = res.json.mock.calls[0][0];
        expect(body.id).toBe("rewritten");
        expect(body.amount).toBe(-999);
        expect(body.date).toBe("2026-06-18");
        // payee_name has no persisted counterpart: @actual-app/api stores the
        // payee id only, so the request value stays.
        expect(body.payee_name).toBe("BUS/MRT");
    });

    test("returns 400 when the account is missing", async () => {
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({ body: { date: "2026-06-17", amount: -425 } }),
            res,
        );

        expect(res.status).toHaveBeenCalledWith(400);
        expect(actual.addTransactions).not.toHaveBeenCalled();
    });

    test.each([
        ["omitted", undefined],
        ["empty", ""],
        ["blank", "   "],
        ["text", "abc"],
        ["fractional", -425.5],
        ["null", null],
        ["object", {}],
        ["true", true],
        ["false", false],
        ["an empty array", []],
        ["a single-item array", [5]],
        ["a hex string", "0x10"],
        ["an exponent string", "1e3"],
        ["a bare plus string", "+5"],
        ["an unsafe integer string", "9007199254740993"],
        ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ])(
        "returns 400 for the %s amount without inserting",
        async (_label, amount) => {
            const handler = findHandler("post", "/transactions");
            const res = mockRes();

            await handler(
                mockReq({
                    body: { account: "acc-1", date: "2026-06-17", amount },
                }),
                res,
            );

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({
                error: "Amount must be an integer number of cents",
            });
            expect(actual.addTransactions).not.toHaveBeenCalled();
            expect(actual.getTransactions).not.toHaveBeenCalled();
        },
    );

    test.each([
        ["a number", -425],
        ["a numeric string", "-425"],
        ["zero", 0],
        ["a zero string", "0"],
        ["the largest safe integer", Number.MAX_SAFE_INTEGER],
        ["the smallest safe integer string", String(Number.MIN_SAFE_INTEGER)],
    ])(
        "still inserts %s amount",
        async (_label, amount) => {
            readBack([], []);
            const handler = findHandler("post", "/transactions");
            const res = mockRes();

            await handler(
                mockReq({
                    body: { account: "acc-1", date: "2026-06-17", amount },
                }),
                res,
            );

            expect(actual.addTransactions).toHaveBeenCalled();
            // The insert payload must carry the coerced number, not the raw
            // string the caller sent.
            const payload = actual.addTransactions.mock.calls[0][1][0];
            expect(payload.amount).toBe(Number(amount));
            expect(typeof payload.amount).toBe("number");
            expect(res.status).not.toHaveBeenCalled();
        },
    );

    test.each([
        "2026-6-7",
        "2026-13-01",
        "2026-06-32",
        "not-a-date",
    ])(
        "returns 400 for the invalid date %s without inserting",
        async (date) => {
            const handler = findHandler("post", "/transactions");
            const res = mockRes();

            await handler(
                mockReq({
                    body: { account: "acc-1", date, amount: -425 },
                }),
                res,
            );

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({
                error: "Invalid date (use YYYY-MM-DD)",
            });
            expect(actual.addTransactions).not.toHaveBeenCalled();
            expect(actual.getTransactions).not.toHaveBeenCalled();
        },
    );

    test.each(["0000-01-01", "9999-12-31", "0999-12-31"])(
        "returns 400 with a range message for the out-of-range date %s",
        async (date) => {
            const handler = findHandler("post", "/transactions");
            const res = mockRes();

            await handler(
                mockReq({
                    body: { account: "acc-1", date, amount: -425 },
                }),
                res,
            );

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({
                error: "Date out of supported range",
            });
            expect(actual.addTransactions).not.toHaveBeenCalled();
            expect(actual.getTransactions).not.toHaveBeenCalled();
        },
    );

    test.each(["2026-01-01", "2026-12-31", "2026-06-17", "2026-02-28", "1000-01-01"])(
        "still inserts a valid date %s",
        async (date) => {
            readBack([], []);
            const handler = findHandler("post", "/transactions");
            const res = mockRes();

            await handler(
                mockReq({
                    body: { account: "acc-1", date, amount: -425 },
                }),
                res,
            );

            expect(actual.addTransactions).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        },
    );

    test("echoes the request fields and reports no id when two rows look new", async () => {
        // The other row is the newer one, so a response that trusted the pick
        // would name that row as the insert and report its amount and date.
        readBack(
            [],
            [
                {
                    id: "inserted",
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    notes: "Transport",
                    category: "cat-transport",
                    sort_order: 100,
                },
                {
                    id: "other",
                    account: "acc-1",
                    date: "2026-06-16",
                    amount: -10,
                    notes: "other note",
                    category: null,
                    sort_order: 200,
                },
            ],
        );
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    notes: "Transport",
                    category: "cat-transport",
                },
            }),
            res,
        );

        const body = res.json.mock.calls[0][0];
        // Two new rows cannot be attributed, so neither the id nor the fields
        // may be taken from either row.
        expect(body.id).toBeNull();
        expect(body.amount).toBe(-425);
        expect(body.date).toBe("2026-06-17");
        expect(body.notes).toBe("Transport");
        expect(body.category).toBe("cat-transport");
    });

    test("names its own row when two inserts race for the same account and date", async () => {
        // The account's rows, shared by both requests, so the second insert is
        // visible to the first request's read-back unless the handler
        // serializes snapshot, insert, and read-back.
        const rows = [];
        let inserted = 0;
        actual.getTransactions.mockImplementation(
            async (account, start, end) =>
                rows.filter(
                    (row) =>
                        (!account || row.account === account) &&
                        row.date >= start &&
                        row.date <= end,
                ),
        );
        actual.addTransactions.mockImplementation(async (account) => {
            inserted += 1;
            rows.push({
                id: `new-${inserted}`,
                account,
                date: "2026-06-17",
                amount: -425,
                notes: `insert ${inserted}`,
                category: null,
            });
            return "ok";
        });
        const handler = findHandler("post", "/transactions");
        const first = mockRes();
        const second = mockRes();

        await Promise.all([
            handler(
                mockReq({
                    body: {
                        account: "acc-1",
                        date: "2026-06-17",
                        amount: -425,
                        notes: "first",
                    },
                }),
                first,
            ),
            handler(
                mockReq({
                    body: {
                        account: "acc-1",
                        date: "2026-06-17",
                        amount: -425,
                        notes: "second",
                    },
                }),
                second,
            ),
        ]);

        // Each response must name its own insert, not the row the other
        // request added while this one was between snapshot and read-back.
        expect(first.json.mock.calls[0][0].id).toBe("new-1");
        expect(first.json.mock.calls[0][0].notes).toBe("insert 1");
        expect(second.json.mock.calls[0][0].id).toBe("new-2");
        expect(second.json.mock.calls[0][0].notes).toBe("insert 2");
    });

    test("releases the insert lock when the insert fails", async () => {
        actual.addTransactions.mockRejectedValueOnce(new Error("insert failed"));
        const handler = findHandler("post", "/transactions");
        const failed = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    notes: "first",
                },
            }),
            failed,
        );

        expect(failed.status).toHaveBeenCalledWith(500);
        // The lock surrounds the insert, so a throw must release it. A leaked
        // lock would leave this second request queued forever.
        const retried = mockRes();
        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    notes: "second",
                },
            }),
            retried,
        );

        expect(retried.status).not.toHaveBeenCalled();
        expect(actual.addTransactions).toHaveBeenCalledTimes(2);
    });

    test("prefers the persisted fields when the new row is unique", async () => {
        readBack(
            [],
            [
                {
                    id: "only-new",
                    account: "acc-1",
                    date: "2026-06-18",
                    amount: -999,
                    notes: "rewritten",
                    category: null,
                    sort_order: 200,
                },
            ],
        );
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    notes: "Transport",
                    category: "cat-transport",
                },
            }),
            res,
        );

        const body = res.json.mock.calls[0][0];
        expect(body.id).toBe("only-new");
        expect(body.amount).toBe(-999);
        expect(body.date).toBe("2026-06-18");
        expect(body.notes).toBe("rewritten");
        expect(body.category).toBeNull();
    });

    test("falls back to the request notes when the unique row has none", async () => {
        readBack(
            [],
            [
                {
                    id: "only-new",
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    notes: null,
                    sort_order: 200,
                },
            ],
        );
        const handler = findHandler("post", "/transactions");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    account: "acc-1",
                    date: "2026-06-17",
                    amount: -425,
                    notes: "Transport",
                },
            }),
            res,
        );

        const body = res.json.mock.calls[0][0];
        expect(body.id).toBe("only-new");
        expect(body.notes).toBe("Transport");
    });
});

describe("readWindow", () => {
    test("spans the day before and the day after", () => {
        expect(readWindow("2026-06-17")).toEqual({
            start: "2026-06-16",
            end: "2026-06-18",
        });
    });

    test("crosses a month and a year boundary", () => {
        expect(readWindow("2026-01-01")).toEqual({
            start: "2025-12-31",
            end: "2026-01-02",
        });
        expect(readWindow("2026-03-01")).toEqual({
            start: "2026-02-28",
            end: "2026-03-02",
        });
    });
});

describe("GET /accounts/balance/:id", () => {
    const actual = require("@actual-app/api");

    function findHandler(method, path) {
        const call = mockApp[method].mock.calls.find(([p]) => p === path);
        return call ? call[1] : null;
    }

    function mockReq(overrides = {}) {
        return { query: {}, body: null, params: {}, ...overrides };
    }

    function mockRes() {
        return {
            json: jest.fn().mockReturnThis(),
            status: jest.fn().mockReturnThis(),
        };
    }

    beforeEach(() => {
        actual.init.mockReset();
        actual.getAccountBalance.mockReset();
        actual.init.mockResolvedValue(undefined);
        // withBudget() resolves the requested budget through getBudgets() and
        // switches through downloadBudget(), so stub both here instead of
        // relying on whichever block ran earlier in the file.
        actual.getBudgets.mockReset();
        actual.downloadBudget.mockReset();
        actual.getBudgets.mockResolvedValue([
            { name: "test-budget", groupId: "g1" },
        ]);
        actual.downloadBudget.mockResolvedValue(undefined);
    });

    test("returns account balance by id", async () => {
        actual.getAccountBalance.mockResolvedValue(50000);
        const handler = findHandler("get", "/accounts/balance/:id");
        const res = mockRes();

        await handler(mockReq({ params: { id: "acc-1" } }), res);

        expect(actual.getAccountBalance).toHaveBeenCalledWith(
            "acc-1",
            undefined,
        );
        expect(res.json).toHaveBeenCalledWith({ id: "acc-1", balance: 50000 });
    });

    test("passes cutoff date to getAccountBalance when provided", async () => {
        actual.getAccountBalance.mockResolvedValue(42000);
        const handler = findHandler("get", "/accounts/balance/:id");
        const res = mockRes();

        await handler(
            mockReq({
                params: { id: "acc-2" },
                query: { cutoff: "2026-06-01" },
            }),
            res,
        );

        expect(actual.getAccountBalance).toHaveBeenCalledWith(
            "acc-2",
            expect.any(Date),
        );
        const cutoffArg = actual.getAccountBalance.mock.calls[0][1];
        expect(cutoffArg.toISOString()).toBe(
            "2026-06-01T00:00:00.000Z",
        );
        expect(res.json).toHaveBeenCalledWith({ id: "acc-2", balance: 42000 });
    });

    test("returns 400 when account id is empty", async () => {
        const handler = findHandler("get", "/accounts/balance/:id");
        const res = mockRes();

        await handler(mockReq({ params: { id: "" } }), res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            error: "Account id is required",
        });
    });

    test("returns 400 when cutoff date is invalid", async () => {
        const handler = findHandler("get", "/accounts/balance/:id");
        const res = mockRes();

        await handler(
            mockReq({
                params: { id: "acc-1" },
                query: { cutoff: "not-a-date" },
            }),
            res,
        );

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            error: "Invalid cutoff date (use YYYY-MM-DD)",
        });
    });

    test("returns 500 on API error", async () => {
        actual.getAccountBalance.mockRejectedValue(new Error("Not found"));
        const handler = findHandler("get", "/accounts/balance/:id");
        const res = mockRes();

        await handler(mockReq({ params: { id: "acc-99" } }), res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: "Not found" });
    });
});
