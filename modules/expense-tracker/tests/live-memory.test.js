/**
 * Live-memory consistency test.
 *
 * Fetches the expense-tracker memory (merchant -> payee -> category) from
 * `darrencjh8/friday-memory` at test time via `gh api`, so the test always
 * reflects the latest mappings. It detects contradictions (a merchant mapped
 * to multiple payees, or an entity mapped to multiple categories) and fails,
 * acting as a "memory accuracy gate".
 *
 * If `gh` is unavailable or unauthenticated (e.g. local without gh), the whole
 * suite is skipped rather than failing spuriously. In CI, set GH_TOKEN to a
 * PAT with `repo` scope for the friday-memory repository.
 */
import { describe, it, expect } from "vitest";
import {
    fetchLiveMemory,
    redactMemory,
    parseMemory,
    findContradictions,
} from "../src/fetch-memory.js";

let parsed = null;
let fetchError = null;
try {
    parsed = parseMemory(redactMemory(fetchLiveMemory()));
} catch (e) {
    fetchError = e;
}

const run = fetchError ? describe.skip : describe;

run("live memory (friday-memory) consistency", () => {
    it("fetches and parses the live memory", () => {
        expect(parsed.facts.length).toBeGreaterThan(0);
    });

    it("has no merchant mapped to multiple payees", () => {
        const { merchantConflicts } = findContradictions(parsed);
        if (merchantConflicts.length) {
            throw new Error(
                "merchant -> payee contradictions:\n" +
                    merchantConflicts
                        .map((c) => `  ${c.merchant} -> [${c.payees.join(", ")}]`)
                        .join("\n"),
            );
        }
    });

    it("has no entity mapped to multiple categories", () => {
        const { categoryConflicts } = findContradictions(parsed);
        if (categoryConflicts.length) {
            throw new Error(
                "entity -> category contradictions:\n" +
                    categoryConflicts
                        .map(
                            (c) =>
                                `  ${c.entity} -> [${c.categories.join(", ")}]`,
                        )
                        .join("\n"),
            );
        }
    });

    it("contains no unredacted password facts", () => {
        const leaked = parsed.facts.filter((f) => /password/i.test(f));
        expect(leaked).toEqual([]);
    });
});
