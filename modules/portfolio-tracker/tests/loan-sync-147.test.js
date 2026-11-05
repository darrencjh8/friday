import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../src/config.js";
import { ToolRegistry } from "../src/tools.js";

vi.mock("../src/ibkr_flex.js", () => ({
    pullFlexXml: vi.fn().mockResolvedValue({ success: false, skipped: true }),
    NOT_CONFIGURED_ERROR: "Not configured",
}));
import { pullFlexXml } from "../src/ibkr_flex.js";

const dirs = [];
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
    pullFlexXml.mockClear();
    pullFlexXml.mockResolvedValue({ success: false, skipped: true });
});

const defaultTargets = () => [
    { key: "emergency_primary", budget: "primary", metric: "emergency_total", portfolio_account_id: "pp-emergency" },
    { key: "emergency_secondary", budget: "secondary", metric: "emergency_total", portfolio_account_id: "pp-secondary" },
    { key: "warchest_primary", budget: "primary", metric: "investment_total", portfolio_account_id: "pp-warchest" },
    { key: "loans_primary", budget: "primary", metric: "account_balances", portfolio_account_id: "pp-loan", actual_account_ids: ["a", "b", "c"] },
];

function mappingFile(targets = defaultTargets()) {
    const dir = mkdtempSync(join(tmpdir(), "portfolio-sync-targets-"));
    dirs.push(dir);
    const file = join(dir, "portfolio-sync-targets.md");
    writeFileSync(file, `# Sync targets\n\n\`\`\`json\n${JSON.stringify({ version: 1, targets })}\n\`\`\`\n`);
    return file;
}

function setup({
    targets,
    balances = { a: -200, b: -150, c: 25 },
    accounts,
    currencies = { "pp-emergency": "SGD", "pp-secondary": "MYR", "pp-warchest": "SGD", "pp-loan": "SGD" },
    failSecondaryBudget = false,
    failBalanceRead = false,
    nullBudget = false,
    failUpdateAccount = "",
} = {}) {
    const config = new Config({
        DEEPSEEK_API_KEY: "test",
        ACTUAL_BUDGET_URL: "http://example.test",
        ACTUAL_BUDGET_PASSWORD: "test",
        ACTUAL_PRIMARY_BUDGET_FILE: "primary",
        ACTUAL_SECONDARY_BUDGET_FILE: "secondary",
        ONEDRIVE_CLIENT_ID: "test",
        PORTFOLIO_SYNC_TARGETS_FILE: targets === null ? join(tmpdir(), "missing-sync-targets.md") : mappingFile(targets),
    });
    const current = Object.fromEntries(Object.entries(currencies).map(([id]) => [id, id === "pp-loan" ? -325 : 0]));
    const bridge = {
        pull: vi.fn().mockResolvedValue({ status: "ok" }),
        push: vi.fn().mockResolvedValue({ status: "ok" }),
        getAccounts: vi.fn().mockResolvedValue(Object.entries(currencies).map(([id, currency]) => ({ id, currency }))),
        updateBalance: vi.fn(async ({ accountId, amount }) => {
            if (accountId === failUpdateAccount) throw new Error("private bridge failure detail");
            const cents = Math.round(amount * 100);
            const delta = cents - (current[accountId] ?? 0);
            current[accountId] = cents;
            return { status: delta ? "updated" : "unchanged", delta: delta / 100, private_ref: accountId };
        }),
        queryTaxonomies: vi.fn().mockResolvedValue({ taxonomies: [] }),
        getStatus: vi.fn().mockResolvedValue({ summary: { currencies: {}, equity_currencies: {} } }),
    };
    vi.stubGlobal("fetch", vi.fn(async (url) => {
        const { pathname, searchParams } = new URL(url);
        const budget = searchParams.get("budget_id");
        const failBudget = failSecondaryBudget && budget === "secondary";
        if (pathname === "/budget-12m") {
            if (failBudget) return { ok: false, status: 503, text: async () => "unavailable" };
            return { ok: true, status: 200, json: async () => nullBudget ? null : ({ emergency_total: 1000, investment_total: 2000 }) };
        }
        if (pathname === "/accounts") {
            return { ok: true, status: 200, json: async () => accounts ?? [
                { id: "a", offbudget: true }, { id: "b", offbudget: true }, { id: "c", offbudget: true },
                { id: "other", offbudget: true, currency: "MYR" },
            ] };
        }
        if (pathname.startsWith("/accounts/balance/")) {
            if (failBalanceRead) throw new Error("private source identifier");
            return { ok: true, status: 200, json: async () => ({ balance: balances[pathname.split("/").pop()] }) };
        }
        return { ok: false, status: 404, text: async () => "not found" };
    }));
    const registry = new ToolRegistry(config, null, null, bridge);
    vi.spyOn(registry, "_exportTaxonomiesToSheet").mockResolvedValue({ status: "skipped" });
    return { registry, bridge, balances };
}

