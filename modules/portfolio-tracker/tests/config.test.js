/**
 * Config tests — all config fields, defaults, env loading.
 * Ported from tests/test_config.py
 */
import { describe, it, expect } from "vitest";
import { Config } from "../src/config.js";

const REQUIRED_ENV = {
    DEEPSEEK_API_KEY: "sk-test",
    ACTUAL_BUDGET_URL: "https://ab.example.com",
    ACTUAL_BUDGET_PASSWORD: "pw",
    ACTUAL_PRIMARY_BUDGET_FILE: "Test-SGD-Budget",
    PP_XML_PATH: "/data/portfolio.xml",
    PP_JAR_PATH: "/app/pp-cli.jar",
    ONEDRIVE_CLIENT_ID: "test-client-id",
};

describe("Config — required fields", () => {
    it("loads all core fields from env", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.deepseekApiKey).toBe("sk-test");
        expect(cfg.actualBudgetUrl).toBe("https://ab.example.com");
        expect(cfg.actualBudgetPassword).toBe("pw");
        expect(cfg.primaryBudgetFile).toBe("Test-SGD-Budget");
    });

    it("throws when required env vars are missing", () => {
        expect(() => new Config({})).toThrow(
            "Missing required environment variables",
        );
    });

    it("throws with specific missing field names", () => {
        expect(() => new Config({ DEEPSEEK_API_KEY: "sk" })).toThrow(
            "ACTUAL_BUDGET_URL",
        );
    });
});

describe("Config — defaults", () => {
    it("uses default dedupDbPath when not provided", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.dedupDbPath).toBe("data/dedup.db");
    });

    it("uses default openclawGatewayUrl", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.openclawGatewayUrl).toBe("http://openclaw:18800");
    });

    it("uses default userName", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.userName).toBe("there");
    });

    it("uses default imapFolder", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.imapFolder).toBe("Trades");
    });

    it("parses taxonomy names from env", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            TAXONOMY_NAMES: "Sector,Geography,Asset Class",
        });
        expect(cfg.taxonomyNames).toEqual([
            "Sector",
            "Geography",
            "Asset Class",
        ]);
    });

    it("falls back to default taxonomy names when empty string", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            TAXONOMY_NAMES: "",
        });
        // Empty string is falsy, falls back to default
        expect(cfg.taxonomyNames).toEqual([
            "Sector",
            "Geography",
            "Asset Class",
        ]);
    });

    it("handles whitespace-only taxonomy names as empty", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            TAXONOMY_NAMES: ", ,",
        });
        // filter(Boolean) removes empty strings after split
        expect(cfg.taxonomyNames.length).toBe(0);
    });
});

describe("Config — custom values", () => {
    it("loads custom ppXmlPath", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            PP_XML_PATH: "/custom/path.xml",
        });
        expect(cfg.ppXmlPath).toBe("/custom/path.xml");
    });

    it("loads custom openclawGatewayUrl", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            OPENCLAW_GATEWAY_URL: "http://gateway:9999",
        });
        expect(cfg.openclawGatewayUrl).toBe("http://gateway:9999");
    });

    it("loads custom imapFolder", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            IMAP_FOLDER: "CustomInbox",
        });
        expect(cfg.imapFolder).toBe("CustomInbox");
    });

    it("loads secondaryBudgetFile when provided", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            ACTUAL_SECONDARY_BUDGET_FILE: "Test-MYR",
        });
        expect(cfg.secondaryBudgetFile).toBe("Test-MYR");
    });

    it("defaults secondaryBudgetFile to empty string", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.secondaryBudgetFile).toBe("");
    });
});

