/**
 * Taxonomy export to Google Sheets: PP-CLI's "Without Classification" residual
 * (unassigned holdings) has no sheet cell and is not an error (#81).
 */
import { describe, it, expect, vi } from "vitest";
import { Config } from "../src/config.js";
import { ToolRegistry } from "../src/tools.js";
import { DedupJournal } from "../src/dedup.js";
import { MemoryStore } from "../src/memory.js";
import { tmpdir } from "os";
import { join } from "path";
import crypto from "crypto";

const REQUIRED_ENV = {
    DEEPSEEK_API_KEY: "sk-test",
    ACTUAL_BUDGET_URL: "http://test:5006",
    ACTUAL_BUDGET_PASSWORD: "pw",
    ACTUAL_PRIMARY_BUDGET_FILE: "test-budget",
    PP_XML_PATH: "/data/portfolio.xml",
    PP_JAR_PATH: "/app/pp-cli.jar",
    ONEDRIVE_CLIENT_ID: "test-client-id",
};

function registryWith(values) {
    const cfg = new Config(REQUIRED_ENV);
    cfg.googleSheetId = "sheet";
    cfg.googleServiceAccountJson = "{}";
    cfg.taxonomyNames = "Asset Class";
    cfg.taxonomySheetMapping = { Equity: "C2" };
    const dedup = new DedupJournal(join(tmpdir(), `test-taxexport-${crypto.randomUUID()}.db`));
    const registry = new ToolRegistry(cfg, new MemoryStore(":memory:"), dedup);
    registry.__ppBridge = {
        queryTaxonomies: vi.fn().mockResolvedValue({
            taxonomies: [{ name: "Asset Class", values }],
        }),
    };
    registry._fetchLiveRates = vi.fn().mockResolvedValue({});
    registry._updateSheet = vi.fn().mockResolvedValue({ ok: true });
    return registry;
}

// Building a ToolRegistry takes seconds on a loaded host; the default 5 s timeout flakes.
describe("ToolRegistry — _exportTaxonomiesToSheet", () => {
    it("skips the Without Classification residual instead of failing the export", async () => {
        const registry = registryWith([
            { value: "Equity", currency: "SGD", valuation_native: 100 },
            { value: "Without Classification", currency: "SGD", valuation_native: 5 },
        ]);

        const result = await registry._exportTaxonomiesToSheet();

        expect(result.status).toBe("completed");
        expect(result.errors ?? []).toEqual([]);
        expect(registry._updateSheet).toHaveBeenCalledTimes(1);
        expect(registry._updateSheet).toHaveBeenCalledWith("sheet", "C2", [[100]]);
    }, 30000);

    it("still reports a real classification with no cell", async () => {
        const registry = registryWith([
            { value: "Bonds", currency: "SGD", valuation_native: 7 },
        ]);

        const result = await registry._exportTaxonomiesToSheet();

        expect(result.status).toBe("partial");
        expect(JSON.stringify(result)).toContain("No cell mapping for 'Bonds'");
    }, 30000);
});
