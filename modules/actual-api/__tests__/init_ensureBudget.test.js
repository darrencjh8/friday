jest.mock("fs", () => ({ mkdirSync: jest.fn() }));

// `ACTUAL_PRIMARY_BUDGET_FILE` is read when the server module loads, and these
// tests change it per case. Restore the shared value so a later file in the
// same jest worker still sees the configured name.
const previousPrimaryBudgetFile = process.env.ACTUAL_PRIMARY_BUDGET_FILE;

afterAll(() => {
    if (previousPrimaryBudgetFile === undefined)
        delete process.env.ACTUAL_PRIMARY_BUDGET_FILE;
    else process.env.ACTUAL_PRIMARY_BUDGET_FILE = previousPrimaryBudgetFile;
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
    deleteTransaction: jest.fn(),
    updateTransaction: jest.fn(),
}));

function actual() {
    return require("@actual-app/api");
}

function makeBudget(overrides = {}) {
    return {
        name: overrides.name || "TestBudget",
        groupId: "g-1",
        ...overrides,
    };
}

describe("init", () => {
    beforeEach(() => {
        process.env.ACTUAL_PRIMARY_BUDGET_FILE = "TestBudget";
        jest.resetModules();
        const api = actual();
        api.init.mockReset();
        api.getBudgets.mockReset();
        api.downloadBudget.mockReset();
    });

    test("first call initializes Actual and downloads the target budget", async () => {
        const api = actual();
        api.init.mockResolvedValue(undefined);
        api.getBudgets.mockResolvedValue([makeBudget({ name: "MyBudget" })]);
        api.downloadBudget.mockResolvedValue(undefined);
        process.env.ACTUAL_PRIMARY_BUDGET_FILE = "MyBudget";

        const { init } = require("../server");
        await init();

        expect(api.init).toHaveBeenCalledTimes(1);
        expect(api.downloadBudget).toHaveBeenCalledTimes(1);
        expect(api.downloadBudget).toHaveBeenCalledWith("g-1", {
            password: undefined,
        });
    });

    test("subsequent call returns immediately without re-init", async () => {
        const api = actual();
        api.init.mockResolvedValue(undefined);
        api.getBudgets.mockResolvedValue([makeBudget()]);
        api.downloadBudget.mockResolvedValue(undefined);

        const { init } = require("../server");
        await init();
        api.init.mockClear();
        api.downloadBudget.mockClear();

        await init();

        expect(api.init).not.toHaveBeenCalled();
        expect(api.downloadBudget).not.toHaveBeenCalled();
    });

    test("concurrent calls return same promise — no double init", async () => {
        const api = actual();
        let resolveInit;
        api.init.mockReturnValue(
            new Promise((r) => {
                resolveInit = r;
            }),
        );
        api.getBudgets.mockResolvedValue([makeBudget()]);
        api.downloadBudget.mockResolvedValue(undefined);

        const { init } = require("../server");
        const p1 = init();
        const p2 = init();

        expect(api.init).toHaveBeenCalledTimes(1);

        resolveInit();
        await Promise.all([p1, p2]);

        expect(api.downloadBudget).toHaveBeenCalledTimes(1);
    });

    test("finds budget by BUDGET_FILE name", async () => {
        const api = actual();
        process.env.ACTUAL_PRIMARY_BUDGET_FILE = "Test SGD";
        api.init.mockResolvedValue(undefined);
        api.getBudgets.mockResolvedValue([
            makeBudget({ name: "Test MYR", groupId: "myr-1" }),
            makeBudget({ name: "Test SGD", groupId: "sgd-1" }),
        ]);
        api.downloadBudget.mockResolvedValue(undefined);

        const { init } = require("../server");
        await init();

        expect(api.downloadBudget).toHaveBeenCalledWith("sgd-1", {
            password: undefined,
        });
    });

    test("rejects a configured primary budget that does not exist", async () => {
        const api = actual();
        process.env.ACTUAL_PRIMARY_BUDGET_FILE = "NonExistent";
        api.init.mockResolvedValue(undefined);
        api.getBudgets.mockResolvedValue([
            makeBudget({ name: "First Budget", groupId: "first-1" }),
        ]);

        const { init } = require("../server");
        await expect(init()).rejects.toThrow('Budget "NonExistent" not found');
        expect(api.downloadBudget).not.toHaveBeenCalled();
    });

    test("a failed init resets so a later call retries and succeeds", async () => {
        const api = actual();
        process.env.ACTUAL_PRIMARY_BUDGET_FILE = "NonExistent";
        api.init.mockResolvedValue(undefined);
        api.getBudgets.mockResolvedValue([
            makeBudget({ name: "First Budget", groupId: "first-1" }),
        ]);
        api.downloadBudget.mockResolvedValue(undefined);

        const { init } = require("../server");
        await expect(init()).rejects.toThrow('Budget "NonExistent" not found');

        // The configured budget appears after the failed attempt; the reset in
        // the rejection handler must let the next call initialise again instead
        // of returning the cached rejected promise.
        api.getBudgets.mockResolvedValue([
            makeBudget({ name: "NonExistent", groupId: "retry-1" }),
        ]);
        await init();

        expect(api.downloadBudget).toHaveBeenCalledWith("retry-1", {
            password: undefined,
        });
    });

    test("throws when budgets array is empty", async () => {
        const api = actual();
        api.init.mockResolvedValue(undefined);
        api.getBudgets.mockResolvedValue([]);

        const { init } = require("../server");
        await expect(init()).rejects.toThrow("not found");
    });

    test("uses cloudFileId when groupId is absent", async () => {
        const api = actual();
        api.init.mockResolvedValue(undefined);
        api.getBudgets.mockResolvedValue([
            makeBudget({ groupId: null, cloudFileId: "cloud-xyz" }),
        ]);
        api.downloadBudget.mockResolvedValue(undefined);

        const { init } = require("../server");
        await init();

        expect(api.downloadBudget).toHaveBeenCalledWith(
            "cloud-xyz",
            expect.any(Object),
        );
    });

    test("propagates error from actual.init", async () => {
        const api = actual();
        api.init.mockRejectedValue(new Error("Network unreachable"));

        const { init } = require("../server");
        await expect(init()).rejects.toThrow("Network unreachable");
    });
});