describe("Config — taxonomy and mappings", () => {
    it("parses taxonomy sheet mapping from env", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            TAXONOMY_SHEET_MAPPING: "Sector:A1,Geography:B2",
        });
        expect(cfg.taxonomySheetMapping).toEqual({
            Sector: "A1",
            Geography: "B2",
        });
    });

    it("handles empty taxonomy sheet mapping", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.taxonomySheetMapping).toEqual({});
    });

    it("skips invalid taxonomy sheet mapping entries", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            TAXONOMY_SHEET_MAPPING: "InvalidEntry,Valid: X99",
        });
        expect(cfg.taxonomySheetMapping).toEqual({ Valid: "X99" });
    });
});

describe("Config — PP fields", () => {
    it("loads PP account UUIDs", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            PP_EMERGENCY_PRIMARY_ACCOUNT: "uuid-sgd",
            PP_EMERGENCY_SECONDARY_ACCOUNT: "uuid-myr",
            PP_WARCHEST_PRIMARY_ACCOUNT: "uuid-warchest",
        });
        expect(cfg.ppEmergencyPrimaryAccount).toBe("uuid-sgd");
        expect(cfg.ppEmergencySecondaryAccount).toBe("uuid-myr");
        expect(cfg.ppWarchestPrimaryAccount).toBe("uuid-warchest");
    });

    it("defaults PP account UUIDs to empty string", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.ppEmergencyPrimaryAccount).toBe("");
        expect(cfg.ppEmergencySecondaryAccount).toBe("");
        expect(cfg.ppWarchestPrimaryAccount).toBe("");
    });
});

describe("Config — IMAP and notification", () => {
    it("loads IMAP configuration", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            IMAP_HOST: "imap.example.com",
            IMAP_PORT: "993",
            IMAP_USERNAME: "user@test.com",
            IMAP_PASSWORD: "secret",
        });
        expect(cfg.imapHost).toBe("imap.example.com");
        expect(cfg.imapPort).toBe(993);
        expect(cfg.imapUsername).toBe("user@test.com");
        expect(cfg.imapPassword).toBe("secret");
    });

    it("defaults IMAP port to 993", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            IMAP_PORT: undefined,
        });
        expect(cfg.imapPort).toBe(993);
    });

    it("loads SMTP notification config", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            NOTIFICATION_SMTP_HOST: "smtp.example.com",
            NOTIFICATION_SMTP_PORT: "587",
            NOTIFICATION_EMAIL: "notify@test.com",
        });
        expect(cfg.notificationSmtpHost).toBe("smtp.example.com");
        expect(cfg.notificationSmtpPort).toBe(587);
        expect(cfg.notificationEmail).toBe("notify@test.com");
    });
});

describe("Config — OneDrive", () => {
    it("loads OneDrive configuration with defaults", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.onedriveRefreshTokenPath).toBe(
            "/app/config/onedrive/refresh_token",
        );
        expect(cfg.onedriveDataDir).toBe("/data/onedrive");
        expect(cfg.onedriveClientId).toBe("test-client-id");
    });
});

describe("Config — data paths", () => {
    it("uses default dedup and mappings paths", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.dedupDbPath).toBe("data/dedup.db");
        expect(cfg.mappingsPath).toBe("data/mappings.json");
    });

    it("defaults portfolioMemoryPath to data/MEMORY.md", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.portfolioMemoryPath).toBe("data/MEMORY.md");
    });

    it("honors PORTFOLIO_MEMORY_PATH override", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            PORTFOLIO_MEMORY_PATH: "/data/custom/MEMORY.md",
        });
        expect(cfg.portfolioMemoryPath).toBe("/data/custom/MEMORY.md");
    });
});

describe("Config — IBKR Flex Web Service", () => {
    it("loads flex token and query ID from env", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            IBKR_FLEX_TOKEN: "test-token-12345",
            IBKR_FLEX_QUERY_ID: "1319918",
        });
        expect(cfg.ibkrFlexToken).toBe("test-token-12345");
        expect(cfg.ibkrFlexQueryId).toBe("1319918");
    });

    it("defaults flex token and query ID to empty string", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.ibkrFlexToken).toBe("");
        expect(cfg.ibkrFlexQueryId).toBe("");
    });
});
