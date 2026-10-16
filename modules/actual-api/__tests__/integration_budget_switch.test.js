/**
 * Integration test for budget switching in actual-api.
 *
 * Verifies that switching budgets via ensureBudget() actually changes
 * the active budget context in @actual-app/api, particularly the cache
 * path that skips downloadBudget() for previously-loaded budgets.
 *
 * Required env vars (set these or create gateway/.env):
 *   ACTUAL_BUDGET_SERVER_URL — Actual server URL
 *   ACTUAL_BUDGET_PASSWORD    — Server password
 *   ACTUAL_PRIMARY_BUDGET_FILE — SGD budget name
 *   ACTUAL_SECONDARY_BUDGET_FILE — MYR budget name (optional; MYR tests skipped)
 *     Read here only as a name string to pass to ensureBudget; the server no
 *     longer reads this variable itself.
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

// Load .env from modules/portfolio-tracker/ (same env_file as docker-compose)
const envPath = path.resolve(__dirname, "../../../portfolio-tracker/.env");
try {
    require("dotenv").config({ path: envPath });
} catch (_) {
    /* dotenv not available — rely on process.env */
}

// Manual .env parser fallback: handles # mid-value (which dotenv treats as comment)
function loadEnvFile(filePath) {
    try {
        const content = require("fs").readFileSync(filePath, "utf8");
        for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx === -1) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            let val = trimmed.slice(eqIdx + 1).trim();
            // Strip surrounding quotes
            if (
                (val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))
            ) {
                val = val.slice(1, -1);
            }
            // Always overwrite — dotenv may have truncated values containing #
            process.env[key] = val;
        }
    } catch (_) {
        /* file not readable */
    }
}
loadEnvFile(envPath);

// Mock express to prevent HTTP server startup (we only test init/ensureBudget)
// Mock express to prevent HTTP server startup (we only test init/ensureBudget)
jest.mock("express", () => {
    const app = {
        get: jest.fn(),
        post: jest.fn(),
        patch: jest.fn(),
        delete: jest.fn(),
        use: jest.fn(),
        listen: jest.fn((_port, _host, cb) => {
            if (cb) cb();
        }),
    };
    const expr = () => app;
    expr.json = jest.fn(() => "json-mw");
    return expr;
});

describe("Budget switch integration", () => {
    const SERVER_URL = process.env.ACTUAL_BUDGET_SERVER_URL;
    const PASSWORD = process.env.ACTUAL_BUDGET_PASSWORD;
    const SGD_BUDGET = process.env.ACTUAL_PRIMARY_BUDGET_FILE;
    const MYR_BUDGET = process.env.ACTUAL_SECONDARY_BUDGET_FILE;
    const hasMyr = !!(MYR_BUDGET && MYR_BUDGET.trim());
    const DATA_DIR = path.join(os.tmpdir(), `actual-integration-${Date.now()}`);

    beforeAll(() => {
        if (!SERVER_URL || !PASSWORD || !SGD_BUDGET) {
            const missing = [];
            if (!SERVER_URL) missing.push("ACTUAL_BUDGET_SERVER_URL");
            if (!PASSWORD) missing.push("ACTUAL_BUDGET_PASSWORD");
            if (!SGD_BUDGET) missing.push("ACTUAL_PRIMARY_BUDGET_FILE");
            throw new Error(
                `Missing required env vars: ${missing.join(", ")}. ` +
                    "Create modules/portfolio-tracker/.env or export them before running this test.",
            );
        }
    });

    afterAll(() => {
        try {
            fs.rmSync(DATA_DIR, { recursive: true, force: true });
        } catch (_) {
            /* cleanup is best-effort */
        }
    });

    test("init, switch, cache path, and round-trip", async () => {
        // Set env vars for the server module (loaded inside isolateModules)
        process.env.ACTUAL_BUDGET_SERVER_URL = SERVER_URL;
        process.env.ACTUAL_BUDGET_PASSWORD = PASSWORD;
        process.env.ACTUAL_PRIMARY_BUDGET_FILE = SGD_BUDGET;
        if (hasMyr) process.env.ACTUAL_SECONDARY_BUDGET_FILE = MYR_BUDGET;
        process.env.PORT = "0";
        process.env.BUDGET_SWITCH_DELAY_MS = "0";
        process.env.DATA_DIR = DATA_DIR;

        let init, ensureBudget, actual;

        // jest.isolateModules ensures a completely fresh module registry,
        // free from any @actual-app/api mock leakage from other test files.
        jest.isolateModules(() => {
            ({ init, ensureBudget } = require("../server"));
            actual = require("@actual-app/api");
        });

        try {
            // ── (a) Init and verify SGD budget ──
            await init();
            const sgdAccounts = await actual.getAccounts();
            expect(Array.isArray(sgdAccounts)).toBe(true);
            expect(sgdAccounts.length).toBeGreaterThan(0);
            const sgdNames = new Set(
                sgdAccounts.map((a) => a.name).filter(Boolean),
            );
            expect(sgdNames.size).toBeGreaterThan(0);

            if (!hasMyr) return; // remainder requires MYR budget

            // ── (b) Switch to MYR budget ──
            await ensureBudget(MYR_BUDGET);
            const myrAccounts = await actual.getAccounts();
            expect(Array.isArray(myrAccounts)).toBe(true);
            expect(myrAccounts.length).toBeGreaterThan(0);
            const myrNames = new Set(
                myrAccounts.map((a) => a.name).filter(Boolean),
            );
            expect(myrNames.size).toBeGreaterThan(0);

            // Budgets must have detectably different account sets
            const sgdOnly = [...sgdNames].filter((n) => !myrNames.has(n));
            const myrOnly = [...myrNames].filter((n) => !sgdNames.has(n));
            expect(sgdOnly.length + myrOnly.length).toBeGreaterThan(0);

            // ── (c) Switch back to SGD via cache path ──
            // CRITICAL: the cache path (budgetCache[syncId]===true) skips
            // downloadBudget(). We must confirm Actual API actually returns
            // SGD data, NOT stale MYR data.
            await ensureBudget(SGD_BUDGET);
            const sgdAgain = await actual.getAccounts();
            const sgdAgainNames = new Set(
                sgdAgain.map((a) => a.name).filter(Boolean),
            );
            expect([...sgdAgainNames].sort()).toEqual([...sgdNames].sort());
            // Ensure no MYR-only accounts leaked through
            for (const name of myrOnly) {
                expect(sgdAgainNames.has(name)).toBe(false);
            }

            // ── (d) Round-trip: MYR → SGD → MYR ──
            await ensureBudget(MYR_BUDGET);
            const myrAgain = await actual.getAccounts();
            const myrAgainNames = new Set(
                myrAgain.map((a) => a.name).filter(Boolean),
            );
            expect([...myrAgainNames].sort()).toEqual([...myrNames].sort());

            await ensureBudget(SGD_BUDGET);
            const sgdFinal = await actual.getAccounts();
            const sgdFinalNames = new Set(
                sgdFinal.map((a) => a.name).filter(Boolean),
            );
            expect([...sgdFinalNames].sort()).toEqual([...sgdNames].sort());
        } finally {
            try {
                await actual.shutdown();
            } catch (_) {
                /* shutdown is best-effort */
            }
        }
    }, 60000); // 60s timeout — real server connection may be slow
});
