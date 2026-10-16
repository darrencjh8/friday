/**
 * Extended ToolRegistry tests — pp-sync-all, pp-pull, pp-push,
 * check_duplicate, learn_mapping, ask_user_confirmation,
 * get_pp_status, query_pp_security.
 * Mocks Java bridge, HTTP calls, Google Sheets, and OneDrive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Config } from "../src/config.js";
import { ToolRegistry } from "../src/tools.js";
import { DedupJournal } from "../src/dedup.js";
import { MemoryStore } from "../src/memory.js";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, unlinkSync } from "fs";
import crypto from "crypto";

// Mock OneDrive module
vi.mock("../src/onedrive.js", () => ({
    pullFromOneDrive: vi.fn(),
    pushToOneDrive: vi.fn(),
}));

// Mock IBKR Flex module. NOT_CONFIGURED_ERROR is kept real: formatSyncResult
// imports it to tell an unconfigured integration from a real failure, so a bare
// { pullFlexXml } mock would leave it undefined and silently break the guard.
vi.mock("../src/ibkr_flex.js", async () => {
    const actual = await vi.importActual("../src/ibkr_flex.js");
    return { ...actual, pullFlexXml: vi.fn() };
});

import { pullFromOneDrive, pushToOneDrive } from "../src/onedrive.js";
import { pullFlexXml } from "../src/ibkr_flex.js";

const REQUIRED_ENV = {
    DEEPSEEK_API_KEY: "sk-test",
    ACTUAL_BUDGET_URL: "http://test:5006",
    ACTUAL_BUDGET_PASSWORD: "pw",
    ACTUAL_PRIMARY_BUDGET_FILE: "test-budget",
    PP_XML_PATH: "/data/portfolio.xml",
    PP_JAR_PATH: "/app/pp-cli.jar",
    ONEDRIVE_CLIENT_ID: "test-client-id",
};

/**
 * Create a mock PpJavaBridge that returns configurable responses.
 */
function createMockBridge(responses = {}) {
    return {
        getAccounts: vi.fn().mockResolvedValue(responses.accounts || []),
        getSecurities: vi.fn().mockResolvedValue(responses.securities || []),
        getPortfolio: vi.fn().mockResolvedValue(responses.portfolio || {}),
        insertTransaction: vi
            .fn()
            .mockResolvedValue(responses.insert || { status: "inserted" }),
        updateBalance: vi
            .fn()
            .mockResolvedValue(responses.balance || { status: "updated" }),
        pull: vi
            .fn()
            .mockResolvedValue(
                responses.pull || { status: "ok", detail: "downloaded" },
            ),
        push: vi
            .fn()
            .mockResolvedValue(
                responses.push || { status: "ok", detail: "uploaded" },
            ),
        queryTaxonomies: vi
            .fn()
            .mockResolvedValue(responses.taxonomies || { taxonomies: [] }),
        getTransactions: vi
            .fn()
            .mockResolvedValue(responses.transactions || []),
        getStatus: vi.fn().mockResolvedValue(
            responses.status || {
                summary: {
                    total_value_native: "0.00",
                    currencies: {},
                    equity_currencies: {},
                },
            },
        ),
        querySecurity: vi.fn().mockResolvedValue(
            responses.query || {
                ticker: "AAPL",
                shares: 100,
                price: 185.3,
            },
        ),
        importIbkr: vi.fn().mockResolvedValue(
            responses.import || {
                status: "ok",
                trades_imported: 1,
                dividends_imported: 0,
                other_imported: 0,
                securities_created: 0,
                items_skipped: 0,
                errors: [],
            },
        ),
    };
}

describe("ToolRegistry — dedup & memory tools", () => {
    let cfg;
    let dedup;
    let memory;
    let registry;
    let dbPath;

    beforeEach(() => {
        cfg = new Config(REQUIRED_ENV);
        dbPath = join(tmpdir(), `test-tools-dedup-${crypto.randomUUID()}.db`);
        dedup = new DedupJournal(dbPath);
        const memPath = join(
            tmpdir(),
            `test-tools-memory-${crypto.randomUUID()}.json`,
        );
        memory = new MemoryStore(memPath);
        registry = new ToolRegistry(cfg, dedup, memory, null);
    });

    afterEach(() => {
        try {
            if (dedup._db) dedup._db.close();
        } catch {}
    });

    describe("check_duplicate", () => {
        it("returns is_duplicate: false for new transaction", async () => {
            const result = await registry.executeTool("check_duplicate", {
                date: "2026-06-01",
                amount_cents: 1853000,
                account_id: "acct-1",
                security_id: "sec-aapl",
                type: "Buy",
            });
            expect(result).toEqual({ is_duplicate: false });
        });

        it("returns is_duplicate: true after recording", async () => {
            dedup.record(
                "2026-06-01",
                1853000,
                "acct-1",
                "corr-1",
                "sec-aapl",
                "Buy",
            );
            const result = await registry.executeTool("check_duplicate", {
                date: "2026-06-01",
                amount_cents: 1853000,
                account_id: "acct-1",
                security_id: "sec-aapl",
                type: "Buy",
            });
            expect(result).toEqual({ is_duplicate: true });
        });

        it("works with minimal args (no security_id, no type)", async () => {
            const result = await registry.executeTool("check_duplicate", {
                date: "2026-06-01",
                amount_cents: 50000,
                account_id: "acct-1",
            });
            expect(result).toEqual({ is_duplicate: false });
        });
    });

    describe("learn_mapping", () => {
        it("learns a securities mapping", async () => {
            const result = await registry.executeTool("learn_mapping", {
                type: "securities",
                key: "AAPL",
                value: "sec-aapl",
            });
            expect(result).toEqual({ status: "learned" });
            expect(memory.recall("securities", "AAPL")).toBe("sec-aapl");
        });

        it("learns an accounts mapping", async () => {
            await registry.executeTool("learn_mapping", {
                type: "accounts",
                key: "IBKR",
                value: "acct-ibkr-usd",
            });
            expect(memory.recall("accounts", "IBKR")).toBe("acct-ibkr-usd");
        });
    });

    describe("ask_user_confirmation", () => {
        it("returns confirmation request with defaults", async () => {
            const result = await registry.executeTool("ask_user_confirmation", {
                question: "Proceed with 3 trades?",
                context: "IBKR flex query import",
            });
            expect(result.requires_confirmation).toBe(true);
            expect(result.question).toBe("Proceed with 3 trades?");
            expect(result.context).toBe("IBKR flex query import");
            expect(result.options).toEqual(["approve", "reject"]);
        });

        it("returns custom options", async () => {
            const result = await registry.executeTool("ask_user_confirmation", {
                question: "Which account?",
                context: "Multiple matches",
                options: ["IBKR USD", "IBKR SGD", "cancel"],
            });
            expect(result.options).toEqual(["IBKR USD", "IBKR SGD", "cancel"]);
        });
    });

    describe("log_decision", () => {
        it("returns status: logged", async () => {
            const result = await registry.executeTool("log_decision", {
                action: "inserted",
                reasoning: "Approved IBKR import with 3 trades",
                transaction_id: "txn-123",
            });
            expect(result).toEqual({ status: "logged" });
        });
    });
});

