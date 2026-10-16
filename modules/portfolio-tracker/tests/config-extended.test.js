/**
 * Extended Config tests — all 30+ fields, edge cases for taxonomy,
 * number parsing, password field, Google integration.
 * Complements existing config.test.js with additional coverage.
 */
import { describe, it, expect } from "vitest";
import { Config } from "../src/config.js";

const REQUIRED_ENV = {
  DEEPSEEK_API_KEY: "sk-test-key-12345",
  ACTUAL_BUDGET_URL: "https://ab.example.com/api",
  ACTUAL_BUDGET_PASSWORD: "super-secret-pw",
  ACTUAL_PRIMARY_BUDGET_FILE: "My SGD Budget",
  PP_XML_PATH: "/data/portfolio.xml",
  PP_JAR_PATH: "/app/pp-cli.jar",
  ONEDRIVE_CLIENT_ID: "test-client-id",
};

describe("Config — all 30+ fields", () => {
  it("loads ALL fields with explicit values", () => {
    const cfg = new Config({
      // Required
      DEEPSEEK_API_KEY: "sk-deepseek-123",
      ACTUAL_BUDGET_URL: "https://budget.example.com",
      ACTUAL_BUDGET_PASSWORD: "abc123",
      ACTUAL_PRIMARY_BUDGET_FILE: "Budget-SGD",
      PP_XML_PATH: "/mnt/data/pp/portfolio.xml",
      PP_JAR_PATH: "/opt/pp/pp-cli.jar",

      // Optional budget
      ACTUAL_SECONDARY_BUDGET_FILE: "Budget-MYR",

      // Google
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}',
      GOOGLE_SHEET_ID: "sheet-abc-123",

      // Taxonomy
      TAXONOMY_NAMES: "Sector,Region,Asset Class",
      TAXONOMY_SHEET_MAPPING: "Sector:C2,Region:D2,Asset Class:E2",

      // PP
      PP_PASSWORD: "pp-password-123",
      PP_EMERGENCY_PRIMARY_ACCOUNT: "uuid-es",
      PP_EMERGENCY_SECONDARY_ACCOUNT: "uuid-em",
      PP_WARCHEST_PRIMARY_ACCOUNT: "uuid-wc",

      // Data paths
      DEDUP_DB_PATH: "/data/custom/dedup.db",
      MAPPINGS_PATH: "/data/custom/mappings.json",

      // User
      USER_NAME: "Example",
      SYSTEM_PROMPT_EXTRA: "Extra instructions here",

      // IMAP
      IMAP_HOST: "imap.mail.com",
      IMAP_PORT: "995",
      IMAP_USERNAME: "user@example.com",
      IMAP_PASSWORD: "imap-secret",
      IMAP_FOLDER: "INBOX/Trades",

      // Gateway
      OPENCLAW_GATEWAY_URL: "https://gateway.internal:8443",
      NOTIFICATION_SMTP_HOST: "smtp.mail.com",
      NOTIFICATION_SMTP_PORT: "465",
      NOTIFICATION_EMAIL: "alerts@example.com",

      // OneDrive
      ONEDRIVE_REFRESH_TOKEN_PATH: "/secrets/od_token",
      ONEDRIVE_DATA_DIR: "/mnt/onedrive",
      ONEDRIVE_CLIENT_ID: "custom-client-id",
    });

    // Required
    expect(cfg.deepseekApiKey).toBe("sk-deepseek-123");
    expect(cfg.actualBudgetUrl).toBe("https://budget.example.com");
    expect(cfg.actualBudgetPassword).toBe("abc123");
    expect(cfg.primaryBudgetFile).toBe("Budget-SGD");
    expect(cfg.ppXmlPath).toBe("/mnt/data/pp/portfolio.xml");
    expect(cfg.ppJarPath).toBe("/opt/pp/pp-cli.jar");

    // Optional budget
    expect(cfg.secondaryBudgetFile).toBe("Budget-MYR");

    // Google
    expect(cfg.googleServiceAccountJson).toBe('{"type":"service_account"}');
    expect(cfg.googleSheetId).toBe("sheet-abc-123");

    // Taxonomy
    expect(cfg.taxonomyNames).toEqual(["Sector", "Region", "Asset Class"]);
    expect(cfg.taxonomySheetMapping).toEqual({
      Sector: "C2",
      Region: "D2",
      "Asset Class": "E2",
    });

    // PP
    expect(cfg.ppPassword).toBe("pp-password-123");
    expect(cfg.ppEmergencyPrimaryAccount).toBe("uuid-es");
    expect(cfg.ppEmergencySecondaryAccount).toBe("uuid-em");
    expect(cfg.ppWarchestPrimaryAccount).toBe("uuid-wc");

    // Data paths
    expect(cfg.dedupDbPath).toBe("/data/custom/dedup.db");
    expect(cfg.mappingsPath).toBe("/data/custom/mappings.json");

    // User
    expect(cfg.userName).toBe("Example");
    expect(cfg.systemPromptExtra).toBe("Extra instructions here");

    // IMAP
    expect(cfg.imapHost).toBe("imap.mail.com");
    expect(cfg.imapPort).toBe(995);
    expect(cfg.imapUsername).toBe("user@example.com");
    expect(cfg.imapPassword).toBe("imap-secret");
    expect(cfg.imapFolder).toBe("INBOX/Trades");

    // Gateway
    expect(cfg.openclawGatewayUrl).toBe("https://gateway.internal:8443");
    expect(cfg.notificationSmtpHost).toBe("smtp.mail.com");
    expect(cfg.notificationSmtpPort).toBe(465);
    expect(cfg.notificationEmail).toBe("alerts@example.com");

    // OneDrive
    expect(cfg.onedriveRefreshTokenPath).toBe("/secrets/od_token");
    expect(cfg.onedriveDataDir).toBe("/mnt/onedrive");
    expect(cfg.onedriveClientId).toBe("custom-client-id");
  });
});