const target = (result, name = "Loan balance") => result.sync_targets.find((item) => item.name === name);

it("syncs every mapped target and reconciles the signed loan sum", async () => {
    const { registry, bridge } = setup();
    const result = await registry._computeSyncAll();
    expect(result.sync_targets.map((item) => item.name)).toEqual([
        "Emergency Funds - SGD", "Emergency Funds - MYR", "Warchest", "Loan balance",
    ]);
    expect(target(result)).toMatchObject({ amount: -3.25, currency: "SGD", status: "unchanged", delta: 0 });
    expect(target(result)).not.toHaveProperty("account_id");
    expect(result.sync_targets.every((item) => !Object.hasOwn(item, "account_id"))).toBe(true);
    expect(JSON.stringify(result.sync_targets)).not.toContain("private_ref");
    expect(target(result, "Emergency Funds - SGD")).toMatchObject({ amount: 10, status: "updated" });
    expect(bridge.updateBalance).toHaveBeenCalledTimes(4);
    expect(bridge.push).toHaveBeenCalled();
    expect(registry._config.actualLoanAccountIds).toBeUndefined();
}, 20000);

it("sanitizes bridge errors before returning target results", async () => {
    const { registry } = setup({ failUpdateAccount: "pp-emergency" });
    const result = await registry._computeSyncAll();
    expect(target(result, "Emergency Funds - SGD")).toMatchObject({
        status: "error",
        error: "Balance update failed",
        result: { error: "Balance update failed" },
    });
    expect(JSON.stringify(result.sync_targets)).not.toContain("private bridge failure detail");
}, 20000);

it("reconciles a changed loan source balance by delta", async () => {
    const { registry, balances } = setup();
    await registry._computeSyncAll();
    balances.b = -250;
    expect(target(await registry._computeSyncAll())).toMatchObject({ amount: -4.25, status: "updated", delta: -1 });
}, 30000);

it.each([
    ["a missing mapping file", null],
    ["a mapping missing an existing target", defaultTargets().filter((item) => item.key !== "warchest_primary")],
    ["duplicate non-loan destinations", defaultTargets().map((item) => item.key === "warchest_primary" ? { ...item, portfolio_account_id: "pp-emergency" } : item)],
    ["an unknown metric", defaultTargets().map((item) => item.key === "loans_primary" ? { ...item, metric: "unexpected_total" } : item)],
    ["an empty loan source list", defaultTargets().map((item) => item.key === "loans_primary" ? { ...item, actual_account_ids: [] } : item)],
    ["a secondary-budget loan mapping", defaultTargets().map((item) => item.key === "loans_primary" ? { ...item, budget: "secondary" } : item)],
])("fails closed when sync mapping has %s", async (_label, targets) => {
    const { registry, bridge } = setup({ targets });
    const result = await registry._computeSyncAll();
    expect(result.sync_targets.map((item) => item.name)).toEqual(expect.arrayContaining([
        "Loan balance", "Emergency Funds - SGD", "Emergency Funds - MYR", "Warchest",
    ]));
    expect(target(result)).toMatchObject({ status: "error", delta: 0 });
    expect(result.sync_targets).toHaveLength(4);
    expect(result.sync_targets.filter((item) => item.status === "error")).toHaveLength(4);
    expect(bridge.updateBalance).not.toHaveBeenCalled();
    expect(bridge.pull).not.toHaveBeenCalled();
    expect(bridge.push).not.toHaveBeenCalled();
    expect(pullFlexXml).not.toHaveBeenCalled();
    expect(registry._exportTaxonomiesToSheet).not.toHaveBeenCalled();
}, 20000);

