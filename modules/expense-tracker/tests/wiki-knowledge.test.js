/**
 * WikiKnowledgeStore — the expense-tracker reads its mappings from the wiki
 * (issue #783, Phase 1). The wiki pages are the single authority; this store
 * turns their tables back into the fact sentences the resolver already parses,
 * never writes them, and queues every write as a proposal instead.
 *
 * Fixtures are synthetic: no real merchant, person or account data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  utimesSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("@xenova/transformers", () => ({
  pipeline: vi.fn().mockRejectedValue(new Error("no model in tests")),
  env: {},
}));

import { WikiKnowledgeStore } from "../src/wiki-knowledge.js";
import { parseSuffixFact, accountAliases } from "../src/suffix-facts.js";

const FM = (title) =>
  `---\ntitle: ${title}\ncreated: 2026-10-11\nupdated: 2026-10-11\ntype: entity\ntags: [expense-tracker]\nsources: [raw/articles/x.md]\nconfidence: high\n---\n`;

const PAGES = {
  "merchant-payee-mappings.md": `${FM("Merchant to payee mappings")}
# Merchant to payee mappings

Intro text with a [[entities/accounts/payee-categories]] link.

## Routing rules

- **Gizmo:** plain \`Gizmo\` = Taxi payee. Owner-confirmed 2026-10-11.
- (L47) Zeta transport rides should be categorized under Zeta Card.

## Mappings

| Merchant key | Payee | Category override | Status | Source |
|---|---|---|---|---|
| \`Alpha Cafe\` | Food |  | confirmed | L10 |
| \`ClLEAN Odd\` | Food |  | confirmed | L11 |
| \`BETA MART\` | Groceries | Food | confirmed | L12 + L13 |
| \`Gamma Shop\` | Shopping |  | rejected | L14 |

## Not migrated

- something
`,
  "payee-categories.md": `${FM("Payee to category mappings")}
# Payee to category mappings

| Payee | Category | Status | Source |
|---|---|---|---|
| Food | Food | confirmed | L20 |
| Drinks | Food | confirmed | L21 |
| Odd Payee | Subscription | needs-verify | L22 |
`,
  "people-transfers.md": `${FM("People and transfers")}
# People and transfers

| Name in descriptor | Payee | Category | Note | Source | Incoming amount |
|---|---|---|---|---|---|
| PERSON ONE | Rent | Rent | rent | L30 |
| PERSON TWO | Misc |  | transfer | person-rules.json |
| PERSON THREE | Rent | Rent | rent, this amount only | owner | SGD 1,200.5 |
| PERSON FOUR | Rent | Rent | bad amount | owner | about 900 |
`,
  "card-suffix-mappings.md": `${FM("Card suffix mappings")}
# Card suffix mappings

| Card ending | Account | Evidence |
|---|---|---|
| 1111 | Zeta Card | user confirmed |

## Account-suffix facts

| Account ending | Account |
|---|---|
| 2222 | Omega Bank |
| 333333 | Omega Bank |
`,
  "banks-cards.md": `${FM("Banks and cards")}
# Banks and cards

## Cash + banks (on-budget)
| Account | Budget | ID | Balance |
|---|---|---|---|
| *Omega Bank* | SGD | 00000000-0000-0000-0000-000000000000 | S$1.00 |

## Account types and aliases (expense-tracker memory, migrated 2026-10-11)

| Name | Type | Status | Source |
|---|---|---|---|
| Zeta Card | credit card | confirmed | L40 |
| Omega Bank | bank account | confirmed | L41 |
| Kappa 90X | credit card (owner 2026-10-11; Actual lists it under banks) | confirmed | L42 |
| Main Account | Omega Bank account | confirmed | L43 |

### Statement password secrets (names only)

| Issuer / document | Bitwarden secret name |
|---|---|
| Zeta statement | STMT_PW_ZETA |
`,
};

function makeWiki(dir) {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(PAGES)) {
    writeFileSync(join(dir, name), body);
  }
}

describe("WikiKnowledgeStore", () => {
  let root;
  let wiki;
  let proposals;
  let legacy;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wiki-store-"));
    wiki = join(root, "accounts");
    proposals = join(root, "data", "wiki-proposals.jsonl");
    legacy = join(root, "data", "MEMORY.md");
    makeWiki(wiki);
    mkdirSync(join(root, "data"), { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const store = (extra = {}) =>
    new WikiKnowledgeStore({ wikiDir: wiki, proposalsPath: proposals, ...extra });

  it("turns every wiki table back into the fact sentences the resolver parses", () => {
    const facts = store().listFacts();

    expect(facts).toContain("Alpha Cafe maps to Food payee");
    expect(facts).toContain("ClLEAN Odd maps to Food payee");
    expect(facts).toContain("BETA MART maps to Groceries payee");
    expect(facts).toContain("BETA MART maps to Food category");
    expect(facts).toContain("Drinks maps to Food category");
    expect(facts).toContain("PERSON ONE maps to Rent payee");
    expect(facts).toContain("PERSON ONE maps to Rent category");
    expect(facts).toContain("PERSON TWO maps to Misc payee");
    // A row with an incoming amount is a rule for that amount only.
    expect(facts).toContain("Incoming SGD 1200.50 from PERSON THREE maps to Rent payee");
    expect(facts).toContain("Incoming SGD 1200.50 from PERSON THREE maps to Rent category");
    expect(facts).not.toContain("PERSON THREE maps to Rent payee");
    // An amount that does not parse adds nothing.
    expect(facts.some((f) => f.includes("PERSON FOUR"))).toBe(false);
    expect(facts).toContain("Card ending 1111 belongs to Zeta Card");
    expect(facts).toContain("Account ending 2222 belongs to Omega Bank");
    expect(facts).toContain("Account ending 333333 belongs to Omega Bank");
    expect(facts).toContain("Zeta Card is a credit card account");
    expect(facts).toContain("Omega Bank is a bank account");
    expect(facts).toContain("Kappa 90X is a credit card account");
    expect(facts).toContain("Main Account is an Omega Bank account");
    expect(facts).toContain(
      "Zeta transport rides should be categorized under Zeta Card.",
    );
    expect(facts.some((f) => f.includes("plain Gizmo = Taxi payee"))).toBe(true);
  });

  it("drops rejected rows and never surfaces secret names or balances", () => {
    const facts = store().listFacts();

    expect(facts.some((f) => f.startsWith("Gamma Shop"))).toBe(false);
    expect(facts.some((f) => /STMT_PW_|secret/i.test(f))).toBe(false);
    expect(facts.some((f) => f.includes("S$1.00"))).toBe(false);
  });

  it("keeps needs-verify rows active, as they were in memory", () => {
    expect(store().listFacts()).toContain("Odd Payee maps to Subscription category");
  });

  it("produces suffix and alias facts the existing parsers accept", () => {
    const facts = store().listFacts();

    expect(parseSuffixFact("Card ending 1111 belongs to Zeta Card")).toMatchObject({
      suffix: "1111",
      accountName: "Zeta Card",
    });
    const aliases = accountAliases(facts, [{ name: "Omega Bank" }]);
    expect(aliases.get("main account")).toBe("Omega Bank");
  });

  it("matches merchant keys exactly through search", async () => {
    const results = await store().search("Alpha Cafe");

    expect(results[0].text).toBe("Alpha Cafe maps to Food payee");
  });

  it("re-reads the wiki when a page changes, without a restart", async () => {
    const s = store();
    expect(await s.search("Delta Diner")).toEqual([]);

    const page = join(wiki, "merchant-payee-mappings.md");
    const body = readFileSync(page, "utf8").replace(
      "| `Gamma Shop` |",
      "| `Delta Diner` | Food |  | confirmed | telegram-remember |\n| `Gamma Shop` |",
    );
    writeFileSync(page, body);
    const later = new Date(Date.now() + 5000);
    utimesSync(page, later, later);

    const results = await s.search("Delta Diner");
    expect(results[0].text).toBe("Delta Diner maps to Food payee");
  });

  it("never writes the wiki: add, update and remove queue proposals", async () => {
    const before = Object.fromEntries(
      Object.keys(PAGES).map((n) => [n, readFileSync(join(wiki, n), "utf8")]),
    );
    const s = store();

    const added = await s.add("Epsilon Bar maps to Drinks payee");
    const updated = s.update("Alpha Cafe maps to Food payee", "Alpha Cafe maps to Drinks payee");
    const removed = s.remove("Alpha Cafe");

    expect(added).toMatchObject({ added: false, reason: "proposal_queued" });
    expect(updated).toMatchObject({ updated: false, reason: "proposal_queued" });
    expect(removed).toMatchObject({ deleted: false, reason: "proposal_queued" });
    for (const [n, body] of Object.entries(before)) {
      expect(readFileSync(join(wiki, n), "utf8")).toBe(body);
    }
    const queued = readFileSync(proposals, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(queued.map((q) => q.op)).toEqual(["add", "update", "remove"]);
    expect(queued[0]).toMatchObject({ fact: "Epsilon Bar maps to Drinks payee" });
    expect(typeof queued[0].at).toBe("string");
  });

  it("queues the same proposal only once, however often it is learned", async () => {
    const s = store();

    await s.add("Epsilon Bar is a bank account");
    await s.add("Epsilon Bar is a bank account");
    await s.add("epsilon bar is a bank account");

    const lines = readFileSync(proposals, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("does not queue a proposal the wiki already holds", async () => {
    const s = store();

    const added = await s.add("Alpha Cafe maps to Food payee");

    expect(added).toMatchObject({ added: false, reason: "duplicate" });
    expect(existsSync(proposals)).toBe(false);
  });

  it("refuses to queue a fact that looks like a credential", async () => {
    const added = await store().add("Zeta statement password is hunter2hunter2");

    expect(added).toMatchObject({ added: false, reason: "secret_refused" });
    expect(existsSync(proposals)).toBe(false);
  });

  it("compact and cleanup are no-ops on a read-only authority", async () => {
    const s = store();
    const n = s.listFacts().length;

    expect(s.compact()).toEqual({ before: n, after: n, removed: 0 });
    expect(await s.cleanup()).toMatchObject({ before: n, after: n, removed: 0 });
  });

  it("serves only password facts from the legacy file, until intake cutover", async () => {
    writeFileSync(
      legacy,
      "# Long-Term Memory\n\n## Facts\n\n- Zeta statement password is abc123\n- Stale Cafe maps to Food payee\n",
    );
    const s = store({ legacyPasswordPath: legacy });
    const facts = s.listFacts();

    expect(facts).toContain("Zeta statement password is abc123");
    expect(facts.some((f) => f.startsWith("Stale Cafe"))).toBe(false);
  });

  it("works with an empty or missing wiki directory instead of crashing", () => {
    const s = new WikiKnowledgeStore({
      wikiDir: join(root, "missing"),
      proposalsPath: proposals,
    });

    expect(s.listFacts()).toEqual([]);
  });
});
