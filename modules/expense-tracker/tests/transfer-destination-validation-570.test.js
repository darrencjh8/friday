/**
 * Regression tests for issue #570 — transfer-destination validation gaps that
 * the #563 review left open (accepted-risk; not Critical/High).
 *
 * 1. update_transaction must apply the same transfer-target guard that
 *    insert_transaction applies (#563), so a caller cannot point a row at a
 *    closed account, a missing account, or its own source account.
 * 2. validateTransferTarget must return the tool's uniform {error} shape when
 *    the /accounts lookup fails, instead of throwing (insert_failed).
 *
 * Data is production-derived and redacted: the account/payee IDs and the
 * suffixes below are the real shapes seen in the live `Darren SGD` budget
 * (Ryt Bank ...2444, OCBC 360 ..., Trust Card) with names kept as-is because
 * they appear in the alerts' own text.
 */
import { describe, it, expect } from "vitest";
import { Config } from "../src/config.js";
import { ToolRegistry } from "../src/tools.js";

const testEnv = {
    DEEPSEEK_API_KEY: "sk-test",
    ACTUAL_BUDGET_URL: "http://test:5006",
    ACTUAL_BUDGET_PASSWORD: "pw",
    ACTUAL_PRIMARY_BUDGET_FILE: "test-budget",
    DEDUP_DB_PATH: ":memory:",
};

const BUDGET = "test-budget";

// Live-shaped accounts. `transfer_acct` on the payee below points at
// CLOSED_ACCOUNT_ID, which is what a closed destination looks like.
const RYT_ACCOUNT_ID = "83a6495d-5990-48c9-a9bd-6766f817dbe6"; // Ryt Bank (source)
const SC_ACCOUNT_ID = "54708966-8017-4e9b-b151-c0eeda50be89"; // SC Bonus Saver ...2555
const CLOSED_ACCOUNT_ID = "closed-0000-0000-0000-000000000000";

const LIVE_ACCOUNTS = [
    { id: RYT_ACCOUNT_ID, name: "Ryt Bank", closed: false },
    { id: SC_ACCOUNT_ID, name: "SC Bonus Saver", closed: false },
    { id: CLOSED_ACCOUNT_ID, name: "Standard Chartered eSaver", closed: true },
];

// A transfer payee is identified by `transfer_acct`. Three shapes are covered:
// one targeting a closed account, one targeting the row's own source account,
// and one targeting an account absent from the live list.
function makePayees({ transferAcct }) {
    return [
        { id: "payee-ryt-transfer", name: "Ryt Bank", transfer_acct: RYT_ACCOUNT_ID },
        { id: "payee-sc-transfer", name: "SC Bonus Saver", transfer_acct: SC_ACCOUNT_ID },
        {
            id: "payee-closed-transfer",
            name: "Standard Chartered eSaver",
            transfer_acct: transferAcct,
        },
    ];
}

/**
 * Stub `_get` on the registry so no network is touched. `overrides` lets a test
 * make one path throw, which is how the API-failure cases are expressed.
 */
function stubGet(registry, {
    transferAcct = CLOSED_ACCOUNT_ID,
    throwOn = null,
    transactionAccount = RYT_ACCOUNT_ID,
} = {}) {
    const payees = makePayees({ transferAcct });
    const calls = [];
    registry._get = async (path) => {
        calls.push(path);
        if (throwOn && path === throwOn) {
            throw new Error("accounts lookup failed");
        }
        if (path === "/payees") return payees;
        if (path === "/accounts") return LIVE_ACCOUNTS;
        if (path.startsWith("/transactions/")) return { id: path.split("/").pop(), account: transactionAccount };
        if (path === "/categories") return [];
        return [];
    };
    registry._patch = async (path, fields) => ({ id: path.split("/").pop(), ...fields });
    registry._post = async (path, body) => ({ id: "inserted", ...body });
    return { payees, calls };
}