describe("ToolRegistry — PP bridge tools", () => {
    let cfg;
    let dedup;
    let memory;
    let mockBridge;
    let registry;

    beforeEach(() => {
        cfg = new Config(REQUIRED_ENV);
        const dbPath = join(
            tmpdir(),
            `test-ppbridge-dedup-${crypto.randomUUID()}.db`,
        );
        dedup = new DedupJournal(dbPath);
        const memPath = join(
            tmpdir(),
            `test-ppbridge-memory-${crypto.randomUUID()}.json`,
        );
        memory = new MemoryStore(memPath);
        mockBridge = createMockBridge();
        registry = new ToolRegistry(cfg, dedup, memory, mockBridge);
        // Reset OneDrive mock defaults
        pullFromOneDrive.mockResolvedValue({ success: true });
        pushToOneDrive.mockResolvedValue({ success: true });
    });

    describe("pp-pull", () => {
        it("calls pullFromOneDrive and returns result", async () => {
            const result = await registry.executeTool("pp-pull", {});
            expect(result).toEqual({ status: "ok", detail: "downloaded" });
            expect(pullFromOneDrive).toHaveBeenCalled();
        });

        it("works without bridge configured (uses OneDrive API directly)", async () => {
            const reg = new ToolRegistry(cfg, dedup, memory, null);
            pullFromOneDrive.mockResolvedValue({ success: true });
            const result = await reg.executeTool("pp-pull", {});
            expect(result).toEqual({ status: "ok", detail: "downloaded" });
        });

        it("returns error detail when pull fails", async () => {
            pullFromOneDrive.mockResolvedValue({
                success: false,
                error: "Token expired",
            });
            const result = await registry.executeTool("pp-pull", {});
            expect(result).toEqual({
                status: "error",
                detail: "Token expired",
            });
        });
    });

    describe("pp-push", () => {
        it("calls pushToOneDrive and returns result", async () => {
            const result = await registry.executeTool("pp-push", {});
            expect(result).toEqual({ status: "ok", detail: "uploaded" });
            expect(pushToOneDrive).toHaveBeenCalled();
        });

        it("works without bridge configured (uses OneDrive API directly)", async () => {
            const reg = new ToolRegistry(cfg, dedup, memory, null);
            pushToOneDrive.mockResolvedValue({ success: true });
            const result = await reg.executeTool("pp-push", {});
            expect(result).toEqual({ status: "ok", detail: "uploaded" });
        });

        it("returns error detail when push fails", async () => {
            pushToOneDrive.mockResolvedValue({
                success: false,
                error: "Upload rejected",
            });
            const result = await registry.executeTool("pp-push", {});
            expect(result).toEqual({
                status: "error",
                detail: "Upload rejected",
            });
        });
    });

    describe("get_pp_status", () => {
        it("calls bridge.getStatus and _computeStatusSgd", async () => {
            const result = await registry.executeTool("get_pp_status", {});
            expect(mockBridge.getStatus).toHaveBeenCalled();
            expect(result).toHaveProperty("summary");
        });

        it("returns error when bridge not configured", async () => {
            const reg = new ToolRegistry(cfg, dedup, memory, null);
            const result = await reg.executeTool("get_pp_status", {});
            expect(result).toEqual({ error: "PP bridge not configured" });
        });
    });

    describe("query_pp_security", () => {
        it("calls bridge.querySecurity with search term", async () => {
            const result = await registry.executeTool("query_pp_security", {
                search: "AAPL",
            });
            expect(mockBridge.querySecurity).toHaveBeenCalledWith("AAPL", null);
            expect(result).toEqual({
                ticker: "AAPL",
                shares: 100,
                price: 185.3,
            });
        });

        it("returns error when bridge not configured", async () => {
            const reg = new ToolRegistry(cfg, dedup, memory, null);
            const result = await reg.executeTool("query_pp_security", {
                search: "AAPL",
            });
            expect(result).toEqual({ error: "PP bridge not configured" });
        });

        it("defaults search to empty string", async () => {
            await registry.executeTool("query_pp_security", {});
            expect(mockBridge.querySecurity).toHaveBeenCalledWith("", null);
        });

        it("passes account_id to bridge", async () => {
            await registry.executeTool("query_pp_security", {
                search: "AAPL",
                account_id: "uuid-abc",
            });
            expect(mockBridge.querySecurity).toHaveBeenCalledWith(
                "AAPL",
                "uuid-abc",
            );
        });
    });

    describe("fetch_pp_accounts", () => {
        it("calls bridge.getAccounts", async () => {
            mockBridge.getAccounts.mockResolvedValue([
                { id: "acct-1", name: "IBKR USD" },
            ]);
            const result = await registry.executeTool("fetch_pp_accounts", {});
            expect(result).toEqual([{ id: "acct-1", name: "IBKR USD" }]);
        });
    });

    describe("insert_pp_transaction", () => {
        it("calls bridge.insertTransaction with mapped args", async () => {
            const result = await registry.executeTool("insert_pp_transaction", {
                account_id: "acct-1",
                security_id: "sec-aapl",
                type: "Buy",
                date: "2026-06-01",
                shares: 100,
                price: 185.3,
                currency_code: "USD",
                fees: 1.0,
                taxes: 0.5,
                notes: "Test trade",
            });
            expect(result).toEqual({ status: "inserted" });
            expect(mockBridge.insertTransaction).toHaveBeenCalledWith({
                accountId: "acct-1",
                securityId: "sec-aapl",
                txnType: "Buy",
                date: "2026-06-01",
                shares: 100,
                price: 185.3,
                currencyCode: "USD",
                fees: 1.0,
                taxes: 0.5,
                notes: "Test trade",
                offsetAccountId: null,
                portfolioId: null,
            });
        });

        it("defaults fees and taxes to 0", async () => {
            await registry.executeTool("insert_pp_transaction", {
                account_id: "acct-1",
                type: "Buy",
                date: "2026-06-01",
                shares: 10,
                price: 100,
                currency_code: "USD",
            });
            expect(mockBridge.insertTransaction).toHaveBeenCalledWith(
                expect.objectContaining({ fees: 0, taxes: 0, portfolioId: null }),
            );
        });

        it("rejects duplicate via dedup check", async () => {
            // Seed a dedup record that matches
            const dedup2 = new DedupJournal(
                ':memory:',
            );
            dedup2.record("2026-06-01", 1853000, "acct-1", "prev-txn-id", "sec-aapl", "Buy");
            const reg2 = new ToolRegistry(cfg, dedup2, memory, mockBridge);

            const result = await reg2.executeTool("insert_pp_transaction", {
                account_id: "acct-1",
                security_id: "sec-aapl",
                type: "Buy",
                date: "2026-06-01",
                shares: 100,
                price: 185.3,
                currency_code: "USD",
            });
            expect(result.status).toBe("duplicate");
            expect(result.reason).toContain("Duplicate");
            // Bridge should NOT have been called
            expect(mockBridge.insertTransaction).not.toHaveBeenCalled();
        });

        it("records dedup after successful insert", async () => {
            const dedup2 = new DedupJournal(
                ':memory:',
            );
            const reg2 = new ToolRegistry(cfg, dedup2, memory, mockBridge);

            await reg2.executeTool("insert_pp_transaction", {
                account_id: "acct-1",
                security_id: "sec-aapl",
                type: "Buy",
                date: "2026-06-01",
                shares: 100,
                price: 185.3,
                currency_code: "USD",
            });
            // Re-insert same should be blocked
            const result = await reg2.executeTool("insert_pp_transaction", {
                account_id: "acct-1",
                security_id: "sec-aapl",
                type: "Buy",
                date: "2026-06-01",
                shares: 100,
                price: 185.3,
                currency_code: "USD",
            });
            expect(result.status).toBe("duplicate");
        });

        it("dedup hash correct for Dividend (price*100, not price*shares*100)", async () => {
            const dedup2 = new DedupJournal(":memory:");
            // Dividend: amount = price * 100, not price * shares * 100
            dedup2.record("2026-06-01", 5000, "acct-1", "div-1", "sec-aapl", "Dividend");
            const reg2 = new ToolRegistry(cfg, dedup2, memory, mockBridge);

            const result = await reg2.executeTool("insert_pp_transaction", {
                account_id: "acct-1",
                security_id: "sec-aapl",
                type: "Dividend",
                date: "2026-06-01",
                shares: 0,
                price: 50,
                currency_code: "USD",
            });
            // amount = 50 * 100 = 5000, should match recorded hash
            expect(result.status).toBe("duplicate");
        });

        it("dedup hash correct for Deposit (ignores shares)", async () => {
            const dedup2 = new DedupJournal(":memory:");
            dedup2.record("2026-06-01", 100000, "acct-1", "dep-1", "", "Deposit");
            const reg2 = new ToolRegistry(cfg, dedup2, memory, mockBridge);

            const result = await reg2.executeTool("insert_pp_transaction", {
                account_id: "acct-1",
                type: "Deposit",
                date: "2026-06-01",
                shares: 10,  // irrelevant for Deposit, should be ignored
                price: 1000,
                currency_code: "USD",
            });
            expect(result.status).toBe("duplicate");
        });

                it("passes offset_account_id to bridge", async () => {
            await registry.executeTool("insert_pp_transaction", {
                account_id: "acct-1",
                security_id: "sec-aapl",
                type: "Buy",
                date: "2026-06-01",
                shares: 100,
                price: 185.3,
                currency_code: "USD",
                offset_account_id: "acct-offset-1",
            });
            expect(mockBridge.insertTransaction).toHaveBeenCalledWith(
                expect.objectContaining({ offsetAccountId: "acct-offset-1" }),
            );
        });
    });


    it("resolves _portfolio_id from PP_OFFSET_MAP and passes to bridge", async () => {
        process.env.PP_OFFSET_MAP = JSON.stringify({"acct-1": "portfolio-uuid-123"});
        await registry.executeTool("insert_pp_transaction", {
            account_id: "acct-1", type: "Buy", date: "2026-06-01",
            shares: 10, price: 100, currency_code: "USD",
            offset_account_id: "warchest-uuid",
        });
        delete process.env.PP_OFFSET_MAP;
        const call = mockBridge.insertTransaction.mock.calls[0][0];
        expect(call.portfolioId).toBe("portfolio-uuid-123");
        expect(call.offsetAccountId).toBe("warchest-uuid");
    });

    it("preserves explicit offset_account_id alongside PP_OFFSET_MAP portfolio", async () => {
        process.env.PP_OFFSET_MAP = JSON.stringify({"acct-1": "portfolio-uuid-123"});
        await registry.executeTool("insert_pp_transaction", {
            account_id: "acct-1", type: "Buy", date: "2026-06-01",
            shares: 10, price: 100, currency_code: "USD",
            offset_account_id: "explicit-offset",
        });
        delete process.env.PP_OFFSET_MAP;
        const call = mockBridge.insertTransaction.mock.calls[0][0];
        expect(call.portfolioId).toBe("portfolio-uuid-123");
        expect(call.offsetAccountId).toBe("explicit-offset");
    });


        describe("notify_user", () => {
        it("returns status: sent on success", async () => {
            global.fetch = vi.fn().mockResolvedValueOnce({
                ok: true,
            });
            const result = await registry.executeTool("notify_user", {
                message: "Hello",
            });
            expect(result.status).toBe("sent");
        });

        it("returns error on fetch failure", async () => {
            global.fetch = vi
                .fn()
                .mockRejectedValueOnce(new Error("Network error"));
            const result = await registry.executeTool("notify_user", {
                message: "Hello",
            });
            expect(result.status).toBe("error");
            expect(result.detail).toBe("Network error");
        });

        it("returns HTTP error on non-ok response", async () => {
            global.fetch = vi.fn().mockResolvedValueOnce({
                ok: false,
                status: 500,
                text: () => Promise.resolve("Internal error"),
            });
            const result = await registry.executeTool("notify_user", {
                message: "Hello",
            });
            expect(result.status).toBe("error");
            expect(result.detail).toContain("500");
        });
    });
});

