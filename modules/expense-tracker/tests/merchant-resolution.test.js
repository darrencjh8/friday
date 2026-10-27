/**
 * Merchant -> payee -> category resolution test against the live wiki, using
 * the PRODUCTION resolution path (the real `WikiKnowledgeStore.search` + the
 * exact regexes from `orchestrator._resolvePhase2` / `tools._validate_payee`).
 *
 * This is the "always up-to-date" accuracy gate: it fetches the wiki accounts
 * pages from `friday-memory` at test time (via `gh api`, like
 * live-memory.test.js) and verifies each fixture resolves to its approved
 * payee/category. When the wiki changes, the test re-verifies against the
 * latest mappings and fails on drift.
 *
 * Neither the owner's merchants nor person names are committed here: merchants
 * show where the owner lives, works and shops, and names are PII. Both are
 * fetched from the private friday-memory repo, as
 * `expense-tracker/merchant-rules.json` and `expense-tracker/person-rules.json`,
 * so every rule is verified against production without leaking either into
 * the public friday repo.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { WikiKnowledgeStore, WIKI_PAGES } from "../src/wiki-knowledge.js";
import { factNamesMerchant } from "../src/memory.js";
import {
    fetchWikiPages,
    fetchPersonRules,
    fetchMerchantRules,
} from "../src/fetch-memory.js";

let store = null;
let merchantRules = null;
let personRules = null;
let fetchError = null;
try {
    // Production reads these facts from the wiki accounts pages, not the
    // legacy MEMORY.md (#783), so the gate builds the same store from them.
    const dir = mkdtempSync(join(tmpdir(), "merchant-res-"));
    const wikiDir = join(dir, "accounts");
    mkdirSync(wikiDir);
    for (const [page, text] of Object.entries(fetchWikiPages(WIKI_PAGES))) {
        writeFileSync(join(wikiDir, page), text);
    }
    store = new WikiKnowledgeStore({
        wikiDir,
        proposalsPath: join(dir, "proposals.jsonl"),
    });
    try {
        merchantRules = fetchMerchantRules();
    } catch {
        merchantRules = null;
    }
    try {
        personRules = fetchPersonRules();
    } catch {
        personRules = null;
    }
} catch (e) {
    fetchError = e;
}

// ── Production-faithful resolution ─────────────────────────────
// Mirror `_resolvePhase2` Step 1 (payee) and Step 2 Tiers 1a and 1 (category) exactly:
//   search(query) -> first result matching /maps to (.+?) payee|category/i.

async function resolvePayee(merchant) {
    const results = await store.search(merchant, 5);
    for (const r of results) {
        // Production only takes a payee from a fact keyed on this merchant.
        if (!factNamesMerchant(r.text, merchant)) continue;
        const m = (r.text || "").match(/maps to (.+?) payee/i);
        if (m) return m[1];
    }
    return "Misc";
}

async function resolveCategory(payee, merchant) {
    // Tier 1a: a category fact keyed on the merchant itself (a wiki
    // "Category override" or a person's category) outranks the payee's. A
    // payee-categories row is keyed on a payee, so it is left to Tier 1.
    for (const r of await store.search(merchant, 5)) {
        if (r.payeeCategory) continue;
        if (!factNamesMerchant(r.text, merchant)) continue;
        const m = (r.text || "").match(/maps to (.+?) category/i);
        if (m) return m[1];
    }
    // Tier 1: search by payee; a fact naming the payee or the merchant may
    // supply the category. "X maps to Misc payee, no category" names X, not
    // Misc, so it must not supply Misc's category.
    for (const r of await store.search(payee, 5)) {
        if (![payee, merchant].some((k) => factNamesMerchant(r.text, k))) continue;
        const m = (r.text || "").match(/maps to (.+?) category/i);
        if (m) return m[1];
    }
    return null;
}

const run = fetchError ? describe.skip : describe;

run("merchant -> payee -> category (production wiki store)", () => {
    it("fetches merchant golden rules from friday-memory", () => {
        expect(merchantRules).not.toBeNull();
    });

    it("resolves every fixture merchant to its approved payee", async () => {
        const failures = [];
        for (const f of merchantRules || []) {
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
        for (const f of merchantRules || []) {
            const resolved = await resolveCategory(f.payee, f.merchant);
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

run("person-name rule (production wiki store)", () => {
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
            const resolved = await resolveCategory(f.payee, f.merchant);
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