describe("#570 update_transaction transfer-destination guard", () => {
    it("refuses an update that points the row at a closed transfer destination", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        stubGet(registry, { transferAcct: CLOSED_ACCOUNT_ID });

        const result = await registry.executeTool("update_transaction", {
            id: "txn-1",
            budget_id: BUDGET,
            account_id: RYT_ACCOUNT_ID,
            payee_id: "payee-closed-transfer",
        });

        expect(result).toMatchObject({
            error: "Transfer destination is closed or unavailable.",
        });
    });

    it("refuses an update whose transfer payee targets an account absent from the live list", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        stubGet(registry, { transferAcct: "deleted-1111-1111-1111-111111111111" });

        const result = await registry.executeTool("update_transaction", {
            id: "txn-1",
            budget_id: BUDGET,
            account_id: RYT_ACCOUNT_ID,
            payee_id: "payee-closed-transfer",
        });

        expect(result).toMatchObject({
            error: "Transfer destination is closed or unavailable.",
        });
    });

    it("refuses an update whose transfer payee targets the row's own source account", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        stubGet(registry, { transferAcct: RYT_ACCOUNT_ID });

        const result = await registry.executeTool("update_transaction", {
            id: "txn-1",
            budget_id: BUDGET,
            account_id: RYT_ACCOUNT_ID,
            payee_id: "payee-closed-transfer",
        });

        expect(result).toMatchObject({
            error: "Transfer destination cannot be its source account.",
        });
    });

    it("still updates to a valid transfer destination when it reads the row account", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const { calls } = stubGet(registry, { transferAcct: SC_ACCOUNT_ID });

        const result = await registry.executeTool("update_transaction", {
            id: "txn-1",
            budget_id: BUDGET,
            payee_id: "payee-closed-transfer",
        });

        expect(result).not.toHaveProperty("error");
        expect(result.payee).toBe("payee-closed-transfer");
        expect(calls).toContain("/transactions/txn-1");
    });

    it("fails closed when it cannot read the row account for a transfer update", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        stubGet(registry, { transferAcct: SC_ACCOUNT_ID, throwOn: "/transactions/txn-1" });

        const result = await registry.executeTool("update_transaction", {
            id: "txn-1",
            budget_id: BUDGET,
            payee_id: "payee-closed-transfer",
        });

        expect(result).toMatchObject({
            error: "Could not validate transfer destination.",
        });
    });

    it("refuses an account-only move of an existing transfer onto its destination", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        stubGet(registry, { transferAcct: SC_ACCOUNT_ID });
        registry._get = async (path) => {
            if (path === "/payees") return makePayees({ transferAcct: SC_ACCOUNT_ID });
            if (path === "/accounts") return LIVE_ACCOUNTS;
            if (path === "/transactions/txn-1") return { id: "txn-1", account: RYT_ACCOUNT_ID, payee: "payee-closed-transfer" };
            return [];
        };

        const result = await registry.executeTool("update_transaction", {
            id: "txn-1",
            budget_id: BUDGET,
            account_id: SC_ACCOUNT_ID,
        });

        expect(result).toMatchObject({
            error: "Transfer destination cannot be its source account.",
        });
    });

    it("allows a combined move that replaces a transfer payee with a normal payee", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const groceries = { id: "payee-groceries", name: "Groceries" };
        registry._get = async (path) => {
            if (path === "/payees") return [...makePayees({ transferAcct: SC_ACCOUNT_ID }), groceries];
            if (path === "/transactions/txn-1") return { id: "txn-1", account: RYT_ACCOUNT_ID, payee: "payee-closed-transfer" };
            return LIVE_ACCOUNTS;
        };
        registry._patch = async (_path, fields) => ({ id: "txn-1", ...fields });

        const result = await registry.executeTool("update_transaction", {
            id: "txn-1",
            budget_id: BUDGET,
            payee_id: groceries.id,
            account_id: SC_ACCOUNT_ID,
        });

        expect(result).toMatchObject({ payee: groceries.id, account: SC_ACCOUNT_ID });
    });

    it("recognizes an existing transfer payee from Actual's payee_id response shape", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        registry._get = async (path) => {
            if (path === "/payees") return makePayees({ transferAcct: SC_ACCOUNT_ID });
            if (path === "/accounts") return LIVE_ACCOUNTS;
            if (path === "/transactions/txn-1") return { id: "txn-1", account: RYT_ACCOUNT_ID, payee_id: "payee-closed-transfer" };
            return [];
        };

        const result = await registry.executeTool("update_transaction", {
            id: "txn-1",
            budget_id: BUDGET,
            account_id: SC_ACCOUNT_ID,
        });

        expect(result).toMatchObject({
            error: "Transfer destination cannot be its source account.",
        });
    });

    it("moves a plain non-transfer row without touching the payee endpoint", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const calls = [];
        registry._get = async (path) => {
            calls.push(path);
            if (path === "/payees") throw new Error("payees unavailable");
            if (path === "/transactions/txn-1") return { id: "txn-1", account: RYT_ACCOUNT_ID, payee: null };
            return LIVE_ACCOUNTS;
        };
        registry._patch = async (_path, fields) => ({ id: "txn-1", ...fields });

        const result = await registry.executeTool("update_transaction", {
            id: "txn-1",
            budget_id: BUDGET,
            account_id: SC_ACCOUNT_ID,
        });

        expect(result).toMatchObject({ account: SC_ACCOUNT_ID });
        expect(calls).not.toContain("/payees");
    });

    it("fails closed when the payee list is unreadable for an account-only transfer move", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        registry._get = async (path) => {
            if (path === "/payees") throw new Error("payees unavailable");
            if (path === "/accounts") return LIVE_ACCOUNTS;
            if (path === "/transactions/txn-1") return { id: "txn-1", account: RYT_ACCOUNT_ID, payee: "payee-closed-transfer" };
            return [];
        };

        const result = await registry.executeTool("update_transaction", {
            id: "txn-1",
            budget_id: BUDGET,
            account_id: SC_ACCOUNT_ID,
        });

        expect(result).toMatchObject({
            error: "Could not validate transfer destination.",
        });
    });

    it("fails closed when the existing transfer row has no source account", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        stubGet(registry, { transferAcct: SC_ACCOUNT_ID, transactionAccount: null });

        const result = await registry.executeTool("update_transaction", {
            id: "txn-1",
            budget_id: BUDGET,
            payee_id: "payee-closed-transfer",
        });

        expect(result).toMatchObject({
            error: "Could not validate transfer destination.",
        });
    });

    it("applies the same guard on the bare payee_name path", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        stubGet(registry, { transferAcct: CLOSED_ACCOUNT_ID });

        const result = await registry.executeTool("update_transaction", {
            id: "txn-1",
            budget_id: BUDGET,
            account_id: RYT_ACCOUNT_ID,
            payee_name: "Ryt Bank",
        });

        expect(result).toMatchObject({
            error: "Transfer destination cannot be its source account.",
        });
    });
});

describe("#570 insert_transaction transfer-destination lookup errors", () => {
    it("returns the uniform error object when the accounts lookup fails", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        stubGet(registry, { throwOn: "/accounts" });

        const result = await registry.executeTool("insert_transaction", {
            budget_id: BUDGET,
            account_id: RYT_ACCOUNT_ID,
            date: "2026-09-19",
            amount_cents: -100,
            payee_id: "payee-closed-transfer",
        });

        expect(result).toMatchObject({
            error: "Could not validate transfer destination.",
        });
    });
});
