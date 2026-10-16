/**
 * Tests that missing required env vars cause startup failure.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// Block .env file loading so fromEnv() only sees process.env
vi.mock("fs", () => ({
    readFileSync: vi.fn(() => {
        throw new Error("ENOENT");
    }),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
}));

// Save and restore original env
const originalEnv = { ...process.env };

function clearRequiredVars() {
    const required = [
        "DEEPSEEK_API_KEY",
        "LLM_PROVIDER",
        "LLM_BASE_URL",
        "LLM_MODEL",
        "LLM_API_KEY",
        "LLM_REASONING_EFFORT",
        "ACTUAL_BUDGET_URL",
        "ACTUAL_BUDGET_PASSWORD",
        "ACTUAL_PRIMARY_CURRENCY",
        "ACTUAL_SECONDARY_CURRENCY",
        "ACTUAL_PRIMARY_BUDGET_FILE",
        "ACTUAL_SECONDARY_BUDGET_FILE",
        "IMAP_HOST",
        "IMAP_USERNAME",
        "IMAP_PASSWORD",
        "NOTIFY_URL",
        "HERMES_WEBHOOK_SECRET",
    ];
    for (const k of required) {
        delete process.env[k];
    }
}

function setMinimumEnv() {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    process.env.ACTUAL_BUDGET_URL = "http://localhost:3000";
    process.env.ACTUAL_BUDGET_PASSWORD = "pw";
    process.env.ACTUAL_PRIMARY_CURRENCY = "SGD";
    process.env.ACTUAL_SECONDARY_CURRENCY = "MYR";
    process.env.ACTUAL_PRIMARY_BUDGET_FILE = "My Budget";
    process.env.ACTUAL_SECONDARY_BUDGET_FILE = "My MYR Budget";
    process.env.IMAP_HOST = "imap.test.com";
    process.env.IMAP_USERNAME = "u";
    process.env.IMAP_PASSWORD = "p";
    process.env.NOTIFY_URL = "http://webhook";
    process.env.HERMES_WEBHOOK_SECRET = "secret";
}

describe("Config.fromEnv — required env var validation", () => {
    beforeEach(() => {
        clearRequiredVars();
    });

    afterEach(() => {
        // Restore original env
        for (const k of Object.keys(originalEnv)) {
            process.env[k] = originalEnv[k];
        }
    });

    test("throws when DEEPSEEK_API_KEY is missing", async () => {
        setMinimumEnv();
        delete process.env.DEEPSEEK_API_KEY;
        const { Config } = await import("../src/config.js");
        expect(() => Config.fromEnv()).toThrow(/DEEPSEEK_API_KEY/);
    });

    test("throws when ACTUAL_BUDGET_URL is missing", async () => {
        setMinimumEnv();
        delete process.env.ACTUAL_BUDGET_URL;
        const { Config } = await import("../src/config.js");
        expect(() => Config.fromEnv()).toThrow(/ACTUAL_BUDGET_URL/);
    });

    test("throws when ACTUAL_BUDGET_PASSWORD is missing", async () => {
        setMinimumEnv();
        delete process.env.ACTUAL_BUDGET_PASSWORD;
        const { Config } = await import("../src/config.js");
        expect(() => Config.fromEnv()).toThrow(/ACTUAL_BUDGET_PASSWORD/);
    });

    test("throws when ACTUAL_PRIMARY_BUDGET_FILE is missing", async () => {
        setMinimumEnv();
        delete process.env.ACTUAL_PRIMARY_BUDGET_FILE;
        const { Config } = await import("../src/config.js");
        expect(() => Config.fromEnv()).toThrow(/ACTUAL_PRIMARY_BUDGET_FILE/);
    });

    test("throws when ACTUAL_SECONDARY_BUDGET_FILE is missing", async () => {
        setMinimumEnv();
        delete process.env.ACTUAL_SECONDARY_BUDGET_FILE;
        const { Config } = await import("../src/config.js");
        expect(() => Config.fromEnv()).toThrow(/ACTUAL_SECONDARY_BUDGET_FILE/);
    });

    test("throws when IMAP_HOST is missing", async () => {
        setMinimumEnv();
        delete process.env.IMAP_HOST;
        const { Config } = await import("../src/config.js");
        expect(() => Config.fromEnv()).toThrow(/IMAP_HOST/);
    });

    test("throws when IMAP_USERNAME is missing", async () => {
        setMinimumEnv();
        delete process.env.IMAP_USERNAME;
        const { Config } = await import("../src/config.js");
        expect(() => Config.fromEnv()).toThrow(/IMAP_USERNAME/);
    });

    test("throws when IMAP_PASSWORD is missing", async () => {
        setMinimumEnv();
        delete process.env.IMAP_PASSWORD;
        const { Config } = await import("../src/config.js");
        expect(() => Config.fromEnv()).toThrow(/IMAP_PASSWORD/);
    });

    test("throws when NOTIFY_URL is missing", async () => {
        setMinimumEnv();
        delete process.env.NOTIFY_URL;
        const { Config } = await import("../src/config.js");
        expect(() => Config.fromEnv()).toThrow(/NOTIFY_URL/);
    });

    test("throws when HERMES_WEBHOOK_SECRET is missing", async () => {
        setMinimumEnv();
        delete process.env.HERMES_WEBHOOK_SECRET;
        const { Config } = await import("../src/config.js");
        expect(() => Config.fromEnv()).toThrow(/HERMES_WEBHOOK_SECRET/);
    });

    test("throws with multiple missing vars listed", async () => {
        // Don't set any — all missing
        const { Config } = await import("../src/config.js");
        expect(() => Config.fromEnv()).toThrow(
            /Missing required environment variables/,
        );
    });

    test("succeeds when all required vars are set", async () => {
        setMinimumEnv();
        const { Config } = await import("../src/config.js");
        expect(() => Config.fromEnv()).not.toThrow();
    });

    test("constructor sets required fields from env (no fallback to empty)", async () => {
        setMinimumEnv();
        const { Config } = await import("../src/config.js");
        // fromEnv() calls new Config() which reads process.env
        const cfg = new Config();
        expect(cfg.deepseekApiKey).toBe("sk-test");
        expect(cfg.actualBudgetUrl).toBe("http://localhost:3000");
        expect(cfg.notifyUrl).toBe("http://webhook");
        expect(cfg.notifySecret).toBe("secret");
    });

    test("optional vars have defaults", async () => {
        setMinimumEnv();
        const { Config } = await import("../src/config.js");
        const cfg = new Config();
        expect(cfg.primaryCurrency).toBe("SGD");
        expect(cfg.secondaryCurrency).toBe("MYR");
        expect(cfg.imapPort).toBe(993);
        expect(cfg.imapMailbox).toBe("INBOX");
        expect(cfg.userName).toBe("there");
        expect(cfg.dedupDbPath).toBe("data/dedup.db");
    });
});
