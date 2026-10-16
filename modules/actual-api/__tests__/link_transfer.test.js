/**
 * Regression coverage for issue #598, Actual-side half: linking two EXISTING
 * rows into one transfer pair.
 *
 * The spike that fixed this contract (scratch budget, vendored @actual-app/api
 * 26.9.0) proved:
 *   - `updateTransaction(id, { transfer_id })` ALONE does not link: onUpdate
 *     sees no transferred account and calls removeTransfer, nulling it back.
 *   - `addTransactions(..., { runTransfers: true })` on a row carrying another
 *     account's transfer payee creates a SECOND counterpart row, which is wrong
 *     when both legs already exist (the #598 case: two Misc rows, one per leg).
 *   - Writing each leg's payee AND transfer_id together links the pair in place
 *     with no counterpart row, so both `transfer_id`s point at each other.
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
    getAccountBalance: jest.fn(),
    getBudgetMonth: jest.fn(),
    getSchedules: jest.fn(),
}));

const actual = require("@actual-app/api");
require("../server");

const OUTGOING = {
    id: "cb446e1b-d5ea-4e55-9d03-ad6e8d681f57",
    account: "ocbc-360",
    date: "2026-09-23",
    amount: -100000,
    transfer_id: null,
    payee: "p-misc",
};
const INCOMING = {
    id: "fc63bac4-6f08-46a6-989a-f28997bbde51",
    account: "posb-cashback",
    date: "2026-09-23",
    amount: 100000,
    transfer_id: null,
    payee: "p-misc",
};

describe("POST /transactions/link-transfer (#598)", () => {
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
        for (const key of Object.keys(actual)) {
            if (actual[key] && actual[key].mockReset) actual[key].mockReset();
        }
        actual.init.mockResolvedValue(undefined);
        actual.getBudgets.mockResolvedValue([
            { name: "test-budget", groupId: "g1" },
        ]);
        actual.downloadBudget.mockResolvedValue(undefined);
        actual.updateTransaction.mockResolvedValue({});
    });

    /** The pair, plus the two transfer payees Actual creates per account. */
    function seedPair({ accounts = null, payees = null, rows = null } = {}) {
        actual.getAccounts.mockResolvedValue(
            accounts || [
                { id: "ocbc-360", name: "OCBC 360", closed: false },
                { id: "posb-cashback", name: "POSB Cashback", closed: false },
            ],
        );
        actual.getPayees.mockResolvedValue(
            payees || [
                { id: "p-misc", name: "Misc", transfer_acct: null },
                { id: "p-ocbc", name: "OCBC 360", transfer_acct: "ocbc-360" },
                {
                    id: "p-posb",
                    name: "POSB Cashback",
                    transfer_acct: "posb-cashback",
                },
            ],
        );
        actual.getTransactions.mockResolvedValue(rows || [OUTGOING, INCOMING]);
    }

    /**
     * Seed the pair with a range-honouring read, the way the vendored library
     * filters: `date >= startDate && date <= endDate`.
     *
     * The plain `seedPair` mock resolves every call with both rows regardless of
     * the requested window, so it cannot see a route that asks for the wrong one
     * (issue #598 round-1 High).
     */
    function seedRangeAwarePair() {
        seedPair();
        actual.getTransactions.mockImplementation((_accountId, startDate, endDate) =>
            Promise.resolve(
                [OUTGOING, INCOMING].filter(
                    (row) => row.date >= startDate && row.date <= endDate,
                ),
            ),
        );
    }

    test("links a pair dated on the Singapore date while the clock is before 08:00 SGT (#598 round-1 High)", async () => {
        // The incident's own clock: the alerts arrived 2026-09-22T16:36Z, which is
        // 2026-09-23 00:36 SGT, and both legs are dated 2026-09-23 (the SGT date).
        // A read whose window ends at the UTC today excludes the pair, so the route
        // answers 404 and the legs stay unlinked for a third of the clock.
        jest.useFakeTimers().setSystemTime(new Date("2026-09-22T16:36:43.000Z"));
        try {
            seedRangeAwarePair();
            const handler = findHandler("post", "/transactions/link-transfer");
            const res = mockRes();

            await handler(
                mockReq({
                    body: {
                        budget_id: "test-budget",
                        outgoing_id: OUTGOING.id,
                        incoming_id: INCOMING.id,
                    },
                }),
                res,
            );

            expect(actual.updateTransaction).toHaveBeenCalledTimes(2);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: "linked",
                    outgoing_id: OUTGOING.id,
                    incoming_id: INCOMING.id,
                }),
            );
        } finally {
            jest.useRealTimers();
        }
    });

    test("compensates BOTH legs when the second link write fails", async () => {
        // Fixture rows carry `category`, the field the engine actually returns:
        // a row read back from `getTransactions` has `category`, never
        // `category_id` (which is the DB column, verified against the vendored
        // engine). A fixture using `category_id` cannot see the route reading
        // the wrong one.
        seedPair({
            rows: [
                {
                    ...OUTGOING,
                    category: "cat-groceries",
                    notes: "Statement: OUTGOING-REF",
                },
                {
                    ...INCOMING,
                    category: "cat-income",
                    notes: "Statement: INCOMING-REF",
                },
            ],
        });
        actual.updateTransaction
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error("temporary Actual failure"))
            .mockResolvedValue({});
        const handler = findHandler("post", "/transactions/link-transfer");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    budget_id: "test-budget",
                    outgoing_id: OUTGOING.id,
                    incoming_id: INCOMING.id,
                },
            }),
            res,
        );

        // write 1, the failed write 2, then a restore for EACH leg: the engine's
        // onUpdate already moved the counterpart's payee when write 1 landed, so
        // restoring the first leg alone would leave a half-pair a retry cannot
        // relink (proven on the real engine).
        expect(actual.updateTransaction).toHaveBeenCalledTimes(4);
        expect(actual.updateTransaction).toHaveBeenNthCalledWith(3, OUTGOING.id, {
            payee: "p-misc",
            transfer_id: null,
            category: "cat-groceries",
        });
        expect(actual.updateTransaction).toHaveBeenNthCalledWith(4, INCOMING.id, {
            payee: "p-misc",
            transfer_id: null,
            category: "cat-income",
            notes: "Statement: INCOMING-REF",
            schedule: null,
        });
        expect(res.status).toHaveBeenCalledWith(500);
    });

    test("refuses a leg that points at a transfer account while unlinked (#598 round-1 Medium)", async () => {
        // The pre-state the engine's own addTransfer link-back can leave behind,
        // and the state a failed compensation can leave: payee = the other
        // account's TRANSFER payee, transfer_id = null. Writing that payee back
        // (or linking it) makes the engine's onUpdate insert a THIRD counterpart
        // row - proven on the real vendored engine, 2 rows -> 3, with the leg
        // linked to the invented row. Fail closed instead.
        seedPair({
            rows: [
                { ...OUTGOING, payee: "p-posb", transfer_id: null },
                INCOMING,
            ],
        });
        const handler = findHandler("post", "/transactions/link-transfer");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    budget_id: "test-budget",
                    outgoing_id: OUTGOING.id,
                    incoming_id: INCOMING.id,
                },
            }),
            res,
        );

        // No write at all: the guard runs before the first leg is written.
        expect(actual.updateTransaction).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.stringContaining("transfer account"),
            }),
        );
    });

    test("reports compensation failure when the second leg's restore cannot be written", async () => {
        // The other failure order: write 1, failed write 2, the outgoing restore
        // succeeds, and the incoming restore fails. The incoming leg is then
        // left carrying the outgoing account's transfer payee with a null
        // transfer_id, which is exactly the shape the guard refuses on a later
        // attempt, so pin the order and the surfaced error.
        seedPair();
        actual.updateTransaction
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error("second write failed"))
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error("second restore failed"));
        const handler = findHandler("post", "/transactions/link-transfer");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    budget_id: "test-budget",
                    outgoing_id: OUTGOING.id,
                    incoming_id: INCOMING.id,
                },
            }),
            res,
        );

        expect(actual.updateTransaction).toHaveBeenCalledTimes(4);
        expect(actual.updateTransaction).toHaveBeenNthCalledWith(3, OUTGOING.id, {
            payee: "p-misc",
            transfer_id: null,
            category: null,
        });
        expect(actual.updateTransaction).toHaveBeenNthCalledWith(4, INCOMING.id, {
            payee: "p-misc",
            transfer_id: null,
            category: null,
            notes: null,
            schedule: null,
        });
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.stringContaining("compensation failed"),
            }),
        );
    });

    test("reports compensation failure when a compensation write cannot be written", async () => {
        seedPair();
        actual.updateTransaction
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error("second write failed"))
            .mockRejectedValueOnce(new Error("rollback failed"));
        const handler = findHandler("post", "/transactions/link-transfer");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    budget_id: "test-budget",
                    outgoing_id: OUTGOING.id,
                    incoming_id: INCOMING.id,
                },
            }),
            res,
        );

        expect(actual.updateTransaction).toHaveBeenCalledTimes(3);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.stringContaining("compensation failed"),
            }),
        );
    });

    test("links both legs in place, with each transfer_id pointing at the other", async () => {
        seedPair();
        const handler = findHandler("post", "/transactions/link-transfer");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    budget_id: "test-budget",
                    outgoing_id: OUTGOING.id,
                    incoming_id: INCOMING.id,
                },
            }),
            res,
        );

        expect(actual.updateTransaction).toHaveBeenCalledTimes(2);
        const updates = actual.updateTransaction.mock.calls.map(([, fields]) => fields);
        // Each leg carries its own transfer payee (the OTHER account) and the
        // partner's id, in one call each.
        expect(updates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    payee: "p-posb",
                    transfer_id: INCOMING.id,
                }),
                expect.objectContaining({
                    payee: "p-ocbc",
                    transfer_id: OUTGOING.id,
                }),
            ]),
        );
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                status: "linked",
                outgoing_id: OUTGOING.id,
                incoming_id: INCOMING.id,
            }),
        );
    });

    test("clears any category on both legs so no residual expense is left", async () => {
        seedPair();
        const handler = findHandler("post", "/transactions/link-transfer");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    budget_id: "test-budget",
                    outgoing_id: OUTGOING.id,
                    incoming_id: INCOMING.id,
                },
            }),
            res,
        );

        for (const [, fields] of actual.updateTransaction.mock.calls) {
            expect(fields).toHaveProperty("category", null);
        }
    });

    test("refuses a pair that is not opposite-sign on distinct accounts", async () => {
        seedPair({
            rows: [OUTGOING, { ...INCOMING, amount: -100000 }],
        });
        const handler = findHandler("post", "/transactions/link-transfer");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    budget_id: "test-budget",
                    outgoing_id: OUTGOING.id,
                    incoming_id: INCOMING.id,
                },
            }),
            res,
        );

        expect(actual.updateTransaction).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
    });

    test("refuses a pair on the same account", async () => {
        seedPair({
            rows: [OUTGOING, { ...INCOMING, account: "ocbc-360" }],
        });
        const handler = findHandler("post", "/transactions/link-transfer");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    budget_id: "test-budget",
                    outgoing_id: OUTGOING.id,
                    incoming_id: INCOMING.id,
                },
            }),
            res,
        );

        expect(actual.updateTransaction).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
    });

    test("refuses a row that is already part of a transfer", async () => {
        seedPair({
            rows: [OUTGOING, { ...INCOMING, transfer_id: "someone-else" }],
        });
        const handler = findHandler("post", "/transactions/link-transfer");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    budget_id: "test-budget",
                    outgoing_id: OUTGOING.id,
                    incoming_id: INCOMING.id,
                },
            }),
            res,
        );

        expect(actual.updateTransaction).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
    });

    test("refuses a missing leg id", async () => {
        seedPair();
        const handler = findHandler("post", "/transactions/link-transfer");
        const res = mockRes();

        await handler(
            mockReq({ body: { budget_id: "test-budget", outgoing_id: OUTGOING.id } }),
            res,
        );

        expect(actual.updateTransaction).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
    });

    test("refuses an unknown budget before touching any row", async () => {
        seedPair();
        const handler = findHandler("post", "/transactions/link-transfer");
        const res = mockRes();

        await handler(
            mockReq({
                body: {
                    budget_id: "no-such-budget",
                    outgoing_id: OUTGOING.id,
                    incoming_id: INCOMING.id,
                },
            }),
            res,
        );

        expect(actual.updateTransaction).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
    });
});