describe("Config — taxonomy parsing edge cases", () => {
  it("parses single taxonomy name", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      TAXONOMY_NAMES: "Sector",
    });
    expect(cfg.taxonomyNames).toEqual(["Sector"]);
  });

  it("trims whitespace around taxonomy names", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      TAXONOMY_NAMES: " Sector ,  Geography ,Asset Class ",
    });
    expect(cfg.taxonomyNames).toEqual(["Sector", "Geography", "Asset Class"]);
  });

  it("handles duplicate taxonomy names (preserves order)", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      TAXONOMY_NAMES: "Sector,Sector,Geography",
    });
    expect(cfg.taxonomyNames).toEqual(["Sector", "Sector", "Geography"]);
  });

  it("handles taxonomy names with special characters", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      TAXONOMY_NAMES: "Sector & Industry,Region (Liquid),Asset Class: Tier 1",
    });
    expect(cfg.taxonomyNames).toContain("Sector & Industry");
    expect(cfg.taxonomyNames).toContain("Region (Liquid)");
  });

  it("handles many taxonomy names", () => {
    const names = Array.from({ length: 20 }, (_, i) => `Taxonomy${i}`);
    const cfg = new Config({
      ...REQUIRED_ENV,
      TAXONOMY_NAMES: names.join(","),
    });
    expect(cfg.taxonomyNames.length).toBe(20);
  });

  it("falls back to default taxonomy names when TAXONOMY_NAMES is undefined", () => {
    const env = { ...REQUIRED_ENV };
    delete env.TAXONOMY_NAMES;
    const cfg = new Config(env);
    expect(cfg.taxonomyNames).toEqual(["Sector", "Geography", "Asset Class"]);
  });
});

describe("Config — taxonomy sheet mapping edge cases", () => {
  it("handles mapping with colons in values", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      TAXONOMY_SHEET_MAPPING: "Sector:A1:B2,Region:C3",
    });
    // Only the first colon is used as separator
    expect(cfg.taxonomySheetMapping["Sector"]).toBe("A1:B2");
    expect(cfg.taxonomySheetMapping["Region"]).toBe("C3");
  });

  it("skips mapping entries without colon", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      TAXONOMY_SHEET_MAPPING: "NoColon,Valid:A1,AlsoNoColon",
    });
    expect(cfg.taxonomySheetMapping).toEqual({ Valid: "A1" });
  });

  it("skips mapping entries where key is empty before colon", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      TAXONOMY_SHEET_MAPPING: ":A1,Valid:B2",
    });
    // colonIdx > 0 check means empty key is skipped
    expect(cfg.taxonomySheetMapping).toEqual({ Valid: "B2" });
  });

  it("handles empty mapping string", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      TAXONOMY_SHEET_MAPPING: "",
    });
    expect(cfg.taxonomySheetMapping).toEqual({});
  });

  it("handles mapping string with only commas", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      TAXONOMY_SHEET_MAPPING: ",,,",
    });
    expect(cfg.taxonomySheetMapping).toEqual({});
  });
});