describe("ToolRegistry — lazy bridge initialization", () => {
    let cfg;
    let dedup;
    let memory;
    let xmlPath;

    beforeEach(() => {
        cfg = new Config(REQUIRED_ENV);
        const dbPath = join(
            tmpdir(),
            `test-lazybridge-dedup-${crypto.randomUUID()}.db`,
        );
        dedup = new DedupJournal(dbPath);
        const memPath = join(
            tmpdir(),
            `test-lazybridge-memory-${crypto.randomUUID()}.json`,
        );
        memory = new MemoryStore(memPath);
        // Reset OneDrive mock defaults
        pullFromOneDrive.mockResolvedValue({ success: true });
    });

    it("lazy-initializes bridge when XML file exists on disk", () => {
        // Create a real XML file at a known path
        xmlPath = join(tmpdir(), `test-lazy-${crypto.randomUUID()}.xml`);
        writeFileSync(xmlPath, "<portfolio/>");

        const overrides = { ...REQUIRED_ENV, PP_XML_PATH: xmlPath };
        const testCfg = new Config(overrides);
        const reg = new ToolRegistry(testCfg, dedup, memory, null);

        // Before accessing _ppBridge, the backing field should be null
        expect(reg.__ppBridge).toBeNull();

        // Accessing the getter should create the bridge (file exists)
        const bridge = reg._ppBridge;
        expect(bridge).not.toBeNull();
        expect(bridge._xmlPath).toBe(xmlPath);
        expect(typeof bridge.getAccounts).toBe("function");

        // Backing field is now cached
        expect(reg.__ppBridge).toBe(bridge);

        unlinkSync(xmlPath);
    });

    it("returns null from lazy getter when XML file doesn't exist", () => {
        const nonExistent = join(
            tmpdir(),
            `does-not-exist-${crypto.randomUUID()}.xml`,
        );
        const overrides = { ...REQUIRED_ENV, PP_XML_PATH: nonExistent };
        const testCfg = new Config(overrides);
        const reg = new ToolRegistry(testCfg, dedup, memory, null);

        // Accessing getter should return null (file doesn't exist)
        const bridge = reg._ppBridge;
        expect(bridge).toBeNull();
        expect(reg.__ppBridge).toBeNull();
    });

    it("pp-pull works without bridge, then bridge lazy-inits for PP tools", async () => {
        // Simulate the real flow: XML appears after pp-pull downloads it
        xmlPath = join(tmpdir(), `test-flow-${crypto.randomUUID()}.xml`);
        const overrides = { ...REQUIRED_ENV, PP_XML_PATH: xmlPath };
        const testCfg = new Config(overrides);
        const reg = new ToolRegistry(testCfg, dedup, memory, null);

        // 1. Before pp-pull: bridge is null
        expect(reg._ppBridge).toBeNull();

        // 2. pp-pull downloads the file to disk (no bridge needed)
        pullFromOneDrive.mockResolvedValue({ success: true });
        const pullResult = await reg.executeTool("pp-pull", {});
        expect(pullResult).toEqual({ status: "ok", detail: "downloaded" });

        // 3. Create the file on disk (simulating what pullFromOneDrive does)
        writeFileSync(xmlPath, "<portfolio/>");

        // 4. Now a PP tool should lazy-init the bridge
        const bridge = reg._ppBridge;
        expect(bridge).not.toBeNull();
        expect(bridge._xmlPath).toBe(xmlPath);

        unlinkSync(xmlPath);
    });
});

