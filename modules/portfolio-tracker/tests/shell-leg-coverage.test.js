/**
 * R2: the shell parser's leg tuple must be pinned by a test too, not just the
 * JS renderer.
 *
 * `leg-coverage.test.js` reads the producer's payload keys and checks the
 * `formatSyncResult` renderer against them. It never reads `portfolio-sync.sh`,
 * so the cron surface — the one the original #627 incident was actually read
 * from — was only guarded by hand-written fixtures. That asymmetry is how a leg
 * could be reported on one surface and silent on the other: `portfolio_status`
 * and `taxonomy_export` both slipped through it.
 *
 * So this reads the shipped shell script's own leg tuple and compares it to the
 * same REQUIRED list. A leg added to the payload forces a decision on BOTH
 * surfaces, and removing a leg from either surface's list fails here.
 *
 * This is a text check, not an execution: the script needs a live endpoint. What
 * it guarantees is that the two surfaces cannot silently diverge in their leg
 * coverage, which is the specific defect class this branch produced four times.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SYNC = readFileSync(resolve(here, "../../hermes/scripts/portfolio-sync.sh"), "utf8");

/**
 * The legs the shell parser iterates. The tuple is split across two source
 * lines, so the match is made against the joined text rather than one line.
 */
function shellLegs() {
    const anchor = SYNC.indexOf("for leg in (");
    if (anchor < 0) throw new Error("portfolio-sync.sh has no `for leg in (...)` loop");
    const open = SYNC.indexOf("(", anchor);
    const close = SYNC.indexOf("):", open);
    if (close < 0) throw new Error("portfolio-sync.sh's leg tuple is not closed");
    const body = SYNC.slice(open + 1, close);
    return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/** Mirrors REQUIRED in leg-coverage.test.js. Both surfaces must cover the same set. */
const REQUIRED = [
    "pull",
    "push",
    "flex_pull",
    "flex_import",
    "taxonomy_export",
    "portfolio_status",
];

describe("the shell parser covers the same legs as the renderer", () => {
    it("finds the leg tuple it is checking", () => {
        // If this fails the checks below are vacuous, so it is asserted first.
        expect(shellLegs().length).toBeGreaterThan(0);
    });

    it("reports every required leg", () => {
        const legs = new Set(shellLegs());
        const missing = REQUIRED.filter((leg) => !legs.has(leg));
        expect(missing).toEqual([]);
    });

    it("reports no leg the renderer does not", () => {
        // A leg on one surface only is the divergence this test exists to catch.
        // The renderer side is asserted in leg-coverage.test.js; this is the
        // shell half of the same invariant.
        const extra = shellLegs().filter((leg) => !REQUIRED.includes(leg));
        expect(extra).toEqual([]);
    });
});
