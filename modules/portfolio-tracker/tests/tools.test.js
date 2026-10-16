/**
 * Portfolio Tracker smoke tests.
 * Ported from Python test suite.
 */
import { describe, it, expect } from "vitest";
import { Config } from "../src/config.js";
import { ToolRegistry } from "../src/tools.js";

const REQUIRED_ENV = {
    DEEPSEEK_API_KEY: "sk-test",
    ACTUAL_BUDGET_URL: "http://test:5006",
    ACTUAL_BUDGET_PASSWORD: "pw",
    ACTUAL_PRIMARY_BUDGET_FILE: "test-budget",
    PP_XML_PATH: "/data/portfolio.xml",
    PP_JAR_PATH: "/app/pp-cli.jar",
    ONEDRIVE_CLIENT_ID: "test-client-id",
};

describe("Portfolio Tracker", () => {
    describe("Config", () => {
        it("loads from env with defaults", () => {
            const cfg = new Config({
                ...REQUIRED_ENV,
                // Override specific fields for this test
                DEEPSEEK_API_KEY: "sk-test",
                ACTUAL_BUDGET_URL: "http://test:5006",
                ACTUAL_BUDGET_PASSWORD: "pw",
                ACTUAL_PRIMARY_BUDGET_FILE: "test-budget",
            });
            expect(cfg.deepseekApiKey).toBe("sk-test");
            expect(cfg.ppXmlPath).toBe("/data/portfolio.xml");
        });

        it("uses default values when env vars missing", () => {
            const cfg = new Config({
                ...REQUIRED_ENV,
            });
            expect(cfg.openclawGatewayUrl).toBe("http://openclaw:18800");
            expect(cfg.userName).toBe("there");
        });

        it("throws when required env vars are missing", () => {
            expect(() => new Config({})).toThrow(
                "Missing required environment variables",
            );
        });
    });

    describe("ToolRegistry", () => {
        it("returns tool schemas", () => {
            const cfg = new Config(REQUIRED_ENV);
            const registry = new ToolRegistry(cfg);
            const schemas = registry.getToolSchemas();
            expect(schemas.length).toBeGreaterThan(0);
            const names = schemas.map((s) => s.function.name);
            expect(names).toContain("pp-sync-all");
            expect(names).toContain("fetch_pp_accounts");
            expect(names.length).toBeGreaterThanOrEqual(20);
        });

        it("executes known tool", async () => {
            const cfg = new Config(REQUIRED_ENV);
            const registry = new ToolRegistry(cfg);
            const result = await registry.executeTool("log_decision", {
                action: "test",
                reasoning: "unit test",
            });
            expect(result).toEqual({ status: "logged" });
        });

        it("throws on unknown tool", async () => {
            const cfg = new Config(REQUIRED_ENV);
            const registry = new ToolRegistry(cfg);
            const result = await registry.executeTool("nonexistent", {});
            expect(result).toEqual({ error: "Unknown tool: nonexistent" });
        });
    });
});