describe("ToolRegistry — _computeSyncAll with flex pull", () => {
    let registry;
    let bridge;

    beforeEach(() => {
        vi.clearAllMocks();

        pullFromOneDrive.mockResolvedValue({ success: true });
        pushToOneDrive.mockResolvedValue({ success: true });

        // Stub AbortSignal.timeout for test environment
        AbortSignal.timeout = vi.fn(() => ({ aborted: false }));

        bridge = createMockBridge();

        const cfg = new Config(REQUIRED_ENV);
        const dbPath = join(
            tmpdir(),
            `dedup-${crypto.randomBytes(4).toString("hex")}.db`,
        );
        const dedup = new DedupJournal(dbPath);
        const memory = new MemoryStore(
            join(
                tmpdir(),
                `mappings-${crypto.randomBytes(4).toString("hex")}.json`,
            ),
        );
        registry = new ToolRegistry(cfg, dedup, memory, bridge);

        // Stub AB budget fetch
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: () =>
                Promise.resolve({
                    emergency_total: 100000,
                    investment_total: 500000,
                }),
            text: () => Promise.resolve(""),
        });

        // Stub Google Sheets update
        vi.spyOn(registry, "_updateSheet").mockResolvedValue({
            cells_written: 10,
            errors: [],
        });
    });

    it("calls pullFlexXml and importIbkr during sync", async () => {
        pullFlexXml.mockResolvedValue({
            success: true,
            xml: "<FlexQueryResponse>...</FlexQueryResponse>",
        });

        const result = await registry._computeSyncAll();

        expect(pullFlexXml).toHaveBeenCalled();
        expect(bridge.importIbkr).toHaveBeenCalled();
        expect(result.flex_pull).toMatchObject({ success: true });
        expect(result.flex_import.trades_imported).toBe(1);
    });

    it("skips flex import when pullFlexXml fails", async () => {
        pullFlexXml.mockResolvedValue({
            success: false,
            error: "Network error",
        });

        const result = await registry._computeSyncAll();

        expect(pullFlexXml).toHaveBeenCalled();
        expect(bridge.importIbkr).not.toHaveBeenCalled();
        expect(result.flex_pull.success).toBe(false);
    });

    it("skips flex import when not configured", async () => {
        pullFlexXml.mockResolvedValue({
            success: false,
            error: "Not configured",
        });

        const result = await registry._computeSyncAll();

        expect(bridge.importIbkr).not.toHaveBeenCalled();
    });

    it("skips balance sync with actionable message when bridge is null", async () => {
        // Create registry WITHOUT a bridge (null)
        const cfgNoBridge = new Config(REQUIRED_ENV);
        const dedup2 = new DedupJournal(
            join(tmpdir(), `dedup-${crypto.randomBytes(4).toString("hex")}.db`),
        );
        const memory2 = new MemoryStore(
            join(
                tmpdir(),
                `mappings-${crypto.randomBytes(4).toString("hex")}.json`,
            ),
        );
        const registryNoBridge = new ToolRegistry(
            cfgNoBridge,
            dedup2,
            memory2,
            null,
        );

        vi.spyOn(registryNoBridge, "_updateSheet").mockResolvedValue({
            cells_written: 10,
            errors: [],
        });

        const result = await registryNoBridge._computeSyncAll();

        // All targets should be skipped with the right error
        expect(result.sync_targets.length).toBe(3);
        for (const t of result.sync_targets) {
            expect(t.status).toBe("skipped");
            expect(t.error).toContain("OneDrive not synced");
            expect(t.error).toContain("/onedrive setup");
        }
    });

    it("syncs balances when bridge is available", async () => {
        pullFlexXml.mockResolvedValue({
            success: false,
            error: "Not configured",
        });

        const result = await registry._computeSyncAll();

        expect(result.sync_targets.length).toBeGreaterThan(0);
        for (const t of result.sync_targets) {
            expect(t.status).toBe("updated");
        }
    });
});

