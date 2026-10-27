/**
 * Live-memory fetcher and parser.
 *
 * Pulls the expense-tracker memory (merchant -> payee -> category facts) from
 * the canonical `darrencjh8/friday-memory` GitHub repo at test time, so the
 * regression test always reflects the latest mappings.
 *
 * Fetch mechanism: `gh api` (authenticated via `gh` locally, or `GH_TOKEN` /
 * `GITHUB_TOKEN` in CI). No token is embedded in the code or logged.
 */
import { execFileSync } from "child_process";

const MEMORY_PATH =
    "repos/darrencjh8/friday-memory/contents/expense-tracker/MEMORY.md";

const PERSON_RULES_PATH =
    "repos/darrencjh8/friday-memory/contents/expense-tracker/person-rules.json";

const MERCHANT_RULES_PATH =
    "repos/darrencjh8/friday-memory/contents/expense-tracker/merchant-rules.json";

const WIKI_ACCOUNTS_PATH =
    "repos/darrencjh8/friday-memory/contents/wiki/entities/accounts";

const PASSWORD_FACT_RE = /^-\s+.*(?:password|DOB|legal name)\s*[:is]*\s*.+$/i;

/**
 * Fetch the raw MEMORY.md via the GitHub CLI. Throws if `gh` is unavailable,
 * unauthenticated, or the repo is unreachable.
 *
 * @returns {string} raw memory content
 */
export function fetchLiveMemory() {
    const output = execFileSync(
        "gh",
        [
            "api",
            "-H",
            "Accept: application/vnd.github.raw+json",
            MEMORY_PATH,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return output;
}

/**
 * Fetch the person-name golden rules (name -> approved payee/category) from the
 * private friday-memory repo. Person names are PII and must stay out of the
 * public friday repo, so they are fetched at test time like MEMORY.md.
 *
 * @returns {Array<{merchant: string, payee: string, category: string|null}>}
 */
export function fetchPersonRules() {
    const output = execFileSync(
        "gh",
        [
            "api",
            "-H",
            "Accept: application/vnd.github.raw+json",
            PERSON_RULES_PATH,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(output);
}

/**
 * Fetch the wiki accounts pages production reads its merchant, payee and
 * category facts from (`WikiKnowledgeStore`), as Hermes backs them up to the
 * private friday-memory repo. Throws if any page cannot be fetched, so a gate
 * built on them never runs against a partial wiki.
 *
 * @param {string[]} pages page file names under `wiki/entities/accounts/`
 * @returns {Record<string, string>} page name -> markdown
 */
export function fetchWikiPages(pages) {
    const out = {};
    for (const page of pages) {
        out[page] = execFileSync(
            "gh",
            [
                "api",
                "-H",
                "Accept: application/vnd.github.raw+json",
                `${WIKI_ACCOUNTS_PATH}/${page}`,
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
    }
    return out;
}

/**
 * Fetch the merchant golden rules (descriptor -> approved payee/category) from
 * the private friday-memory repo. The owner's own merchants show where they
 * live, work and shop, so they stay out of the public friday repo too.
 *
 * @returns {Array<{merchant: string, payee: string, category: string|null}>}
 */
export function fetchMerchantRules() {
    const output = execFileSync(
        "gh",
        [
            "api",
            "-H",
            "Accept: application/vnd.github.raw+json",
            MERCHANT_RULES_PATH,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(output);
}

/**
 * Redact password/identity facts so no secret ever reaches a log or report.
 *
 * @param {string} content
 * @returns {string}
 */
export function redactMemory(content) {
    return content
        .split("\n")
        .map((line) => (PASSWORD_FACT_RE.test(line) ? "- [REDACTED]" : line))
        .join("\n");
}

/**
 * Parse the memory into structured fact groups.
 *
 * @param {string} content - raw MEMORY.md content
 * @returns {{ merchantToPayee: Map<string, Set<string>>, entityToCategory: Map<string, Set<string>>, facts: string[] }}
 */
export function parseMemory(content) {
    const merchantToPayee = new Map();
    const entityToCategory = new Map();
    const facts = [];

    const PAYEE_RE = /^-\s+(.+?)\s+(?:merchant\s+)?maps\s+to\s+(.+?)\s+payee$/i;
    const CATEGORY_RE =
        /^-\s+(.+?)\s+maps\s+to\s+(.+?)\s+category(?:\s+\([^)]*\))?$/i;

    // Normalize "X merchant" / "X payee" / "X category" -> "X" so that the
    // same logical entity is detected as one key regardless of suffix.
    const normalizeEntity = (s) =>
        s.trim().replace(/\s+(?:merchant|payee|category)$/i, "").trim();

    for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (!line.startsWith("-")) continue;

        const payeeMatch = line.match(PAYEE_RE);
        if (payeeMatch) {
            const merchant = normalizeEntity(payeeMatch[1]);
            const payee = payeeMatch[2].trim();
            if (!merchantToPayee.has(merchant)) {
                merchantToPayee.set(merchant, new Set());
            }
            merchantToPayee.get(merchant).add(payee);
            facts.push(line);
            continue;
        }

        const catMatch = line.match(CATEGORY_RE);
        if (catMatch) {
            const entity = normalizeEntity(catMatch[1]);
            const category = catMatch[2].trim();
            if (!entityToCategory.has(entity)) {
                entityToCategory.set(entity, new Set());
            }
            entityToCategory.get(entity).add(category);
            facts.push(line);
        }
    }

    return { merchantToPayee, entityToCategory, facts };
}

/**
 * Find contradictions: a merchant mapped to more than one payee, or an entity
 * mapped to more than one category.
 *
 * @returns {{ merchantConflicts: Array<{merchant: string, payees: string[]}>, categoryConflicts: Array<{entity: string, categories: string[]}> }}
 */
export function findContradictions({ merchantToPayee, entityToCategory }) {
    const merchantConflicts = [];
    for (const [merchant, payees] of merchantToPayee) {
        if (payees.size > 1) {
            merchantConflicts.push({ merchant, payees: [...payees] });
        }
    }
    const categoryConflicts = [];
    for (const [entity, categories] of entityToCategory) {
        if (categories.size > 1) {
            categoryConflicts.push({ entity, categories: [...categories] });
        }
    }
    return { merchantConflicts, categoryConflicts };
}
