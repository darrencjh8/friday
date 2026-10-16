/**
 * The #627 renderer contract must be enforced by a CI job that can actually
 * block a merge.
 *
 * dev-loop code review round 3, Medium: tests/onedrive-legs.test.js and its
 * siblings live in the `portfolio-tracker` job, which carries
 * `continue-on-error: true` because the FULL suite needs IBKR keys and live
 * services. deploy.yml gates on `needs.test.result != 'failure'`, and a
 * continue-on-error job reports success even when its steps fail, so every JS
 * test protecting formatSyncResult could be deleted or broken without blocking
 * a deploy. Only the hermes shell test was actually enforced.
 *
 * The fix is the separate `portfolio-tracker-unit` job: the renderer tests need
 * no secrets and no services, so they run in a job that is allowed to fail the
 * workflow. These assertions are what stop that job from silently regressing
 * back to non-gating.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(
    resolve(here, "../../../.github/workflows/test.yml"),
    "utf8",
);

// Minimal YAML job reader: enough to split the `jobs:` mapping and read each
// job's body plus the keys we care about. Avoids adding a YAML dependency for
// three assertions.
function jobs(src) {
    const out = {};
    const lines = src.split("\n");
    const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
    if (start < 0) return out;
    let name = null;
    for (const line of lines.slice(start + 1)) {
        const header = /^ {4}([A-Za-z0-9_-]+):\s*$/.exec(line);
        if (header) {
            name = header[1];
            out[name] = [];
            continue;
        }
        if (name) out[name].push(line);
    }
    return out;
}

const RENDERER_TESTS = [
    "tests/onedrive-legs.test.js",
    "tests/mcp-server.test.js",
    "tests/java_bridge.test.js",
    "tests/leg-coverage.test.js",
    "tests/shell-leg-coverage.test.js",
];

/**
 * A job "runs" a test only if a `- run:` step names it.
 *
 * Matching on a bare substring was wrong: a comment elsewhere in the file (the
 * continue-on-error line in the full suite job) mentions the same filename, so a
 * naive count credited a job that never executed it. That made the self-reference
 * guard unsatisfiable in the wrong direction — it passed with only one real job.
 */
function runsTest(body, name) {
    return body.some((l) => /^\s*-\s+run:/.test(l) && l.includes(name));
}

describe("CI enforces the #627 renderer contract", () => {
    it("has a job that runs the renderer tests", () => {
        const all = jobs(workflow);
        const runners = Object.entries(all).filter(([, body]) =>
            runsTest(body, "tests/onedrive-legs.test.js"),
        );
        expect(runners.length).toBeGreaterThan(0);
    });

    it("runs every renderer test file in that job", () => {
        const all = jobs(workflow);
        const [name, body] = Object.entries(all).find(([, b]) =>
            runsTest(b, "tests/onedrive-legs.test.js"),
        ) ?? ["", []];
        const runnable = body.join("\n");
        for (const t of RENDERER_TESTS) {
            expect(runnable, `${name} must run ${t}`).toContain(t);
        }
    });

    it("does not let that job fail silently via continue-on-error", () => {
        // This is the assertion that matters. deploy.yml gates on
        // needs.test.result != 'failure'; a continue-on-error job reports success
        // no matter what its steps do, so this line is the difference between
        // the renderer contract being enforced and being decorative.
        const all = jobs(workflow);
        const [, body] = Object.entries(all).find(([, b]) =>
            runsTest(b, "tests/onedrive-legs.test.js"),
        ) ?? ["", []];
        const nonGating = body.filter((l) => /continue-on-error:\s*true/.test(l));
        expect(nonGating).toEqual([]);
    });

    it("still keeps the full suite non-gating, since it needs services", () => {
        // Deliberate, not an oversight: the full job needs IBKR keys and live
        // services, so it stays continue-on-error. Only the secret-free subset is
        // promoted to gating. Pinned so a future "fix" does not make the whole
        // suite block merges it can never pass.
        const all = jobs(workflow);
        expect(all["portfolio-tracker"]?.join("\n")).toMatch(
            /continue-on-error:\s*true/,
        );
    });

    it("also runs this guard from a second job", () => {
        // Self-reference guard. This file's only job is to assert that CI runs the
        // renderer tests in a blocking position, so deleting that job's test
        // command would otherwise delete the only thing that notices. Running the
        // guard from a second job means the guard keeps reporting even when the
        // gating job stops naming it.
        const all = jobs(workflow);
        const runners = Object.entries(all).filter(([, body]) =>
            runsTest(body, "tests/ci-gating.test.js"),
        );
        expect(runners.length).toBeGreaterThanOrEqual(2);
    });

    it("does not let either renderer job be skipped by an if: condition", () => {
        // Review round 4, Medium 2 (M17/M21). Every assertion above reads text,
        // and a job carrying `if: false` keeps every line that text checks look
        // for while GitHub skips the job and reports success. needs.test.result
        // then stays green, so the deploy gate never blocks.
        //
        // A condition that only ever evaluates true is fine, so this pins the
        // defeating shape rather than banning `if:` outright.
        const all = jobs(workflow);
        for (const name of ["portfolio-tracker-unit", "portfolio-tracker-ci-guard"]) {
            const body = all[name] ?? [];
            const disabling = body.filter(
                (l) => /^\s*(-\s+)?if:\s*(false|""|'')\s*$/.test(l),
            );
            expect(disabling, `${name} must not be skippable`).toEqual([]);
        }
    });

    it("does not let the second guard job be softened either", () => {
        // M22: the job that exists to make the guard un-deletable could itself be
        // made non-blocking, one level down from the hole the second job closed.
        const all = jobs(workflow);
        expect(all["portfolio-tracker-ci-guard"]?.join("\n")).not.toMatch(
            /continue-on-error:\s*true/,
        );
    });

    it("pins the far end of the gate in deploy.yml", () => {
        // M18, and the one that actually removes a deploy block. The guard's own
        // comment claimed deploy.yml gates on `needs.test.result != 'failure'`,
        // but nothing read deploy.yml, so repointing that comparison to
        // 'cancelled' left every assertion here passing while a failed test run
        // stopped blocking a deploy. A comment is not a contract.
        const deploy = readFileSync(
            resolve(here, "../../../.github/workflows/deploy.yml"),
            "utf8",
        );
        expect(deploy).toMatch(/needs\.test\.result\s*!=\s*'failure'/);
    });
});