describe("Config — number parsing", () => {
  it("parses IMAP port as integer", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      IMAP_PORT: "993",
    });
    expect(cfg.imapPort).toBe(993);
    expect(typeof cfg.imapPort).toBe("number");
  });

  it("parses SMTP port as integer", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      NOTIFICATION_SMTP_PORT: "587",
    });
    expect(cfg.notificationSmtpPort).toBe(587);
    expect(typeof cfg.notificationSmtpPort).toBe("number");
  });

  it("handles NaN port gracefully (parseInt returns NaN)", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      IMAP_PORT: "not-a-number",
    });
    expect(cfg.imapPort).toBeNaN();
  });

  it("handles empty port as default (falsy empty string falls back)", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      IMAP_PORT: "",
    });
    // parseInt("" || "993", 10) = parseInt("993", 10) = 993
    expect(cfg.imapPort).toBe(993);
  });

  it("defaults IMAP port to 993 when undefined", () => {
    const env = { ...REQUIRED_ENV };
    delete env.IMAP_PORT;
    const cfg = new Config(env);
    expect(cfg.imapPort).toBe(993);
  });

  it("defaults SMTP port to 587 when undefined", () => {
    const env = { ...REQUIRED_ENV };
    delete env.NOTIFICATION_SMTP_PORT;
    const cfg = new Config(env);
    expect(cfg.notificationSmtpPort).toBe(587);
  });
});

describe("Config — PP password handling", () => {
  it("defaults ppPassword to empty string", () => {
    const cfg = new Config(REQUIRED_ENV);
    expect(cfg.ppPassword).toBe("");
  });

  it("loads ppPassword from env", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      PP_PASSWORD: "my-secret",
    });
    expect(cfg.ppPassword).toBe("my-secret");
  });
});

describe("Config — Google integration", () => {
  it("defaults Google fields to empty strings", () => {
    const cfg = new Config(REQUIRED_ENV);
    expect(cfg.googleServiceAccountJson).toBe("");
    expect(cfg.googleSheetId).toBe("");
  });

  it("loads Google service account JSON", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      GOOGLE_SERVICE_ACCOUNT_JSON:
        '{"type":"service_account","project_id":"test"}',
    });
    expect(cfg.googleServiceAccountJson).toContain("project_id");
  });
});

describe("Config — static fromEnv", () => {
  it("creates Config from process.env", () => {
    const originalEnv = { ...process.env };
    // Set required vars on process.env
    process.env.DEEPSEEK_API_KEY = "sk-process-test";
    process.env.ACTUAL_BUDGET_URL = "https://proc.example.com";
    process.env.ACTUAL_BUDGET_PASSWORD = "proc-pw";
    process.env.ACTUAL_PRIMARY_BUDGET_FILE = "proc-budget";
    process.env.PP_XML_PATH = "/proc/data.xml";
    process.env.PP_JAR_PATH = "/proc/pp.jar";
    process.env.ONEDRIVE_CLIENT_ID = "proc-client-id";

    try {
      const cfg = Config.fromEnv();
      expect(cfg.deepseekApiKey).toBe("sk-process-test");
      expect(cfg.actualBudgetUrl).toBe("https://proc.example.com");
    } finally {
      // Restore original env
      process.env = originalEnv;
    }
  });
});

describe("Config — user configuration", () => {
  it("defaults userName to 'there'", () => {
    const cfg = new Config(REQUIRED_ENV);
    expect(cfg.userName).toBe("there");
  });

  it("defaults systemPromptExtra to empty string", () => {
    const cfg = new Config(REQUIRED_ENV);
    expect(cfg.systemPromptExtra).toBe("");
  });

  it("loads system prompt extra from env", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      SYSTEM_PROMPT_EXTRA: "Be extra careful with large trades.",
    });
    expect(cfg.systemPromptExtra).toBe("Be extra careful with large trades.");
  });
});
