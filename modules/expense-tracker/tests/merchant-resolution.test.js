/**
 * Merchant -> payee -> category resolution test against the live memory, using
 * the PRODUCTION resolution path (the real `MemoryStore.search` + the exact
 * regexes from `orchestrator._resolvePhase2` / `tools._validate_payee`).
 *
 * This is the "always up-to-date" accuracy gate: it fetches `friday-memory` at
 * test time (via `gh api`, like live-memory.test.js) and verifies each fixture
 * resolves to its approved payee/category. When the memory changes, the test
 * re-verifies against the latest mappings and fails on drift.
 *
 * Business merchants live in committed fixtures (non-PII). Person names are PII
 * and are NOT committed here; they are fetched from the private friday-memory
 * repo as `expense-tracker/person-rules.json`, so the "person name -> transfer
 * -> Misc (no category)" rule is also verified against production without
 * leaking identities into the public friday repo.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { MemoryStore } from "../src/memory.js";
import {
    fetchLiveMemory,
    redactMemory,
    fetchPersonRules,
} from "../src/fetch-memory.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const merchantFixtures = JSON.parse(
    readFileSync(join(__dirname, "fixtures", "merchant-mappings.json"), "utf8"),
);

let store = null;
let personRules = null;
let fetchError = null;
try {
    const raw = redactMemory(fetchLiveMemory());
    const memPath = join(
        tmpdir(),
        `merchant-res-${randomBytes(6).toString("hex")}.md`,
    );
    writeFileSync(memPath, raw);
    store = new MemoryStore(memPath);
    try {
        personRules = fetchPersonRules();
    } catch {
        personRules = null;
    }
} catch (e) {
    fetchError = e;
}

// ── Production-faithful resolution ─────────────────────────────
// Mirror `_resolvePhase2` Step 1 (payee) and Step 2 Tier 1 (category) exactly:
//   search(query) -> first result matching /maps to (.+?) payee|category/i.

async function resolvePayee(merchant) {
    const results = await store.search(merchant, 5);
    for (const r of results) {
        const m = (r.text || "").match(/maps to (.+?) payee/i);
        if (m) return m[1];
    }
    return "Misc";
}

async function resolveCategory(payee) {
    const results = await store.search(payee, 5);
    for (const r of results) {
        const m = (r.text || "").match(/maps to (.+?) category/i);
        if (m) return m[1];
    }
    return null;
}

const run = fetchError ? describe.skip : describe;

run("merchant -> payee -> category (production MemoryStore)", () => {
    it("resolves every fixture merchant to its approved payee", async () => {
        const failures = [];
        for (const f of merchantFixtures) {
            const resolved = await resolvePayee(f.merchant);
            if (resolved !== f.payee) {
                failures.push(
                    `${f.merchant}: expected ${f.payee}, got ${resolved}`,
                );
            }
        }
        expect(failures).toEqual([]);
    });

    it("resolves every fixture merchant to its approved category", async () => {
        const failures = [];
        for (const f of merchantFixtures) {
            const resolved = await resolveCategory(f.payee);
            if (f.category === null) {
                if (resolved !== null) {
                    failures.push(
                        `${f.merchant} (${f.payee}): expected no category, got ${resolved}`,
                    );
                }
            } else if (resolved !== f.category) {
                failures.push(
                    `${f.merchant} (${f.payee}): expected ${f.category}, got ${resolved}`,
                );
            }
        }
        expect(failures).toEqual([]);
    });
});

run("person-name rule (production MemoryStore)", () => {
    it("fetches person-name golden rules from friday-memory", () => {
        expect(personRules).not.toBeNull();
    });

    it("resolves every person name to its approved payee", async () => {
        const failures = [];
        for (const f of personRules || []) {
            const resolved = await resolvePayee(f.merchant);
            if (resolved !== f.payee) {
                failures.push(
                    `${f.merchant}: expected ${f.payee}, got ${resolved}`,
                );
            }
        }
        expect(failures).toEqual([]);
    });

    it("resolves every person name to its approved category", async () => {
        const failures = [];
        for (const f of personRules || []) {
            const resolved = await resolveCategory(f.payee);
            if (f.category === null) {
                if (resolved !== null) {
                    failures.push(
                        `${f.merchant} (${f.payee}): expected no category, got ${resolved}`,
                    );
                }
            } else if (resolved !== f.category) {
                failures.push(
                    `${f.merchant} (${f.payee}): expected ${f.category}, got ${resolved}`,
                );
            }
        }
        expect(failures).toEqual([]);
    });
});