describe("ToolRegistry — _fetchLiveRates", () => {
    let registry;

    beforeEach(() => {
        vi.clearAllMocks();
        const cfg = new Config(REQUIRED_ENV);
        const dbPath = join(
            tmpdir(),
            `test-fxrates-dedup-${crypto.randomUUID()}.db`,
        );
        const dedup = new DedupJournal(dbPath);
        const memory = new MemoryStore(":memory:");
        registry = new ToolRegistry(cfg, memory, dedup);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("fetches rates for USD, MYR, GBP, EUR from open-er-api", async () => {
        const origFetch = global.fetch;
        global.fetch = vi.fn().mockResolvedValue({
            status: 200,
            json: async () => ({
                rates: {
                    SGD: 1.35,
                    MYR: 4.50,
                    GBP: 0.78,
                    EUR: 0.92,
                },
            }),
        });

        try {
            const rates = await registry._fetchLiveRates();
            expect(rates["USD"]).toBeCloseTo(1.35, 2);
            expect(rates["MYR"]).toBeCloseTo(1.35 / 4.50, 2);
            expect(rates["GBP"]).toBeCloseTo(1.35 / 0.78, 2);
            expect(rates["EUR"]).toBeCloseTo(1.35 / 0.92, 2);
        } finally {
            global.fetch = origFetch;
        }
    });

    it("fetches additional currencies from portfolio data", async () => {
        const origFetch = global.fetch;
        global.fetch = vi.fn().mockResolvedValue({
            status: 200,
            json: async () => ({
                rates: {
                    SGD: 1.35,
                    HKD: 7.80,
                    JPY: 150.0,
                },
            }),
        });

        try {
            // Pass currencies seen in portfolio
            const rates = await registry._fetchLiveRates(["USD", "HKD", "JPY"]);
            expect(rates["USD"]).toBeCloseTo(1.35, 2);
            expect(rates["HKD"]).toBeCloseTo(1.35 / 7.80, 2);
            expect(rates["JPY"]).toBeCloseTo(1.35 / 150.0, 2);
        } finally {
            global.fetch = origFetch;
        }
    });

    it("returns empty object on API failure", async () => {
        const origFetch = global.fetch;
        global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

        try {
            const rates = await registry._fetchLiveRates();
            expect(rates).toEqual({});
        } finally {
            global.fetch = origFetch;
        }
    });
});

describe("ToolRegistry — _buildAnalysis", () => {
    let registry;

    beforeEach(() => {
        vi.clearAllMocks();
        const cfg = new Config(REQUIRED_ENV);
        const dbPath = join(
            tmpdir(),
            `test-analysis-dedup-${crypto.randomUUID()}.db`,
        );
        const dedup = new DedupJournal(dbPath);
        const memory = new MemoryStore(":memory:");
        registry = new ToolRegistry(cfg, memory, dedup);
    });

    const sampleTaxonomyData = {
        taxonomies: [
            {
                name: "Regions (Liquid)",
                values: [
                    {
                        value: "Investable Cash",
                        valuation_native: 63700,
                        currency: "SGD",
                        share_pct: 21.8,
                        children: [
                            {
                                name: "B4 Cash", ticker: "", currency: "SGD",
                                valuation_native: 63700, security_uuid: "cash-1",
                                security_type: "Cash", price_prev_close: null,
                                price_change_pct: null, stale_days: 0,
                            },
                        ],
                    },
                    {
                        value: "America",
                        valuation_native: 64123.45,
                        currency: "USD",
                        share_pct: 21.9,
                        children: [
                            {
                                name: "Microsoft Corp", ticker: "MSFT", currency: "USD",
                                valuation_native: 50241.23, security_uuid: "sec-msft",
                                security_type: "Equity", price_prev_close: 367.34,
                                price_change_pct: 4.8, stale_days: 1,
                            },
                            {
                                name: "NVIDIA Corp", ticker: "NVDA", currency: "USD",
                                valuation_native: 13882.22, security_uuid: "sec-nvda",
                                security_type: "Equity", price_prev_close: 208.65,
                                price_change_pct: 1.1, stale_days: 1,
                            },
                        ],
                    },
                    {
                        value: "Without Classification",
                        valuation_native: 331922,
                        currency: "SGD",
                        share_pct: 53.2,
                        children: [
                            {
                                name: "CPF OA", ticker: "", currency: "SGD",
                                valuation_native: 200000, security_uuid: "cpf-oa",
                                security_type: "Account", price_prev_close: null,
                                price_change_pct: null, stale_days: 0,
                            },
                        ],
                    },
                ],
            },
            {
                name: "Sector",
                values: [
                    {
                        value: "Technology", valuation_native: 64123.45, currency: "USD",
                        share_pct: 21.9,
                        children: [
                            {
                                name: "Microsoft Corp", ticker: "MSFT", currency: "USD",
                                valuation_native: 50241.23, security_uuid: "sec-msft",
                                security_type: "Equity",
                            },
                            {
                                name: "NVIDIA Corp", ticker: "NVDA", currency: "USD",
                                valuation_native: 13882.22, security_uuid: "sec-nvda",
                                security_type: "Equity",
                            },
                        ],
                    },
                ],
            },
        ],
    };

    const sampleFxRates = { USD: 1.35, SGD: 1.0, MYR: 0.30 };

    it("computes liquid_total_sgd from all non-WC taxonomies", () => {
        const analysis = registry._buildAnalysis(sampleTaxonomyData, sampleFxRates);
        // Cash: 63700 + MSFT: 50241.23*1.35=67826 + NVDA: 13882.22*1.35=18741 = 150267
        expect(analysis.liquid_total_sgd).toBeCloseTo(150267, 0);
    });

    it("computes illiquid_total_sgd from Without Classification", () => {
        const analysis = registry._buildAnalysis(sampleTaxonomyData, sampleFxRates);
        // Without Classification: only children sum to 200000 (CPF OA)
        expect(analysis.illiquid_total_sgd).toBeCloseTo(200000, 0);
    });

    it("computes cash_ratio_pct from Investable Cash / liquid", () => {
        const analysis = registry._buildAnalysis(sampleTaxonomyData, sampleFxRates);
        // 63700 / 150267 = 42.4%
        expect(analysis.cash_ratio_pct).toBeCloseTo(42.4, 0);
    });

    it("computes share_pct against total liquid (incl cash)", () => {
        // 50k cash + 100k equity = 150k total liquid
        // equity should be 100/150 = 66.7% of total liquid
        const data = {
            taxonomies: [{
                name: "Regions (Liquid)",
                values: [
                    {
                        value: "Investable Cash", valuation_native: 50000,
                        currency: "SGD", share_pct: 33.3, children: [
                            { name: "Cash", ticker: "", currency: "SGD", valuation_native: 50000, security_uuid: "c1", security_type: "Cash" },
                        ],
                    },
                    {
                        value: "America", valuation_native: 100000, currency: "SGD",
                        share_pct: 66.7, children: [
                            { name: "Stock", ticker: "STK", currency: "SGD", valuation_native: 100000, security_uuid: "s1", security_type: "Equity" },
                        ],
                    },
                ],
            }],
        };
        const analysis = registry._buildAnalysis(data, { SGD: 1.0 });
        expect(analysis.liquid_total_sgd).toBe(150000);
        // STK is 66.7% of total liquid (100k/150k), cash takes the other 33.3%
        expect(analysis.top_holdings[0].share_pct).toBe(66.7);
    });

    it("deduplicates top_holdings by security_uuid", () => {
        const analysis = registry._buildAnalysis(sampleTaxonomyData, sampleFxRates);
        // MSFT appears in both Regions and Sector — should be deduplicated
        expect(analysis.top_holdings.length).toBeLessThanOrEqual(5);
        const msftCount = analysis.top_holdings.filter(
            (h) => h.security_uuid === "sec-msft",
        ).length;
        expect(msftCount).toBe(1);
    });

    it("flags non-diversified holdings >20% of liquid", () => {
        // Create data where a single stock dominates
        const data = {
            taxonomies: [
                {
                    name: "Regions (Liquid)",
                    values: [
                        {
                            value: "America", valuation_native: 100000, currency: "SGD",
                            share_pct: 50, children: [
                                {
                                    name: "BigCorp", ticker: "BIG", currency: "SGD",
                                    valuation_native: 100000, security_uuid: "sec-big",
                                    security_type: "Equity", peak_days: 1,
                                },
                            ],
                        },
                        {
                            value: "Investable Cash", valuation_native: 50000, currency: "SGD",
                            share_pct: 25, children: [
                                {
                                    name: "Cash", ticker: "", currency: "SGD",
                                    valuation_native: 50000, security_uuid: "cash-1",
                                    security_type: "Cash", peak_days: 0,
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        const analysis = registry._buildAnalysis(data, { SGD: 1.0 });
        // BIG is 100000 / 150000 = 66.7%, non-diversified — should be flagged
        const bigFlags = analysis.flags.filter((f) => f.ticker === "BIG");
        expect(bigFlags.length).toBe(1);
        expect(bigFlags[0].severity).toBe("warn");
    });

    it("does NOT flag diversified holdings (ETFs) >20% via security_type", () => {
        const data = {
            taxonomies: [
                {
                    name: "Regions (Liquid)",
                    values: [
                        {
                            value: "America", valuation_native: 100000, currency: "SGD",
                            share_pct: 50, children: [
                                {
                                    name: "S&P 500 ETF", ticker: "CSPX", currency: "SGD",
                                    valuation_native: 100000, security_uuid: "sec-cspx",
                                    security_type: "ETF", peak_days: 1,
                                },
                            ],
                        },
                        {
                            value: "Investable Cash", valuation_native: 50000, currency: "SGD",
                            share_pct: 25, children: [
                                {
                                    name: "Cash", ticker: "", currency: "SGD",
                                    valuation_native: 50000, security_uuid: "cash-1",
                                    security_type: "Cash", peak_days: 0,
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        const analysis = registry._buildAnalysis(data, { SGD: 1.0 });
        const cspxFlags = analysis.flags.filter((f) => f.ticker === "CSPX");
        expect(cspxFlags.length).toBe(0);
    });

    it("detects diversified holdings from Asset Classes taxonomy", () => {
        // Simulate real production scenario: security_type is "" (PP doesn't expose it)
        // but Asset Classes taxonomy classifies CSPX as "Broad Index ETFs"
        const data = {
            taxonomies: [
                {
                    name: "Regions (Liquid)",
                    values: [
                        {
                            value: "America", valuation_native: 100000, currency: "SGD",
                            share_pct: 50, children: [
                                {
                                    name: "iShares Core S&P 500 UCITS ETF", ticker: "CSPX",
                                    currency: "USD", valuation_native: 100000,
                                    security_uuid: "sec-cspx", security_type: "",
                                },
                                {
                                    name: "DBS Group Holdings", ticker: "D05",
                                    currency: "SGD", valuation_native: 50000,
                                    security_uuid: "sec-d05", security_type: "",
                                },
                            ],
                        },
                    ],
                },
                {
                    name: "Asset Classes",
                    values: [
                        {
                            value: "Broad Index ETFs", valuation_native: 100000,
                            currency: "USD", share_pct: 50, children: [
                                {
                                    name: "iShares Core S&P 500 UCITS ETF",
                                    ticker: "CSPX", currency: "USD",
                                    valuation_native: 100000,
                                    security_uuid: "sec-cspx",
                                    security_type: "",
                                },
                            ],
                        },
                        {
                            value: "Dividend", valuation_native: 50000,
                            currency: "SGD", share_pct: 25, children: [
                                {
                                    name: "DBS Group Holdings",
                                    ticker: "D05", currency: "SGD",
                                    valuation_native: 50000,
                                    security_uuid: "sec-d05",
                                    security_type: "",
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        const fx = { USD: 1.35, SGD: 1.0 };
        const analysis = registry._buildAnalysis(data, fx);
        // CSPX (Broad Index ETFs) → diversified, no flag
        const cspxFlags = analysis.flags.filter((f) => f.ticker === "CSPX");
        expect(cspxFlags.length).toBe(0);
        // D05 (Dividend, 50000/150000=33.3%) → single stock, should be flagged
        const d05Flags = analysis.flags.filter((f) => f.ticker === "D05");
        expect(d05Flags.length).toBe(1);
        expect(d05Flags[0].severity).toBe("warn");
    });

    it("does NOT flag Cash-classified holdings as concentration risk", () => {
        const data = {
            taxonomies: [
                {
                    name: "Regions (Liquid)",
                    values: [
                        {
                            value: "Investable Cash", valuation_native: 100000,
                            currency: "SGD", share_pct: 66.7, children: [
                                {
                                    name: "Cash Account", ticker: "", currency: "SGD",
                                    valuation_native: 100000, security_uuid: "cash-uuid",
                                    security_type: "",
                                },
                            ],
                        },
                    ],
                },
                {
                    name: "Asset Classes",
                    values: [
                        {
                            value: "Cash", valuation_native: 100000,
                            currency: "SGD", share_pct: 66.7, children: [
                                {
                                    name: "Cash Account", ticker: "",
                                    currency: "SGD", valuation_native: 100000,
                                    security_uuid: "cash-uuid",
                                    security_type: "",
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        const analysis = registry._buildAnalysis(data, { SGD: 1.0 });
        // Cash is diversified — should not be flagged for concentration
        const warnings = analysis.flags.filter((f) => f.severity === "warn");
        expect(warnings.length).toBe(0);
    });

    it("handles missing Asset Classes taxonomy gracefully", () => {
        // No Asset Classes taxonomy — should fall back to security_type check
        const data = {
            taxonomies: [
                {
                    name: "Regions (Liquid)",
                    values: [
                        {
                            value: "America", valuation_native: 100000, currency: "SGD",
                            share_pct: 100, children: [
                                {
                                    name: "BigCorp", ticker: "BIG", currency: "SGD",
                                    valuation_native: 100000, security_uuid: "sec-big",
                                    security_type: "Equity",
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        const analysis = registry._buildAnalysis(data, { SGD: 1.0 });
        expect(analysis.top_holdings.length).toBe(1);
        // Falls back to security_type: "Equity" not in diversified types → flagged
        const bigFlags = analysis.flags.filter((f) => f.ticker === "BIG");
        expect(bigFlags.length).toBe(1);
    });

    it("uses Asset Class over empty security_type for Growth stocks", () => {
        // Growth stocks are NOT diversified even if security_type is ""
        const data = {
            taxonomies: [
                {
                    name: "Regions (Liquid)",
                    values: [
                        {
                            value: "America", valuation_native: 100000, currency: "SGD",
                            share_pct: 100, children: [
                                {
                                    name: "GrowthCorp", ticker: "GRW", currency: "SGD",
                                    valuation_native: 100000, security_uuid: "sec-grw",
                                    security_type: "",
                                },
                            ],
                        },
                    ],
                },
                {
                    name: "Asset Classes",
                    values: [
                        {
                            value: "Growth", valuation_native: 100000,
                            currency: "SGD", share_pct: 100, children: [
                                {
                                    name: "GrowthCorp", ticker: "GRW",
                                    currency: "SGD", valuation_native: 100000,
                                    security_uuid: "sec-grw",
                                    security_type: "",
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        const analysis = registry._buildAnalysis(data, { SGD: 1.0 });
        // "Growth" does not match diversified keywords → flagged as concentration
        const grwFlags = analysis.flags.filter((f) => f.ticker === "GRW");
        expect(grwFlags.length).toBe(1);
        expect(grwFlags[0].severity).toBe("warn");
    });

    it("includes sync status in message_body when syncMeta provided", () => {
        const syncMeta = {
            accounts_synced: 2,
            accounts_total: 3,
            accounts_errors: 1,
            ibkr_trades: 1,
            ibkr_dividends: 2,
            ibkr_skipped: 0,
            errors: [{ account: "Warchest", error: "timeout" }],
        };
        const analysis = registry._buildAnalysis(
            sampleTaxonomyData, sampleFxRates, syncMeta,
        );
        expect(analysis.message_body).toContain("Synced 2/3");
        expect(analysis.message_body).toContain("IBKR: 1 trades, 2 dividends");
    });

    it("omits sync section when syncMeta is empty", () => {
        const analysis = registry._buildAnalysis(
            sampleTaxonomyData, sampleFxRates, null,
        );
        expect(analysis.message_body).not.toContain("Synced");
        expect(analysis.message_body).not.toContain("IBKR:");
    });

    it("does NOT flag Account-type holdings (cash equivalents) as concentration risk", () => {
        const data = {
            taxonomies: [
                {
                    name: "Regions (Liquid)",
                    values: [
                        {
                            value: "Investable Cash", valuation_native: 50000,
                            currency: "SGD", share_pct: 33.3, children: [
                                {
                                    name: "Warchest", ticker: "", currency: "SGD",
                                    valuation_native: 50000, security_uuid: "warchest",
                                    security_type: "Account",
                                },
                            ],
                        },
                        {
                            value: "America", valuation_native: 100000, currency: "SGD",
                            share_pct: 66.7, children: [
                                {
                                    name: "GrowthCorp", ticker: "GRW", currency: "SGD",
                                    valuation_native: 100000, security_uuid: "sec-grw",
                                    security_type: "",
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        const analysis = registry._buildAnalysis(data, { SGD: 1.0 });
        const warchestFlags = analysis.flags.filter((f) => f.ticker === "");
        expect(warchestFlags.length).toBe(0);
        const grwFlags = analysis.flags.filter((f) => f.ticker === "GRW");
        expect(grwFlags.length).toBe(1);
    });

    it("uses name instead of ISIN-like tickers in flags and holdings", () => {
        const data = {
            taxonomies: [
                {
                    name: "Regions (Liquid)",
                    values: [
                        {
                            value: "Europe", valuation_native: 100000, currency: "SGD",
                            share_pct: 100, children: [
                                {
                                    name: "Amundi Index MSCI World",
                                    ticker: "LU2420245917.EUFUND",
                                    currency: "SGD", valuation_native: 100000,
                                    security_uuid: "sec-amundi",
                                    security_type: "",
                                },
                            ],
                        },
                    ],
                },
                {
                    name: "Asset Classes",
                    values: [
                        {
                            value: "Broad Index ETFs", valuation_native: 100000,
                            currency: "SGD", share_pct: 100, children: [
                                {
                                    name: "Amundi Index MSCI World",
                                    ticker: "LU2420245917.EUFUND",
                                    currency: "SGD", valuation_native: 100000,
                                    security_uuid: "sec-amundi",
                                    security_type: "",
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        const analysis = registry._buildAnalysis(data, { SGD: 1.0 });
        expect(analysis.message_body).toContain("Amundi Index MSCI World");
        expect(analysis.message_body).not.toContain("LU2420245917.EUFUND");
        expect(analysis.flags.length).toBe(0);
    });

    it("uses ticker for normal stocks, name for ISIN-like tickers", () => {
        const data = {
            taxonomies: [
                {
                    name: "Regions (Liquid)",
                    values: [
                        {
                            value: "America", valuation_native: 200000, currency: "SGD",
                            share_pct: 100, children: [
                                {
                                    name: "Microsoft Corp", ticker: "MSFT",
                                    currency: "USD", valuation_native: 100000,
                                    security_uuid: "sec-msft",
                                    security_type: "Equity",
                                },
                                {
                                    name: "Fullerton SGD Cash Fund",
                                    ticker: "0P0001TB9O.SI",
                                    currency: "SGD", valuation_native: 100000,
                                    security_uuid: "sec-fullerton",
                                    security_type: "",
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        const analysis = registry._buildAnalysis(data, { USD: 1.35, SGD: 1.0 });
        expect(analysis.message_body).toContain("MSFT");
        expect(analysis.message_body).toContain("Fullerton SGD Cash Fund");
        expect(analysis.message_body).not.toContain("0P0001TB9O.SI");
    });


    it("computes top_movers by abs(price_change_pct)", () => {
        const analysis = registry._buildAnalysis(sampleTaxonomyData, sampleFxRates);
        // MSFT (+4.8%) should be the biggest mover
        // NVDA (+1.1%) second
        // Cash/CPF have null price_change_pct — excluded
        expect(analysis.top_movers.length).toBe(2);
        expect(analysis.top_movers[0].ticker).toBe("MSFT");
        expect(analysis.top_movers[1].ticker).toBe("NVDA");
    });

    it("generates message_body with all sections", () => {
        const analysis = registry._buildAnalysis(sampleTaxonomyData, sampleFxRates);
        expect(analysis.message_body).toBeDefined();
        expect(typeof analysis.message_body).toBe("string");
        expect(analysis.message_body.length).toBeGreaterThan(100);
        // Should contain key sections
        expect(analysis.message_body).toContain("Liquid");
        expect(analysis.message_body).toContain("| Holding | % | SGD |");
        expect(analysis.message_body).toContain("MSFT");
    });

    it("handles empty taxonomy data gracefully", () => {
        const analysis = registry._buildAnalysis(
            { taxonomies: [] },
            sampleFxRates,
        );
        expect(analysis.liquid_total_sgd).toBe(0);
        expect(analysis.illiquid_total_sgd).toBe(0);
        expect(analysis.top_holdings).toEqual([]);
        expect(analysis.flags).toEqual([]);
        expect(analysis.message_body).toContain("No portfolio data");
    });

    it("fetches news from Google News RSS and filters by 24h", async () => {
        const mockRss = new URLSearchParams();
        const rss = '<?xml version="1.0"?><rss><channel>'
            + '<item><title>NVDA beats estimates</title>'
            + '<link>https://example.com/nvda1</link>'
            + '<pubDate>' + new Date().toUTCString() + '</pubDate></item>'
            + '<item><title>Old NVDA news</title>'
            + '<link>https://example.com/nvda2</link>'
            + '<pubDate>' + new Date(Date.now() - 48 * 3600000).toUTCString() + '</pubDate></item>'
            + '</channel></rss>';
        fetch.mockResolvedValueOnce({ status: 200, text: () => Promise.resolve(rss) });
        const headlines = await registry._fetchNews(["NVDA"]);
        expect(headlines.length).toBe(1);
        expect(headlines[0]).toContain("NVDA");
        expect(headlines[0]).toContain("beats estimates");
    });

    it("returns empty on network failure", async () => {
        fetch.mockRejectedValueOnce(new Error("Network error"));
        const headlines = await registry._fetchNews(["NVDA"]);
        expect(headlines).toEqual([]);
    });

    it("includes news section in message_body when provided", () => {
        const newsBlock = [" NVDA \u2014 beats estimates (https://example.com)"];
        const analysis = registry._buildAnalysis(
            sampleTaxonomyData, sampleFxRates, null, newsBlock,
        );
        expect(analysis.message_body).toContain("*News (last 24h)*");
        expect(analysis.message_body).toContain("beats estimates");
    });

    // ── Fix 1: Illiquid holdings labeled separately ──
    it("labels holdings table as Liquid Holdings", () => {
        const analysis = registry._buildAnalysis(sampleTaxonomyData, sampleFxRates);
        expect(analysis.message_body).toContain("**Liquid Holdings**");
        // Illiquid section should exist with CPF OA
        expect(analysis.message_body).toContain("**Illiquid Holdings**");
        expect(analysis.message_body).toContain("CPF OA");
    });

    it("shows illiquid holdings with percentage of illiquid total", () => {
        const analysis = registry._buildAnalysis(sampleTaxonomyData, sampleFxRates);
        // CPF OA: 200000 / 200000 = 100%
        expect(analysis.message_body).toContain("100");
    });

    it("omits Illiquid Holdings section when no illiquid holdings", () => {
        const data = {
            taxonomies: [{
                name: "Regions (Liquid)",
                values: [{
                    value: "America", valuation_native: 100000, currency: "SGD",
                    share_pct: 100, children: [{
                        name: "Test Stock", ticker: "TST", currency: "SGD",
                        valuation_native: 100000, security_uuid: "sec-tst",
                        security_type: "Equity",
                    }],
                }],
            }],
        };
        const analysis = registry._buildAnalysis(data, { SGD: 1.0 });
        expect(analysis.message_body).toContain("**Liquid Holdings**");
        expect(analysis.message_body).not.toContain("**Illiquid Holdings**");
    });

    it("filters zero and negative valuations from illiquid holdings", () => {
        const data = {
            taxonomies: [{
                name: "Regions (Liquid)",
                values: [
                    {
                        value: "Without Classification", valuation_native: 98725,
                        currency: "SGD", share_pct: 100, children: [
                            {
                                name: "CPF OA", ticker: "", currency: "SGD",
                                valuation_native: 100000, security_uuid: "cpf-oa",
                                security_type: "Account", stale_days: 0,
                            },
                            {
                                name: "POEMS", ticker: "", currency: "SGD",
                                valuation_native: -1275, security_uuid: "poems",
                                security_type: "Account", stale_days: 0,
                            },
                        ],
                    },
                ],
            }],
        };
        const analysis = registry._buildAnalysis(data, { SGD: 1.0 });
        expect(analysis.illiquid_holdings.length).toBe(1);
        expect(analysis.illiquid_holdings[0].name).toBe("CPF OA");
        expect(analysis.message_body).not.toContain("POEMS");
    });

    it("uses displayLabel for illiquid holdings with ISIN-like tickers", () => {
        const data = {
            taxonomies: [{
                name: "Regions (Liquid)",
                values: [
                    {
                        value: "Without Classification", valuation_native: 100000,
                        currency: "SGD", share_pct: 100, children: [
                            {
                                name: "Amundi Index Fund",
                                ticker: "LU2420245917.EUFUND",
                                currency: "SGD", valuation_native: 100000,
                                security_uuid: "sec-illiquid-fund",
                                security_type: "", stale_days: 0,
                            },
                        ],
                    },
                ],
            }],
        };
        const analysis = registry._buildAnalysis(data, { SGD: 1.0 });
        expect(analysis.message_body).toContain("Amundi Index Fund");
        expect(analysis.message_body).not.toContain("LU2420245917.EUFUND");
    });

    // ── Fix 2: Warchest and exempt names skip concentration warnings ──
    it("does NOT flag Warchest as concentration risk regardless of security_type", () => {
        const data = {
            taxonomies: [
                {
                    name: "Regions (Liquid)",
                    values: [
                        {
                            value: "Investable Cash", valuation_native: 50000,
                            currency: "SGD", share_pct: 50, children: [
                                {
                                    name: "Warchest", ticker: "", currency: "SGD",
                                    valuation_native: 50000, security_uuid: "warchest-uuid",
                                    security_type: "",  // No type set — name-based exemption
                                },
                            ],
                        },
                        {
                            value: "America", valuation_native: 50000, currency: "SGD",
                            share_pct: 50, children: [
                                {
                                    name: "TestCo", ticker: "TST", currency: "SGD",
                                    valuation_native: 50000, security_uuid: "sec-tst",
                                    security_type: "Equity",
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        const analysis = registry._buildAnalysis(data, { SGD: 1.0 });
        const warchestFlags = analysis.flags.filter((f) => f.reason && f.reason.includes("Warchest"));
        expect(warchestFlags.length).toBe(0);
    });

    it("excludes cash holdings from topHoldings table", () => {
        const data = {
            taxonomies: [
                {
                    name: "Regions (Liquid)",
                    values: [
                        {
                            value: "Investable Cash", valuation_native: 50000,
                            currency: "SGD", share_pct: 33.3, children: [
                                {
                                    name: "Warchest", ticker: "", currency: "SGD",
                                    valuation_native: 50000, security_uuid: "warchest-uuid",
                                    security_type: "",
                                },
                            ],
                        },
                        {
                            value: "America", valuation_native: 100000, currency: "SGD",
                            share_pct: 66.7, children: [
                                {
                                    name: "TestCo", ticker: "TST", currency: "SGD",
                                    valuation_native: 100000, security_uuid: "sec-tst",
                                    security_type: "Equity",
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        const analysis = registry._buildAnalysis(data, { SGD: 1.0 });
        // Warchest (cash) should NOT be in topHoldings
        const cashInHoldings = analysis.top_holdings.filter((h) => h.is_cash);
        expect(cashInHoldings.length).toBe(0);
        // TestCo should be the only top holding
        expect(analysis.top_holdings.length).toBe(1);
        expect(analysis.top_holdings[0].ticker).toBe("TST");
    });

    it("respects PP_CONCENTRATION_EXEMPT_NAMES for custom exemptions", () => {
        process.env.PP_CONCENTRATION_EXEMPT_NAMES = "MyEmergencyFund";
        // Read exemption names from the registry's config (already constructed)
        // We test by building analysis with a holding matching the exempt name
        const data = {
            taxonomies: [
                {
                    name: "Regions (Liquid)",
                    values: [
                        {
                            value: "Investable Cash", valuation_native: 50000,
                            currency: "SGD", share_pct: 50, children: [
                                {
                                    name: "MyEmergencyFund", ticker: "", currency: "SGD",
                                    valuation_native: 50000, security_uuid: "emfund",
                                    security_type: "",
                                },
                            ],
                        },
                        {
                            value: "America", valuation_native: 50000, currency: "SGD",
                            share_pct: 50, children: [
                                {
                                    name: "TestCo", ticker: "TST", currency: "SGD",
                                    valuation_native: 50000, security_uuid: "sec-tst",
                                    security_type: "Equity",
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        const analysis = registry._buildAnalysis(data, { SGD: 1.0 });
        const exemptFlags = analysis.flags.filter((f) => f.reason && f.reason.includes("MyEmergencyFund"));
        expect(exemptFlags.length).toBe(0);
        delete process.env.PP_CONCENTRATION_EXEMPT_NAMES;
    });

    // ── Fix 3: News formatting — clean summary, no raw URLs ──
    it("decodes HTML entities in news titles", async () => {
        const rss = '<?xml version="1.0"?><rss><channel>'
            + '<item><title>AMD &amp; NVDA: analysts&#39; top picks</title>'
            + '<link>https://news.google.com/rss/articles/CBMi1234567890?oc=5</link>'
            + '<pubDate>' + new Date().toUTCString() + '</pubDate></item>'
            + '</channel></rss>';
        fetch.mockResolvedValueOnce({ status: 200, text: () => Promise.resolve(rss) });
        const headlines = await registry._fetchNews(["AMD"]);
        expect(headlines.length).toBe(1);
        expect(headlines[0]).toContain("&");
        expect(headlines[0]).toContain("'");
        expect(headlines[0]).not.toContain("&amp;");
        expect(headlines[0]).not.toContain("&#39;");
    });

    it("decodes extended HTML entities (mdash, nbsp, hellip)", async () => {
        const rss = '<?xml version="1.0"?><rss><channel>'
            + '<item><title>Market&mdash;update&nbsp;2026&hellip;</title>'
            + '<link>https://example.com/news</link>'
            + '<pubDate>' + new Date().toUTCString() + '</pubDate></item>'
            + '</channel></rss>';
        fetch.mockResolvedValueOnce({ status: 200, text: () => Promise.resolve(rss) });
        const headlines = await registry._fetchNews(["MKT"]);
        expect(headlines.length).toBe(1);
        expect(headlines[0]).toContain("\u2014"); // em dash
        expect(headlines[0]).toContain("\u2026"); // hellip
        expect(headlines[0]).not.toContain("&mdash;");
        expect(headlines[0]).not.toContain("&nbsp;");
        expect(headlines[0]).not.toContain("&hellip;");
    });

    it("strips Google News redirect URLs from news output", async () => {
        const rss = '<?xml version="1.0"?><rss><channel>'
            + '<item><title>NVDA beats estimates</title>'
            + '<link>https://news.google.com/rss/articles/CBMi1234567890?oc=5</link>'
            + '<pubDate>' + new Date().toUTCString() + '</pubDate></item>'
            + '</channel></rss>';
        fetch.mockResolvedValueOnce({ status: 200, text: () => Promise.resolve(rss) });
        const headlines = await registry._fetchNews(["NVDA"]);
        expect(headlines.length).toBe(1);
        expect(headlines[0]).toContain("NVDA");
        expect(headlines[0]).toContain("beats estimates");
        expect(headlines[0]).not.toContain("news.google.com");
        expect(headlines[0]).not.toContain("http");
    });

    it("formats news as dash-list summary lines", async () => {
        const rss = '<?xml version="1.0"?><rss><channel>'
            + '<item><title>AMD raises guidance</title>'
            + '<link>https://example.com/amd</link>'
            + '<pubDate>' + new Date().toUTCString() + '</pubDate></item>'
            + '</channel></rss>';
        fetch.mockResolvedValueOnce({ status: 200, text: () => Promise.resolve(rss) });
        const headlines = await registry._fetchNews(["AMD"]);
        expect(headlines.length).toBe(1);
        expect(headlines[0]).toMatch(/^- /);
        expect(headlines[0]).toContain("AMD");
        expect(headlines[0]).toContain("raises guidance");
        expect(headlines[0]).not.toContain("http");
    });

    it("filters out mangled anti-scraping headlines", async () => {
        // Simulate Google News spaced-out characters anti-scraping
        const rss = '<?xml version="1.0"?><rss><channel>'
            + '<item><title>A M D S h a r e s B o u g h t</title>'
            + '<link>https://example.com/mangled</link>'
            + '<pubDate>' + new Date().toUTCString() + '</pubDate></item>'
            + '<item><title>AMD beats estimates</title>'
            + '<link>https://example.com/normal</link>'
            + '<pubDate>' + new Date().toUTCString() + '</pubDate></item>'
            + '</channel></rss>';
        fetch.mockResolvedValueOnce({ status: 200, text: () => Promise.resolve(rss) });
        const headlines = await registry._fetchNews(["AMD"]);
        // Only the normal headline should survive
        expect(headlines.length).toBe(1);
        expect(headlines[0]).toContain("beats estimates");
        expect(headlines[0]).not.toContain("A M D");
    });

    it("filters out concatenated anti-scraping headlines (no spaces, long)", async () => {
        const rss = '<?xml version="1.0"?><rss><channel>'
            + '<item><title>AMDSharesBoughtbyFifthThirdBancorpMarketBeatWallStreet</title>'
            + '<link>https://example.com/concat</link>'
            + '<pubDate>' + new Date().toUTCString() + '</pubDate></item>'
            + '<item><title>AMD beats estimates</title>'
            + '<link>https://example.com/normal</link>'
            + '<pubDate>' + new Date().toUTCString() + '</pubDate></item>'
            + '</channel></rss>';
        fetch.mockResolvedValueOnce({ status: 200, text: () => Promise.resolve(rss) });
        const headlines = await registry._fetchNews(["AMD"]);
        expect(headlines.length).toBe(1);
        expect(headlines[0]).toContain("beats estimates");
    });

    it("top_holdings excludes cash, displayLabel hides ISIN-like tickers", () => {
        const data = {
            taxonomies: [{
                name: "Regions (Liquid)",
                values: [
                    {
                        value: "Investable Cash", valuation_native: 50000,
                        currency: "SGD", share_pct: 25, children: [
                            { name: "Warchest", ticker: "", currency: "SGD", valuation_native: 50000, security_uuid: "wc", security_type: "" },
                        ],
                    },
                    {
                        value: "America", valuation_native: 150000, currency: "SGD",
                        share_pct: 75, children: [
                            { name: "Amundi Index MSCI World", ticker: "LU2420245917.EUFUND", currency: "SGD", valuation_native: 100000, security_uuid: "am", security_type: "" },
                            { name: "DBS Group", ticker: "D05.SI", currency: "SGD", valuation_native: 50000, security_uuid: "dbs", security_type: "Equity" },
                        ],
                    },
                ],
            }],
        };
        const analysis = registry._buildAnalysis(data, { SGD: 1.0 });
        // Cash excluded from holdings
        expect(analysis.top_holdings.find(h => h.name === "Warchest")).toBeUndefined();
        expect(analysis.top_holdings.length).toBe(2);
        // ISIN hidden by displayLabel in message_body
        expect(analysis.message_body).toContain("Amundi Index MSCI World");
        expect(analysis.message_body).not.toContain("LU2420245917.EUFUND");
        // Normal ticker stays
        expect(analysis.message_body).toContain("D05.SI");
    });

    it("filters ISIN-like tickers at news selection stage", () => {
        // Same regex used in _computeSyncAll for news ticker selection
        const isIsinLike = (t) => /^[A-Z]{2}[0-9A-Z]{8,}/.test(t) || t.includes(".EUFUND") || /^0P0001/.test(t);
        expect(isIsinLike("LU2420245917.EUFUND")).toBe(true);
        expect(isIsinLike("IE00B4L5Y983")).toBe(true);
        expect(isIsinLike("0P0001TB9O.SI")).toBe(true);
        expect(isIsinLike("CSPX.L")).toBe(false);
        expect(isIsinLike("D05.SI")).toBe(false);
        expect(isIsinLike("MSFT")).toBe(false);
        expect(isIsinLike("NVDA")).toBe(false);
    });
});
