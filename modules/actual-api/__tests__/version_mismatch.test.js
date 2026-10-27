/**
 * Regression tests for issue #799.
 *
 * When a newer Actual client (the sync-server's web UI) migrates a budget past
 * the migrations this process's `@actual-app/api` knows, the library logs
 * `out-of-sync-migrations`, closes the budget, and `downloadBudget` still
 * resolves. Every read then fails with the misleading "No budget file is open".
 * The route must instead name the version mismatch, and the operator must be
 * warned once through the Hermes webhook.
 *
 * This file owns its module registry: `initialized`, `activeSyncId` and the
 * warned-pair memo are module state.
 */
const previousEnv = {
    BUDGET_SWITCH_DELAY_MS: process.env.BUDGET_SWITCH_DELAY_MS,
    ACTUAL_BUDGET_URL: process.env.ACTUAL_BUDGET_URL,
    NOTIFY_URL: process.env.NOTIFY_URL,
    HERMES_WEBHOOK_SECRET: process.env.HERMES_WEBHOOK_SECRET,
};
process.env.BUDGET_SWITCH_DELAY_MS = "0";
process.env.ACTUAL_BUDGET_URL = "https://sync.example";
process.env.NOTIFY_URL = "https://hermes.example/notify";
process.env.HERMES_WEBHOOK_SECRET = "test-secret";

jest.mock("fs", () => ({
    ...jest.requireActual("fs"),
    mkdirSync: jest.fn(),
}));

afterAll(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
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

const crypto = require("crypto");
const actual = require("@actual-app/api");
// Read straight from disk so this file does not depend on the module the fix
// adds; the library's `exports` map hides its package.json from require().
const path = require("path");
const clientVersion = () =>
    JSON.parse(
        jest
            .requireActual("fs")
            .readFileSync(
                path.join(
                    __dirname,
                    "../node_modules/@actual-app/api/package.json",
                ),
                "utf8",
            ),
    ).version;
const server = require("../server");

const SGD = { name: "test-budget", groupId: "sgd-sync" };
const MYR = { name: "Alex MYR", groupId: "myr-sync" };
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

// Answers the sync-server's `/info` with `serverVersion` and records every
// webhook post.
function mockFetch(serverVersion) {
    return jest.fn(async (url) => {
        if (url === "https://sync.example/info") {
            return {
                ok: true,
                json: async () => ({
                    build: {
                        name: "@actual-app/sync-server",
                        version: serverVersion,
                    },
                }),
            };
        }
        return { ok: true, json: async () => ({}) };
    });
}

beforeEach(async () => {
    for (const fn of Object.values(actual)) fn.mockReset();
    actual.init.mockResolvedValue(undefined);
    actual.getBudgets.mockResolvedValue([SGD, MYR]);
    actual.downloadBudget.mockResolvedValue(undefined);
    actual.getAccounts.mockResolvedValue([]);
    await server.init();
});

describe("a budget the library closed after download (issue #799)", () => {
    test("names the version mismatch and warns the operator once", async () => {
        const newer = (() => {
            const [major, minor] = clientVersion().split(".").map(Number);
            return `${major}.${minor + 1}.0`;
        })();
        global.fetch = mockFetch(newer);
        // The download "succeeds", but the library closed MYR on
        // out-of-sync-migrations, so every probe after it sees no budget.
        actual.getAccounts.mockRejectedValue(NO_BUDGET_OPEN);

        const accounts = findHandler("get", "/accounts");
        const res = mockRes();
        await accounts({ query: { budget_id: "myr-sync" }, body: null }, res);

        expect(res.status).toHaveBeenCalledWith(500);
        const { error } = res.json.mock.calls[0][0];
        expect(error).toContain("ACTUAL_VERSION_MISMATCH");
        expect(error).toContain(clientVersion());
        expect(error).toContain(newer);

        const posts = global.fetch.mock.calls.filter(
            ([url]) => url === "https://hermes.example/notify",
        );
        expect(posts).toHaveLength(1);
        const [, init] = posts[0];
        expect(JSON.parse(init.body).message).toContain(newer);
        expect(init.headers["X-Webhook-Signature"]).toBe(
            crypto
                .createHmac("sha256", "test-secret")
                .update(init.body)
                .digest("hex"),
        );

        // A second failing request must not warn again for the same pair.
        await accounts(
            { query: { budget_id: "myr-sync" }, body: null },
            mockRes(),
        );
        expect(
            global.fetch.mock.calls.filter(
                ([url]) => url === "https://hermes.example/notify",
            ),
        ).toHaveLength(1);
    });

    test("a closed budget with no version gap says so instead of a mismatch", async () => {
        global.fetch = mockFetch(clientVersion());
        actual.getAccounts.mockRejectedValue(NO_BUDGET_OPEN);

        const accounts = findHandler("get", "/accounts");
        const res = mockRes();
        await accounts({ query: { budget_id: "myr-sync" }, body: null }, res);

        expect(res.status).toHaveBeenCalledWith(500);
        const { error } = res.json.mock.calls[0][0];
        expect(error).not.toContain("ACTUAL_VERSION_MISMATCH");
        expect(error).toContain("did not open after download");
    });
});
