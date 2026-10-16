/**
 * Tests for ToolRegistry handlers — budget_id enforcement, validation, new features.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────
vi.mock("better-sqlite3", () => {
    const mockDb = {
        prepare: vi.fn(() => mockStmt),
        exec: vi.fn(),
        // Real better-sqlite3 exposes pragma(); src/dedup.js calls it to select
        // synchronous=OFF in test mode, so the double must provide it too.
        pragma: vi.fn(),
        close: vi.fn(),
    };
    const mockStmt = {
        get: vi.fn(() => null),
        all: vi.fn(() => []),
        run: vi.fn(() => ({ lastInsertRowid: 1 })),
    };
    return { default: vi.fn(() => mockDb) };
});

vi.mock("fs", () => ({ mkdirSync: vi.fn() }));

const { loggerInfoMock, loggerWarnMock, loggerErrorMock } = vi.hoisted(() => ({
    loggerInfoMock: vi.fn(),
    loggerWarnMock: vi.fn(),
    loggerErrorMock: vi.fn(),
}));

vi.mock("../src/logging.js", () => ({
    logger: {
        info: loggerInfoMock,
        warn: loggerWarnMock,
        error: loggerErrorMock,
        child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    },
    getLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    })),
    setLogLevel: vi.fn(),
    redactSensitive: (value) => value,
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { ToolRegistry } = await import("../src/tools.js");

function mockConfig() {
    return {
        deepseekApiKey: "sk-test",
        llmProvider: "deepseek",
        llmApiKey: "sk-test",
        llmBaseUrl: "https://api.deepseek.com/v1",
        llmModel: "deepseek-flash",
        llmReasoningEffort: "low",
        actualBudgetUrl: "http://actual-api:3000",
        actualBudgetPassword: "pw",
        primaryBudgetFile: "My Budget",
        secondaryBudgetFile: "My MYR Budget",
        primaryCurrency: "SGD",
        secondaryCurrency: "MYR",
        imapHost: "imap.test.com",
        imapPort: 993,
        imapUsername: "u",
        imapPassword: "p",
        notifyUrl: "http://webhook",
        notifySecret: "s",
        userName: "Test",
        dedupDbPath: ":memory:",
        statementDbPath: ":memory:",
        memoryPath: "data/MEMORY.md",
        braveSearchApiKey: "",
        logLevel: "INFO",
    };
}

describe("ToolRegistry — budget_id validation", () => {
    let registry;

    beforeEach(() => {
        mockFetch.mockReset();
        loggerInfoMock.mockReset();
        loggerWarnMock.mockReset();
        loggerErrorMock.mockReset();
        registry = new ToolRegistry(mockConfig(), null);
    });

    describe("fetch_accounts", () => {
        test("returns error when budget_id is missing", async () => {
            const result = await registry.executeTool("fetch_accounts", {});
            expect(result).toEqual({ error: "budget_id is required" });
        });

        test("returns error when budget_id is empty string", async () => {
            const result = await registry.executeTool("fetch_accounts", {
                budget_id: "",
            });
            expect(result).toEqual({ error: "budget_id is required" });
        });
    });

    describe("fetch_categories", () => {
        test("returns error when budget_id is missing", async () => {
            const result = await registry.executeTool("fetch_categories", {});
            expect(result).toEqual({ error: "budget_id is required" });
        });
    });

    describe("fetch_payees", () => {
        test("returns error when budget_id is missing", async () => {
            const result = await registry.executeTool("fetch_payees", {});
            expect(result).toEqual({ error: "budget_id is required" });
        });
    });

    describe("fetch_budget_month", () => {
        test("returns error when budget_id is missing", async () => {
            const result = await registry.executeTool("fetch_budget_month", {});
            expect(result).toEqual({ error: "budget_id is required" });
        });

        test("forwards the requested month to actual-api", async () => {
            const payload = {
                month: "2026-08",
                categoryGroups: [
                    {
                        name: "Everyday",
                        categories: [
                            {
                                name: "Food",
                                budgeted: 50000,
                                spent: 1234,
                                balance: 48766,
                            },
                        ],
                    },
                ],
            };
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => payload,
            });

            const result = await registry.executeTool("fetch_budget_month", {
                budget_id: "My MYR Budget",
                month: "2026-08",
            });

            expect(result).toEqual(payload);
            const url = mockFetch.mock.calls[0][0];
            expect(url).toContain("/budget-month");
            expect(url).toContain("budget_id=My+MYR+Budget");
            expect(url).toContain("month=2026-08");
        });

        test("omits month so actual-api defaults to the current month", async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: async () => ({ month: "2026-09" }),
            });

            await registry.executeTool("fetch_budget_month", {
                budget_id: "My MYR Budget",
            });

            const url = mockFetch.mock.calls[0][0];
            expect(url).toContain("/budget-month?budget_id=My+MYR+Budget");
            expect(url).not.toContain("month=");
        });

        test("declares the YYYY-MM month pattern for non-MCP callers", () => {
            const tool = registry
                .getToolSchemas()
                .find((t) => t.function.name === "fetch_budget_month");
            expect(tool.function.parameters.properties.month.pattern).toBe(
                "^\\d{4}-(0[1-9]|1[0-2])$",
            );
        });

        test.each(["2026-8", "2026-13-01", "August 2026", "", "2026-13", "2026-00"])(
            "rejects the malformed month %j before calling actual-api",
            async (month) => {
                const result = await registry.executeTool(
                    "fetch_budget_month",
                    { budget_id: "My MYR Budget", month },
                );

                expect(result).toEqual({ error: "month must be YYYY-MM" });
                expect(mockFetch).not.toHaveBeenCalled();
            },
        );
    });

    describe("fetch_recent_transactions", () => {
        test("returns error when budget_id is missing", async () => {
            const result = await registry.executeTool(
                "fetch_recent_transactions",
                {},
            );
            expect(result).toEqual({ error: "budget_id is required" });
        });
    });

    describe("insert_transaction", () => {
        test("returns error when budget_id is missing", async () => {
            const result = await registry.executeTool("insert_transaction", {
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: -425,
            });
            expect(result).toEqual({ error: "budget_id is required" });
        });

        test("returns error when account_id is missing", async () => {
            const result = await registry.executeTool("insert_transaction", {
                budget_id: "My Budget",
                date: "2026-06-17",
                amount_cents: -425,
            });
            expect(result).toEqual({ error: "account_id is required" });
        });

        test("returns error when date is missing", async () => {
            const result = await registry.executeTool("insert_transaction", {
                budget_id: "My Budget",
                account_id: "acc-1",
                amount_cents: -425,
            });
            expect(result).toEqual({ error: "date is required" });
        });

        test("returns error when amount_cents is missing", async () => {
            const result = await registry.executeTool("insert_transaction", {
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "2026-06-17",
            });
            expect(result).toEqual({ error: "amount_cents is required" });
        });

        test("amount_cents of 0 is accepted (valid value)", async () => {
            // 0 is falsy but valid — the check uses `!args.amount_cents && args.amount_cents !== 0`
            // Mock fetch so the API call doesn't throw
            mockFetch.mockResolvedValue({
                ok: true,
                json: () => ({ id: "txn-1", amount: 0 }),
            });
            const result = await registry.executeTool("insert_transaction", {
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: 0,
            });
            // Should NOT return "amount_cents is required"
            expect(result.error).not.toBe("amount_cents is required");
        });

        // Duplicate payee names must not resolve by list order. Insert follows
        // the same policy update_transaction already enforced (#487): a bare
        // name is refused when the transfer-payee preference would come from
        // array order, and payee_id selects one explicitly. Issue #483.
        const duplicateNamePayees = [
            { id: "payee-plain", name: "Deposit" },
            {
                id: "payee-transfer",
                name: "Deposit",
                transfer_acct: "acct-deposit",
            },
        ];

        test("a bare imported_description matching a transfer and a plain payee picks the transfer (#483)", async () => {
            mockFetch
                .mockResolvedValueOnce({ ok: true, json: () => duplicateNamePayees })
                .mockResolvedValueOnce({ ok: true, json: () => [
                    { id: "acct-deposit", name: "Deposit Account", closed: false },
                ] })
                .mockResolvedValueOnce({ ok: true, json: () => ({ id: "txn-1" }) });

            await registry.executeTool("insert_transaction", {
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: -1500,
                imported_description: "Deposit",
            });

            // #563: the matched transfer payee's target must be checked to be
            // open and not the booking account, so the write boundary reads
            // /accounts between the payee lookup and the POST. The old count of
            // 2 asserted that no such check happened.
            expect(mockFetch).toHaveBeenCalledTimes(3);
            expect(mockFetch.mock.calls[1][0]).toContain("/accounts");
            const postBody = JSON.parse(mockFetch.mock.calls[2][1].body);
            // The transfer payee is the only match that creates a transfer, so
            // it wins over the plain payee listed first.
            expect(postBody.payee).toBe("payee-transfer");
            expect(postBody.payee_name).toBe("Deposit");
        });

        test("a bare imported_description naming several plain payees is refused (#483)", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => [
                    { id: "payee-a", name: "Deposit" },
                    { id: "payee-b", name: "Deposit" },
                ],
            });

            const result = await registry.executeTool("insert_transaction", {
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: -1500,
                imported_description: "Deposit",
            });

            expect(result).toEqual({
                error: 'Payee "Deposit" is ambiguous; pass payee_id (candidates: payee-a, payee-b).',
                // The tag survives the tool boundary so the caller can tell a
                // refusal from an upstream failure. Issue #551.
                code: "AMBIGUOUS_PAYEE",
            });
            // No POST was attempted.
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        test("an explicit payee_id picks the plain payee of a shared name (#483)", async () => {
            const recordSpy = vi.spyOn(registry._dedup, "record");
            mockFetch
                .mockResolvedValueOnce({ ok: true, json: () => duplicateNamePayees })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => ({ id: "txn-3" }),
                });

            await registry.executeTool("insert_transaction", {
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: -1500,
                imported_description: "Deposit",
                payee_id: "payee-plain",
            });

            const postBody = JSON.parse(mockFetch.mock.calls[1][1].body);
            expect(postBody.payee).toBe("payee-plain");
            // The ID must be the only payee field: a name resolved from the same
            // imported_description could point at a different payee.
            expect(postBody.payee_name).toBeUndefined();
            // The dedup journal keys on payee name, so the explicit ID path must
            // still record the name that ID stands for.
            expect(recordSpy).toHaveBeenCalledWith(
                "2026-06-17",
                -1500,
                "acc-1",
                "Deposit",
            );
        });

        test("an unknown explicit payee_id is rejected (#483)", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => duplicateNamePayees,
            });

            const result = await registry.executeTool("insert_transaction", {
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: -1500,
                imported_description: "Deposit",
                payee_id: "payee-missing",
            });

            expect(result).toEqual({
                error: 'Payee ID "payee-missing" not found in payee list.',
            });
            // No POST was attempted.
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        test("an explicit payee_id records a non-empty journal name (#483)", async () => {
            const recordSpy = vi.spyOn(registry._dedup, "record");
            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => [{ id: "payee-noname", name: "" }],
                })
                .mockResolvedValueOnce({ ok: true, json: () => ({ id: "txn-4" }) });

            await registry.executeTool("insert_transaction", {
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: -1500,
                imported_description: "Deposit",
                payee_id: "payee-noname",
            });

            // The journal hash includes the payee name, so fall back to the
            // imported description when the payee has none.
            expect(recordSpy).toHaveBeenCalledWith(
                "2026-06-17",
                -1500,
                "acc-1",
                "Deposit",
            );
        });

        test("a rejected fractional amount leaves the dedup journal empty (#517)", async () => {
            const recordSpy = vi.spyOn(registry._dedup, "record");
            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => [{ id: "payee-1", name: "Deposit" }],
                })
                .mockResolvedValueOnce({
                    ok: false,
                    status: 400,
                    json: () => ({
                        error: "Amount must be an integer number of cents",
                    }),
                });

            await expect(
                registry.executeTool("insert_transaction", {
                    budget_id: "My Budget",
                    account_id: "acc-1",
                    date: "2026-06-17",
                    amount_cents: 12.34,
                    imported_description: "Deposit",
                }),
            ).rejects.toThrow("actual-api 400");

            // The fraction itself must reach the API: a rounding or coercion
            // change would still reject here, so pin the posted value.
            expect(mockFetch).toHaveBeenCalledTimes(2);
            const postBody = JSON.parse(mockFetch.mock.calls[1][1].body);
            expect(postBody.amount).toBe(12.34);
            // A rejected insert must not be recorded as processed.
            expect(recordSpy).not.toHaveBeenCalled();
        });

        test("an absent amount_cents is refused before any request (#508)", async () => {
            const recordSpy = vi.spyOn(registry._dedup, "record");

            for (const missing of [undefined, null, NaN, ""]) {
                mockFetch.mockClear();
                recordSpy.mockClear();

                const result = await registry.executeTool("insert_transaction", {
                    budget_id: "My Budget",
                    account_id: "acc-1",
                    date: "2026-06-17",
                    amount_cents: missing,
                    imported_description: "Deposit",
                });

                // The route rejects a missing amount, so the tool must not turn
                // it into a 0-cent booking on the way there.
                expect(result).toEqual({ error: "amount_cents is required" });
                expect(mockFetch).not.toHaveBeenCalled();
                expect(recordSpy).not.toHaveBeenCalled();
            }
        });

        test("a quoted amount is posted and journalled as a number (#508)", async () => {
            const recordSpy = vi.spyOn(registry._dedup, "record");
            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => [{ id: "payee-1", name: "Deposit" }],
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => ({ id: "txn-quoted" }),
                });

            await registry.executeTool("insert_transaction", {
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: " -1280 ",
                imported_description: "Deposit",
            });

            // The route trims and coerces this shape, so the body and the
            // journal must carry the same number or a re-delivery hashes
            // differently and the duplicate is missed.
            const postBody = JSON.parse(mockFetch.mock.calls[1][1].body);
            expect(postBody.amount).toBe(-1280);
            expect(recordSpy).toHaveBeenCalledWith(
                "2026-06-17",
                -1280,
                "acc-1",
                "Deposit",
            );
        });

        test("a zero amount is still posted (#508)", async () => {
            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => [{ id: "payee-1", name: "Deposit" }],
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => ({ id: "txn-zero" }),
                });

            await registry.executeTool("insert_transaction", {
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: 0,
                imported_description: "Deposit",
            });

            expect(mockFetch).toHaveBeenCalledTimes(2);
            const postBody = JSON.parse(mockFetch.mock.calls[1][1].body);
            expect(postBody.amount).toBe(0);
        });

        test("an unverifiable explicit payee_id fails closed (#483)", async () => {
            mockFetch.mockRejectedValueOnce(new Error("AB unreachable"));

            const result = await registry.executeTool("insert_transaction", {
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: -1500,
                imported_description: "Deposit",
                payee_id: "payee-plain",
            });

            expect(result).toEqual({
                error: 'Could not validate payee_id "payee-plain": payee list unavailable.',
            });
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        test("_validate_payee refuses an ambiguous duplicate name (#483)", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => [
                    { id: "payee-a", name: "Deposit" },
                    { id: "payee-b", name: "Deposit" },
                ],
            });

            await expect(
                registry._validate_payee("DEPOSIT", "My Budget"),
            ).rejects.toThrow(
                'Payee "DEPOSIT" is ambiguous; pass payee_id (candidates: payee-a, payee-b).',
            );
        });

        test("_validate_payee prefers a unique transfer payee (#483)", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => duplicateNamePayees,
            });

            // #563: _validate_payee also hands back the matched payee object, so
            // insert_transaction can validate that exact payee's transfer target
            // without re-resolving the name against a second payee list.
            await expect(
                registry._validate_payee("deposit", "My Budget"),
            ).resolves.toEqual({
                name: "Deposit",
                payeeId: "payee-transfer",
                payee: {
                    id: "payee-transfer",
                    name: "Deposit",
                    transfer_acct: "acct-deposit",
                },
            });
        });
    });

    describe("update_transaction", () => {
        test("returns error when budget_id is missing", async () => {
            const result = await registry.executeTool("update_transaction", {
                id: "txn-1",
            });
            expect(result).toEqual({ error: "budget_id is required" });
        });

        test("treats a blank payee_name as absent when another field is present (#511)", async () => {
            // This HTTP route stays tolerant: the MCP schema rejects a blank
            // name, but a caller that sends "" here still updates the other
            // fields instead of failing.
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => ({ status: "updated", id: "txn-1" }),
            });

            const result = await registry.executeTool("update_transaction", {
                id: "txn-1",
                budget_id: "My Budget",
                payee_name: "",
                notes: "corrected",
            });

            expect(result).toEqual({ status: "updated", id: "txn-1" });
            const patchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(patchBody).toEqual({
                budget_id: "My Budget",
                notes: "corrected",
            });
        });

        test("payee_name resolves to payee ID in PATCH body", async () => {
            // Mock GET /payees — returns a payee with id and name
            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => [
                        { id: "payee-uuid-123", name: "Shopping" },
                        { id: "payee-uuid-456", name: "Groceries" },
                    ],
                })
                // Mock PATCH /transactions/:id
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => ({ status: "updated", id: "txn-1" }),
                });

            await registry.executeTool("update_transaction", {
                id: "txn-1",
                budget_id: "My Budget",
                payee_name: "Shopping",
            });

            // The PATCH call is the second fetch call
            const patchCall = mockFetch.mock.calls[1];
            const patchBody = JSON.parse(patchCall[1].body);
            // Must send payee ID, not payee name
            expect(patchBody.payee).toBe("payee-uuid-123");
        });

        test("prefers the transfer payee when a plain payee shares its name (#421)", async () => {
            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => [
                        { id: "payee-plain", name: "Deposit" },
                        {
                            id: "payee-transfer",
                            name: "Deposit",
                            transfer_acct: "acct-deposit",
                        },
                    ],
                })
                // #570: a transfer payee on the update path also reads the row's
                // own account and the live accounts list before the PATCH.
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => ({ id: "txn-1", account: "acct-source" }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => [
                        { id: "acct-deposit", name: "Deposit", closed: false },
                    ],
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => ({ status: "updated", id: "txn-1" }),
                });

            await registry.executeTool("update_transaction", {
                id: "txn-1",
                budget_id: "My Budget",
                payee_name: "Deposit",
            });

            const patchBody = JSON.parse(mockFetch.mock.calls[3][1].body);
            // The transfer payee is the only one that creates a transfer, so it
            // is what a bare name implies; the plain one needs an explicit ID.
            expect(patchBody.payee).toBe("payee-transfer");
        });

        test("an explicit payee_id selects the plain payee of the same name (#421)", async () => {
            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => [
                        { id: "payee-plain", name: "Deposit" },
                        {
                            id: "payee-transfer",
                            name: "Deposit",
                            transfer_acct: "acct-deposit",
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => ({ status: "updated", id: "txn-1" }),
                });

            await registry.executeTool("update_transaction", {
                id: "txn-1",
                budget_id: "My Budget",
                payee_id: "payee-plain",
            });

            const patchBody = JSON.parse(mockFetch.mock.calls[1][1].body);
            expect(patchBody.payee).toBe("payee-plain");
        });

        test("rejects a payee_id that is not in the live list (#421)", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => [{ id: "payee-plain", name: "Deposit" }],
            });

            const result = await registry.executeTool("update_transaction", {
                id: "txn-1",
                budget_id: "My Budget",
                payee_id: "missing-payee",
            });

            expect(result).toEqual({
                error: 'Payee ID "missing-payee" not found in payee list.',
            });
        });

        test("a bare name matching a transfer payee creates the transfer (#421)", async () => {
            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => [
                        { id: "payee-misc", name: "Misc" },
                        {
                            id: "payee-misc-transfer",
                            name: "Misc",
                            transfer_acct: "acct-misc",
                        },
                    ],
                })
                // #570: the transfer-guard reads on the update path.
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => ({ id: "txn-1", account: "acct-source" }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => [
                        { id: "acct-misc", name: "Misc", closed: false },
                    ],
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => ({ status: "updated", id: "txn-1" }),
                });

            await registry.executeTool("update_transaction", {
                id: "txn-1",
                budget_id: "My Budget",
                payee_name: "Misc",
            });

            const patchBody = JSON.parse(mockFetch.mock.calls[3][1].body);
            expect(patchBody.payee).toBe("payee-misc-transfer");
        });

        test("payee_id resolves the payee for the category-clear guard (#421)", async () => {
            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => [{ id: "payee-misc", name: "Misc" }],
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => ({ status: "updated", id: "txn-1" }),
                });

            await registry.executeTool("update_transaction", {
                id: "txn-1",
                budget_id: "My Budget",
                payee_id: "payee-misc",
                category_id: null,
            });

            const patchBody = JSON.parse(mockFetch.mock.calls[1][1].body);
            expect(patchBody.payee).toBe("payee-misc");
            expect(patchBody.category).toBeNull();
        });

        test("the category-clear guard resolves the transaction payee by ID, not name order (#483)", async () => {
            mockFetch
                // payee-a's name equals the transaction's payee ID. Matching by
                // name alone would pick it and clear the category.
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => [
                        { id: "payee-a", name: "payee-b" },
                        { id: "payee-b", name: "Misc" },
                    ],
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => ({ payee: "payee-b" }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => ({ status: "updated", id: "txn-1" }),
                });

            const result = await registry.executeTool("update_transaction", {
                id: "txn-1",
                budget_id: "My Budget",
                category_id: null,
            });

            // The transaction holds payee-b, which is Misc, so the clear goes
            // through. A name-first match would have chosen payee-a and refused.
            expect(result).toEqual({ status: "updated", id: "txn-1" });
            const patchCalls = mockFetch.mock.calls.filter(
                (c) => c[1] && c[1].method === "PATCH",
            );
            expect(patchCalls).toHaveLength(1);
            expect(JSON.parse(patchCalls[0][1].body).category).toBeNull();
        });

        test("rejects supplying both payee_id and payee_name (#421)", async () => {
            const result = await registry.executeTool("update_transaction", {
                id: "txn-1",
                budget_id: "My Budget",
                payee_id: "payee-plain",
                payee_name: "Deposit",
            });

            // Silently preferring the ID would hide a caller mistake. The guard
            // runs before the payee fetch, so a misuse costs no round trip.
            // Issue #487.
            expect(result).toEqual({
                error: "Provide payee_id or payee_name, not both.",
            });
            expect(mockFetch).not.toHaveBeenCalled();
        });

        test("refuses a bare name that matches several plain payees, naming candidates (#487)", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => [
                    { id: "payee-a", name: "Deposit" },
                    { id: "payee-b", name: "Deposit" },
                ],
            });

            const result = await registry.executeTool("update_transaction", {
                id: "txn-1",
                budget_id: "My Budget",
                payee_name: "Deposit",
            });

            // No transfer payee to prefer, so picking by array order would
            // silently update the wrong one.
            expect(result).toEqual({
                error: 'Payee "Deposit" is ambiguous; pass payee_id (candidates: payee-a, payee-b).',
            });
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        test("refuses a name matching two different transfer payees (#487)", async () => {
            // Two payees for one account name cannot exist in Actual, so this
            // pins the multiple-transfer branch rather than a realistic
            // collision; the two-plain-payee test covers the reachable case.
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => [
                    { id: "payee-t1", name: "Deposit", transfer_acct: "acct-1" },
                    { id: "payee-t2", name: "Deposit", transfer_acct: "acct-2" },
                ],
            });

            const result = await registry.executeTool("update_transaction", {
                id: "txn-1",
                budget_id: "My Budget",
                payee_name: "Deposit",
            });

            expect(result).toEqual({
                error: 'Payee "Deposit" is ambiguous; pass payee_id (candidates: payee-t1, payee-t2).',
            });
        });

        test("a null payee_name does not throw (#487)", async () => {
            const result = await registry.executeTool("update_transaction", {
                id: "txn-1",
                budget_id: "My Budget",
                payee_name: null,
            });

            // Treated as absent: no payee field is set and no network call runs.
            expect(result).toEqual({
                error: "At least one field must be provided to update",
            });
            expect(mockFetch).not.toHaveBeenCalled();
        });
    });

    describe("check_duplicate", () => {
        test("accepts budget_id as required param (no error for missing — handler has old default)", async () => {
            // check_duplicate handler has budget_id destructured (no || "")
            // It will pass undefined to _check_ab_duplicate which has default ""
            const result = await registry.executeTool("check_duplicate", {
                date: "2026-06-17",
                amount_cents: -425,
                account_id: "acc-1",
                payee_name: "Test",
                budget_id: "My Budget",
            });
            // dedup check will fail silently (fetch not mocked), returns false
            expect(result).toBe(false);
        });

        test("matches a quoted amount against a numeric Actual row (#508)", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => [
                    {
                        id: "txn-1",
                        amount: -1280,
                        date: "2026-06-17",
                        account: "acc-1",
                    },
                ],
            });

            const result = await registry.executeTool("check_duplicate", {
                date: "2026-06-17",
                amount_cents: "-1280",
                account_id: "acc-1",
                payee_name: "Toast Box",
                budget_id: "My Budget",
            });

            // The extractor tolerates a quoted integer; strict equality against
            // the numeric row would miss the duplicate and book it again.
            expect(result).toBe(true);
        });

        test.each([
            ["0x10", 16, false],
            ["1e3", 1000, false],
            ["+1280", 1280, false],
            ["99999999999999999999", 1e20, false],
            [" 16 ", 16, true],
        ])(
            "coerces only a strict integer string: %s against a %i row (#508)",
            async (amount, rowAmount, expected) => {
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    json: () => [
                        {
                            id: "txn-1",
                            amount: rowAmount,
                            date: "2026-06-17",
                            account: "acc-1",
                        },
                    ],
                });

                const result = await registry.executeTool("check_duplicate", {
                    date: "2026-06-17",
                    amount_cents: amount,
                    account_id: "acc-1",
                    payee_name: "Toast Box",
                    budget_id: "My Budget",
                });

                // Only the shape the Actual route accepts may be reinterpreted;
                // hex and scientific strings must not become a false duplicate.
                expect(result).toBe(expected);
            },
        );
    });

    describe("resolve_merchant", () => {
        test("returns error when budget_id is missing", async () => {
            const result = await registry.executeTool("resolve_merchant", {
                merchant: "Toast Box",
            });
            expect(result).toEqual({ error: "budget_id is required" });
        });
    });
});

describe("executeTool logging", () => {
    let registry;

    beforeEach(() => {
        mockFetch.mockReset();
        loggerInfoMock.mockReset();
        loggerWarnMock.mockReset();
        loggerErrorMock.mockReset();
        registry = new ToolRegistry(mockConfig(), null);
    });

    test("logs tool_exec event on successful execution", async () => {
        await registry.executeTool("log_decision", {
            action: "test",
            reasoning: "unit test",
        });
        expect(loggerInfoMock).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "tool_exec",
                tool: "log_decision",
            }),
        );
    });

    test("includes result in tool_exec log", async () => {
        await registry.executeTool("log_decision", {
            action: "test",
            reasoning: "verify result logged",
        });
        expect(loggerInfoMock).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "tool_exec",
                result: "true",
            }),
        );
    });

    test("truncates long args and result", async () => {
        // log_decision returns true (short), but args can be long
        const longReasoning = "x".repeat(500);
        await registry.executeTool("log_decision", {
            action: "test",
            reasoning: longReasoning,
        });
        const call = loggerInfoMock.mock.calls.find(
            (c) => c[0]?.event === "tool_exec",
        );
        expect(call).toBeDefined();
        // args stringified + sliced to 200 chars
        expect(call[0].args.length).toBeLessThanOrEqual(200);
    });

    test("still throws on unknown tool (no log emitted)", async () => {
        await expect(registry.executeTool("nonexistent", {})).rejects.toThrow(
            "Unknown tool",
        );
        // No tool_exec log because handler lookup threw before result
        expect(loggerInfoMock).not.toHaveBeenCalled();
    });
});

describe("_handle_notify_user logging", () => {
    let registry;

    beforeEach(() => {
        mockFetch.mockReset();
        loggerInfoMock.mockReset();
        loggerWarnMock.mockReset();
        loggerErrorMock.mockReset();
        registry = new ToolRegistry(mockConfig(), null);
    });

    test("logs notify_user_sent on webhook success", async () => {
        mockFetch.mockResolvedValue({ ok: true });
        await registry.executeTool("notify_user", {
            message: "Test notification",
        });
        expect(loggerInfoMock).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "notify_user_sent",
                message: "Test notification",
            }),
        );
    });

    test("logs notify_user_failed on non-200 response", async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 500 });
        const result = await registry.executeTool("notify_user", {
            message: "Should fail",
        });
        expect(result).toBe(false);
        expect(loggerErrorMock).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "notify_user_failed",
                status: 500,
            }),
        );
    });

    test("logs notify_user_failed on network error", async () => {
        mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
        const result = await registry.executeTool("notify_user", {
            message: "Should error",
        });
        expect(result).toBe(false);
        expect(loggerErrorMock).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "notify_user_failed",
                error: "ECONNREFUSED",
            }),
        );
    });

    test("logs notify_user_cooldown when suppressed", async () => {
        // Record a send for msg-1, then try again — should suppress
        const cfg = mockConfig();
        registry = new ToolRegistry(cfg, null);
        registry.setEmailContext("msg-1", "raw", null);

        // First call: succeeds
        mockFetch.mockResolvedValue({ ok: true });
        await registry.executeTool("notify_user", {
            message: "First notification",
        });

        // Second call: should be suppressed by cooldown (no fetch call)
        mockFetch.mockReset();
        loggerInfoMock.mockReset();
        const result = await registry.executeTool("notify_user", {
            message: "Second notification",
        });
        expect(result).toBe(true);
        expect(loggerInfoMock).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "notify_user_cooldown",
            }),
        );
        // Fetch should NOT have been called
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test("does not double-log tool_exec for notify_user (handler logs its own)", async () => {
        // The handler logs notify_user_sent; executeTool also logs tool_exec.
        // Both are intentional — tool_exec gives a unified timeline, notify_user_*
        // gives domain-specific detail.
        mockFetch.mockResolvedValue({ ok: true });
        await registry.executeTool("notify_user", {
            message: "Test",
        });

        // Should have both tool_exec and notify_user_sent
        const events = loggerInfoMock.mock.calls.map((c) => c[0]?.event);
        expect(events).toContain("tool_exec");
        expect(events).toContain("notify_user_sent");
    });
});

// ── Webhook feedback loop regression tests ──────────────────────────

describe("notify_user cooldown prevents double-notification for same email", () => {
    test("second notify_user is suppressed after successful first call", async () => {
        // Simulates the scenario where an email is processed successfully
        // (insert → notify_user fires), then the hermes agent re-processes
        // the notification text and calls notify_user again.
        // The cooldown should suppress the second call.
        const registry = new ToolRegistry(mockConfig(), null);
        registry.setEmailContext("msg-ryt-transfer", "raw-email-content", null);

        // First notify_user: succeeds (insert confirmed)
        mockFetch.mockResolvedValue({ ok: true });
        const first = await registry.executeTool("notify_user", {
            message:
                "RM10.00 sent to Example Payee via Alpha Bank on 2026-06-22, logged!",
        });
        expect(first).toBe(true);
        expect(loggerInfoMock).toHaveBeenCalledWith(
            expect.objectContaining({ event: "notify_user_sent" }),
        );

        // Reset fetch mock for second call
        mockFetch.mockReset();
        loggerInfoMock.mockReset();

        // Second notify_user: should be suppressed by cooldown
        const second = await registry.executeTool("notify_user", {
            message: "Transaction recorded: MYR 10 at Example Payee",
        });
        expect(second).toBe(true);
        expect(loggerInfoMock).toHaveBeenCalledWith(
            expect.objectContaining({ event: "notify_user_cooldown" }),
        );
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test("notify_user fires independently for different email contexts", async () => {
        // Different email → no cooldown suppression
        const registry = new ToolRegistry(mockConfig(), null);

        mockFetch.mockResolvedValue({ ok: true });

        // Email 1
        registry.setEmailContext("msg-1", "raw1", null);
        await registry.executeTool("notify_user", { message: "Txn A logged!" });

        // Email 2 (different context)
        registry.setEmailContext("msg-2", "raw2", null);
        mockFetch.mockClear();
        loggerInfoMock.mockReset();
        const result = await registry.executeTool("notify_user", {
            message: "Txn B logged!",
        });

        expect(result).toBe(true);
        expect(loggerInfoMock).toHaveBeenCalledWith(
            expect.objectContaining({ event: "notify_user_sent" }),
        );
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

describe("duplicate transactions do not notify user", () => {
    beforeEach(() => {
        mockFetch.mockReset();
        loggerInfoMock.mockReset();
        loggerWarnMock.mockReset();
        loggerErrorMock.mockReset();
    });

    test("check_duplicate returning true does not trigger notify_user", async () => {
        const registry = new ToolRegistry(mockConfig(), null);
        registry._dedup.checkDuplicate = vi.fn(() => true);

        const result = await registry.executeTool("check_duplicate", {
            date: "2026-06-22",
            amount_cents: -1000,
            account_id: "acc-1",
            payee_name: "Misc",
            budget_id: "My Budget",
        });
        expect(result).toBe(true);

        // notify_user should NOT have been called as a side effect
        const notifyCalls = loggerInfoMock.mock.calls.filter(
            (c) =>
                c[0]?.event === "notify_user_sent" ||
                c[0]?.event === "notify_user_cooldown",
        );
        expect(notifyCalls).toHaveLength(0);
    });

    test("notify_user not called during duplicate flow (orchestrator simulation)", async () => {
        const registry = new ToolRegistry(mockConfig(), null);
        registry.setEmailContext("msg-dup", "raw", null);
        registry._dedup.checkDuplicate = vi.fn(() => true);

        // Simulate check_duplicate returning true
        const isDup = await registry.executeTool("check_duplicate", {
            date: "2026-06-22",
            amount_cents: -1000,
            account_id: "acc-1",
            payee_name: "Misc",
            budget_id: "My Budget",
        });
        expect(isDup).toBe(true);

        // In real orchestrator: if (isDuplicate) { log_decision; return; }
        // No notify_user call happens.
        await registry.executeTool("log_decision", {
            action: "duplicate",
            reasoning: "Already recorded",
            timestamp: new Date().toISOString(),
        });

        // Verify notify_user was NOT invoked
        const notifyCalls = loggerInfoMock.mock.calls.filter(
            (c) => c[0]?.event === "notify_user_sent",
        );
        expect(notifyCalls).toHaveLength(0);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
