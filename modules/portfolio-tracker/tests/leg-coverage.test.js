/**
 * The renderer must cover every remote leg the payload actually carries.
 *
 * This is the systematic fix for the pattern behind every Medium found in
 * dev-loop code review rounds 1-4 of #627. The fix each round enumerated the
 * legs it had been told about; five rounds in, the fifth leg (taxonomy_export)
 * was still unreported. Each enumeration was a hand-written list, so nothing
 * compared it against the payload the producer builds.
 *
 * So this test reads the producer's own return keys and fails when a leg it
 * declares goes unreported. It is intentionally a text check on `_computeSyncAll`
 * rather than an execution of it: the full sync needs IBKR keys, a live Google
 * Sheet and a real portfolio, none of which exist in CI. What it does guarantee
 * is that adding a new remote leg to the payload forces a decision here.
 *
 * The non-legs (taxonomy_data, portfolio_status, analysis, fx_rates_used,
 * summary, sync_targets) are local data or already surfaced, and are listed
 * explicitly so that adding one is also a deliberate act.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSyncResult } from "../src/mcp-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const TOOLS = readFileSync(resolve(here, "../src/tools.js"), "utf8");

/** The keys `_computeSyncAll` returns, read out of its own source. */
function payloadKeys() {
    const start = TOOLS.indexOf("return {\n            sync_targets: results,");
    if (start < 0) throw new Error("_computeSyncAll's payload literal was not found in tools.js");
    const body = TOOLS.slice(start);
    const end = body.indexOf("\n        };");
    if (end < 0) throw new Error("_computeSyncAll's payload literal has no closing brace");
    return [...body.slice(0, end).matchAll(/^\s{12}([a-z_]+):/gm)].map((m) => m[1]);
}

/** Keys that are local data or already reported, so not "legs" to check. */
const NOT_LEGS = new Set([
    "sync_targets", // per-account AB rows, already rendered as ⚠️ lines
    "summary", // the "Synced 3/3 accounts" header
    "taxonomy_data", // local cache, only used to build the analysis body
    "analysis", // the authoritative display itself
    "fx_rates_used", // inputs to the analysis body
]);

/** Every leg the renderer and the shell parser must mention by name. */
const REQUIRED = ["pull", "push", "flex_pull", "flex_import", "taxonomy_export", "portfolio_status"];

describe("the renderer covers every remote leg the payload carries", () => {
    it("finds the payload literal it is checking", () => {
        // If this fails the checks below are vacuous, so it is asserted first.
        expect(payloadKeys().length).toBeGreaterThan(0);
    });

    it("declares every remote leg in the payload as a required leg", () => {
        const keys = payloadKeys();
        const undeclared = keys.filter((k) => !NOT_LEGS.has(k) && !REQUIRED.includes(k));
        expect(undeclared).toEqual([]);
    });

    it("requires no leg that the payload does not carry", () => {
        // The reverse check: a leg the renderer reads but the producer never
        // returns is dead code, and dead code is how the first round of this
        // branch got its Mediums.
        const keys = new Set(payloadKeys());
        const phantom = REQUIRED.filter((k) => !keys.has(k));
        expect(phantom).toEqual([]);
    });

    it("reports a failing leg on every surface, not just one", () => {
        // Each required leg must have a failure shape that the renderer turns
        // into a visible line. A leg that only ever succeeds is not a leg the
        // operator needs reported, but a leg that can fail silently is #627.
        const failing = {
            pull: { status: "error", detail: "Token HTTP 400" },
            push: { status: "error", detail: "Token HTTP 400" },
            flex_pull: { success: false, error: "IBKR Flex error 1012" },
            flex_import: { status: "ok", trades_imported: 0, items_skipped: 4, errors: [] },
            taxonomy_export: { status: "error", detail: "Google Sheets API: 401" },
            // This leg has no `status` at all: tools.js:1025 stores a failed
            // status fetch as {error}. A generic status:"error" shape here would
            // not match what the producer emits, so the test would prove nothing.
            portfolio_status: { error: "Portfolio.app unreachable" },
        };
        for (const leg of REQUIRED) {
            const out = formatSyncResult({
                summary: "Synced 1/1 accounts",
                [leg]: failing[leg],
                analysis: { message_body: "BODY" },
            });
            expect(out, `${leg} must not render byte-identical to a healthy run`).not.toBe(
                "BODY",
            );
        }
    });
});