describe("ensureBudget", () => {
    beforeEach(() => {
        jest.resetModules();
        const api = actual();
        api.init.mockReset();
        api.getBudgets.mockReset();
        api.downloadBudget.mockReset();
    });

    function loadServer() {
        return require("../server");
    }

    async function primeInit(budgetName = "SGD") {
        process.env.ACTUAL_PRIMARY_BUDGET_FILE = budgetName;
        const api = actual();
        api.init.mockResolvedValue(undefined);
        api.getBudgets
            .mockResolvedValueOnce([
                makeBudget({ name: budgetName, groupId: "sgd-sync" }),
            ])
            .mockResolvedValue([
                makeBudget({ name: budgetName, groupId: "sgd-sync" }),
            ]);
        api.downloadBudget.mockResolvedValue(undefined);
        const { init } = loadServer();
        await init();
        api.init.mockClear();
        api.getBudgets.mockClear();
        api.downloadBudget.mockClear();
    }

    test("returns early when budgetIdOrName is empty string", async () => {
        await primeInit();
        const api = actual();
        const { ensureBudget } = loadServer();
        await ensureBudget("");
        expect(api.getBudgets).not.toHaveBeenCalled();
    });

    test("returns early when budgetIdOrName is null", async () => {
        await primeInit();
        const api = actual();
        const { ensureBudget } = loadServer();
        await ensureBudget(null);
        expect(api.getBudgets).not.toHaveBeenCalled();
    });

    test("returns early when budgetIdOrName is undefined", async () => {
        await primeInit();
        const api = actual();
        const { ensureBudget } = loadServer();
        await ensureBudget(undefined);
        expect(api.getBudgets).not.toHaveBeenCalled();
    });

    test("matches budget by groupId", async () => {
        await primeInit();
        const api = actual();
        api.getBudgets.mockResolvedValue([
            makeBudget({ name: "A", groupId: "id-a" }),
            makeBudget({ name: "B", groupId: "id-b" }),
        ]);
        const { ensureBudget } = loadServer();
        await ensureBudget("id-b");
        expect(api.downloadBudget).toHaveBeenCalledWith(
            "id-b",
            expect.any(Object),
        );
    });

    test("matches budget by cloudFileId", async () => {
        await primeInit();
        const api = actual();
        api.getBudgets.mockResolvedValue([
            makeBudget({ name: "A", groupId: null, cloudFileId: "cf-a" }),
            makeBudget({ name: "B", groupId: null, cloudFileId: "cf-b" }),
        ]);
        const { ensureBudget } = loadServer();
        await ensureBudget("cf-b");
        expect(api.downloadBudget).toHaveBeenCalledWith(
            "cf-b",
            expect.any(Object),
        );
    });

    test("matches budget by name", async () => {
        await primeInit();
        const api = actual();
        api.getBudgets.mockResolvedValue([
            makeBudget({ name: "Alpha", groupId: "a-1" }),
            makeBudget({ name: "Beta", groupId: "b-1" }),
        ]);
        const { ensureBudget } = loadServer();
        await ensureBudget("Beta");
        expect(api.downloadBudget).toHaveBeenCalledWith(
            "b-1",
            expect.any(Object),
        );
    });

    test("returns silently when the budget is not found", async () => {
        await primeInit();
        const api = actual();
        api.getBudgets.mockResolvedValue([
            makeBudget({ name: "SGD", groupId: "sgd-1" }),
        ]);
        const { ensureBudget } = loadServer();
        await ensureBudget("NonExistent");
        expect(api.downloadBudget).not.toHaveBeenCalled();
    });

    test("skips download when already on the target budget", async () => {
        await primeInit("SGD");
        const api = actual();
        api.getBudgets.mockResolvedValue([
            makeBudget({ name: "SGD", groupId: "sgd-sync" }),
        ]);
        const { ensureBudget } = loadServer();
        await ensureBudget("sgd-sync");
        expect(api.downloadBudget).not.toHaveBeenCalled();
    });

    test("downloads new budget and switches activeSyncId", async () => {
        await primeInit("SGD");
        const api = actual();
        api.getBudgets.mockResolvedValue([
            makeBudget({ name: "SGD", groupId: "sgd-sync" }),
            makeBudget({ name: "MYR", groupId: "myr-sync" }),
        ]);
        const { ensureBudget } = loadServer();
        await ensureBudget("myr-sync");
        expect(api.downloadBudget).toHaveBeenCalledWith(
            "myr-sync",
            expect.any(Object),
        );
    });

    test("calls downloadBudget on every budget switch", async () => {
        await primeInit("SGD");
        const api = actual();
        api.getBudgets.mockResolvedValue([
            makeBudget({ name: "SGD", groupId: "sgd-sync" }),
            makeBudget({ name: "MYR", groupId: "myr-sync" }),
        ]);
        const { ensureBudget } = loadServer();

        await ensureBudget("myr-sync");
        expect(api.downloadBudget).toHaveBeenCalledTimes(1);

        await ensureBudget("sgd-sync");
        expect(api.downloadBudget).toHaveBeenCalledTimes(2);

        await ensureBudget("myr-sync");
        expect(api.downloadBudget).toHaveBeenCalledTimes(3);
    });

    test("matches a budget by name when groupId differs", async () => {
        await primeInit("Test SGD");
        const api = actual();
        api.getBudgets.mockResolvedValue([
            makeBudget({ name: "Test SGD", groupId: "sgd-sync" }),
            makeBudget({ name: "Test MYR", groupId: "myr-sync" }),
        ]);
        const { ensureBudget } = loadServer();
        await ensureBudget("Test MYR");
        expect(api.downloadBudget).toHaveBeenCalledWith(
            "myr-sync",
            expect.any(Object),
        );
    });
});