it("skips only a loan destination that collides with an existing target", async () => {
    const targets = defaultTargets().map((item) => item.key === "loans_primary"
        ? { ...item, portfolio_account_id: "pp-emergency" }
        : item);
    const { registry, bridge } = setup({ targets });
    const result = await registry._computeSyncAll();
    expect(target(result)).toMatchObject({ status: "error", delta: 0, error: "Loan destination conflicts with another sync target" });
    expect(target(result, "Emergency Funds - SGD").status).toBe("updated");
    expect(bridge.updateBalance).toHaveBeenCalledTimes(3);
    expect(bridge.updateBalance).not.toHaveBeenCalledWith(expect.objectContaining({ accountId: "pp-emergency", amount: -3.25 }));
}, 20000);

it.each([
    ["a missing account", [{ id: "a", offbudget: true }, { id: "b", offbudget: true }]],
    ["a non-SGD account", [{ id: "a", offbudget: true }, { id: "b", offbudget: true }, { id: "c", offbudget: true, currency: "MYR" }]],
    ["an on-budget account", [{ id: "a", offbudget: false }, { id: "b", offbudget: true }, { id: "c", offbudget: true }]],
])("keeps the other targets syncing when a loan source is %s", async (_label, accounts) => {
    const { registry, bridge } = setup({ accounts });
    const result = await registry._computeSyncAll();
    expect(target(result)).toMatchObject({ status: "error", delta: 0, error: "Required SGD off-budget loan account is invalid or missing" });
    expect(target(result, "Emergency Funds - SGD").status).toBe("updated");
    expect(bridge.push).toHaveBeenCalled();
}, 20000);

it("keeps primary targets syncing when the secondary budget fails", async () => {
    const { registry, bridge } = setup({ failSecondaryBudget: true });
    const result = await registry._computeSyncAll();
    expect(target(result, "Emergency Funds - MYR")).toMatchObject({ status: "error", delta: 0 });
    expect(target(result)).toMatchObject({ amount: -3.25, status: "unchanged" });
    expect(target(result, "Warchest").status).toBe("updated");
    expect(bridge.push).toHaveBeenCalled();
}, 20000);

it("reports null budget JSON per target instead of aborting the summary", async () => {
    const { registry, bridge } = setup({ nullBudget: true });
    const result = await registry._computeSyncAll();
    expect(result.sync_targets).toHaveLength(4);
    expect(result.sync_targets.slice(0, 3).every((item) => item.status === "error")).toBe(true);
    expect(target(result)).toMatchObject({ amount: -3.25, status: "unchanged", delta: 0 });
    expect(bridge.push).toHaveBeenCalled();
}, 20000);

it("reports a non-SGD loan destination without updating it", async () => {
    const { registry, bridge } = setup({ currencies: { "pp-emergency": "SGD", "pp-secondary": "MYR", "pp-warchest": "SGD", "pp-loan": "MYR" } });
    const result = await registry._computeSyncAll();
    expect(target(result)).toMatchObject({ status: "error", error: "Loan destination is missing or not SGD" });
    expect(bridge.updateBalance).not.toHaveBeenCalledWith(expect.objectContaining({ accountId: "pp-loan" }));
}, 20000);

it("reports an invalid balance without exposing source identifiers", async () => {
    const { registry } = setup({ balances: { a: -200, b: null, c: 25 } });
    expect(target(await registry._computeSyncAll())).toMatchObject({ status: "error", error: "Loan balance is invalid" });
}, 20000);

it("rejects safe-integer cents that cannot round-trip through dollar amounts", async () => {
    const { registry, bridge } = setup({
        balances: { a: 8999999999999999, b: 0, c: 0 },
    });
    expect(target(await registry._computeSyncAll())).toMatchObject({
        status: "error",
        error: "Loan balance is invalid",
    });
    expect(bridge.updateBalance).not.toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "pp-loan" }),
    );
}, 20000);

it("reports a failed source read without leaking its error", async () => {
    const { registry } = setup({ failBalanceRead: true });
    const result = await registry._computeSyncAll();
    expect(target(result)).toMatchObject({ status: "error", error: "Loan source read failed" });
    expect(JSON.stringify(result)).not.toContain("private source identifier");
}, 20000);
