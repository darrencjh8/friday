/**
 * Issue #331 — tolerant suffix facts and word-based account resolution.
 *
 * These tests encode the end state: a fact may be written in ordinary words
 * and must still arm the card-suffix safety net.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalSuffixFact,
  matchAccountByName,
  parseSuffixFact,
  stopwords,
} from "../src/memory.js";
// memory.js does not re-export this one, and the plural filler retry lives on it.
import { accountAliases, resolveFactAccount } from "../src/suffix-facts.js";

// Synthetic account names, deliberately shaped like a real portfolio: several
// accounts share a brand token, some are card-named and some account-named, one
// is a single generic word, and one carries a digit+letter token. The fixture is
// the whole point of the tests: the resolver must work on a full set with shared
// tokens, not on a convenient subset.
// Fully synthetic on purpose: this file exercises the resolver, where no real
// brand token is needed. Brand-coupled tests keep a real brand (see
// tests/bank-movement.test.js) because hasBankToken refuses unknown banks, so the
// two fixture styles differ deliberately - do not "fix" that by unifying them.
const ACCOUNTS = [
  "Alpha Bank",
  "Beta 360",
  "Eta Plus Saver",
  "Delta Extra Card",
  "Epsilon Account",
  "Zeta Bank",
  "Theta Reward",
  "Iota Freedom",
  "Kappa Cashback",
  "Zeta Card",
  "Epsilon Vista Card",
  "Delta One Account",
  "Eta Journeys",
  "Epsilon Nova Card",
  "Savings",
  "Beta 90N",
];

const asRecords = (names) => names.map((name) => ({ id: name, name, closed: false }));

describe("parseSuffixFact (tolerant reader)", () => {
  it.each([
    ["Card ending 7111 belongs to Epsilon Nova Card", "7111", "Epsilon Nova Card"],
    ["Account ending 7222 belongs to Epsilon Account", "7222", "Epsilon Account"],
    // The shape Hermes actually stored during the live probe.
    ["Card/account ending 9999 belongs to Epsilon Nova Card.", "9999", "Epsilon Nova Card"],
    ["Account/card ending 6600 belongs to Beta 360", "6600", "Beta 360"],
    ["card ending in 7111 belongs to Epsilon Nova", "7111", "Epsilon Nova"],
    ["  Card Ending 7111 Belongs To Epsilon Nova Card  ", "7111", "Epsilon Nova Card"],
    ["Card ending 7111 belongs to Epsilon Nova Card,", "7111", "Epsilon Nova Card"],
  ])("parses %j", (text, suffix, accountName) => {
    expect(parseSuffixFact(text)).toEqual({ suffix, accountName });
  });

  it.each([
    ["BUS/MRT maps to Public Transport payee"],
    ["Epsilon Nova Card is a credit card account"],
    ["Zeta alert recipient maps to Zeta Bank account"],
    ["CARD FACTORY 2048 belongs to X"],
    ["Card ending 7111"],
    ["Example Eta A/C ending 2555 maps to Household stuffs payee"],
    [
      "Example Banking Corporation Ltd A/C ending 6600 maps to Beta 360 payee",
    ],
    [""],
  ])("rejects %j", (text) => {
    expect(parseSuffixFact(text)).toBeNull();
  });

  it("never returns a prefix, so a slash form cannot propagate", () => {
    const parsed = parseSuffixFact(
      "Card/account ending 9999 belongs to Epsilon Nova Card.",
    );
    expect(Object.keys(parsed).sort()).toEqual(["accountName", "suffix"]);
  });

  it("exposes the stopword list for callers", () => {
    expect(stopwords()).toContain("card");
  });
});

describe("canonicalSuffixFact (deterministic prefix)", () => {
  it("uses Card for card-named accounts", () => {
    expect(
      canonicalSuffixFact({ suffix: "7111", accountName: "Epsilon Nova Card" }),
    ).toBe("Card ending 7111 belongs to Epsilon Nova Card");
  });

  it("uses Account for everything else", () => {
    expect(
      canonicalSuffixFact({ suffix: "7222", accountName: "Epsilon Account" }),
    ).toBe("Account ending 7222 belongs to Epsilon Account");
  });

  it("keeps the word boundary, so Cardiff is not a card", () => {
    expect(
      canonicalSuffixFact({ suffix: "1234", accountName: "Cardiff Savings" }),
    ).toBe("Account ending 1234 belongs to Cardiff Savings");
  });

  it("round-trips through the parser", () => {
    const fact = canonicalSuffixFact({
      suffix: "1777",
      accountName: "Epsilon Vista Card",
    });
    expect(parseSuffixFact(fact)).toEqual({
      suffix: "1777",
      accountName: "Epsilon Vista Card",
    });
  });
});

describe("matchAccountByName (word containment)", () => {
  const accounts = asRecords(ACCOUNTS);
  const resolvedName = (input) =>
    matchAccountByName(input, accounts).name ?? undefined;
  const refuseReason = (input) => matchAccountByName(input, accounts).reason;

  it.each([
    ["Nova", "Epsilon Nova Card"],
    ["Nova Card", "Epsilon Nova Card"],
    ["nova", "Epsilon Nova Card"],
    ["Epsilon Nova", "Epsilon Nova Card"],
    ["Vista", "Epsilon Vista Card"],
    ["Epsilon Vista", "Epsilon Vista Card"],
    ["Delta Extra", "Delta Extra Card"],
    ["Extra", "Delta Extra Card"],
    ["Iota", "Iota Freedom"],
    ["Theta Rewards", "Theta Reward"],
    ["Kappa", "Kappa Cashback"],
    ["Alpha", "Alpha Bank"],
    ["360", "Beta 360"],
    ["90n", "Beta 90N"],
    ["90°n", "Beta 90N"],
    ["Plus Saver", "Eta Plus Saver"],
    ["Journeys", "Eta Journeys"],
    ["Savings", "Savings"],
    // Regression: with exact match AFTER stopword removal these both collapse
    // to "zeta" and get refused.
    ["Zeta Bank", "Zeta Bank"],
    ["Zeta Card", "Zeta Card"],
    // Full live names must keep working.
    ["Epsilon Account", "Epsilon Account"],
    ["Epsilon Nova Card", "Epsilon Nova Card"],
  ])("resolves %j -> %j", (input, expected) => {
    expect(resolvedName(input)).toBe(expected);
  });

  it.each([
    // Ambiguous: three Epsilon accounts.
    ["Epsilon"],
    ["Epsilon Card"],
    ["my Beta account"],
    // No account can contain these.
    ["Nonexistent Bank"],
    ["Random Merchant"],
  ])("refuses %j", (input) => {
    expect(matchAccountByName(input, accounts).matched).toBe(false);
  });

  it.each([["card"], ["bank"], ["account"], ["my account"], [""], ["   "]])(
    "refuses the stopword-only input %j instead of vacuously matching everything",
    (input) => {
      expect(matchAccountByName(input, accounts).matched).toBe(false);
    },
  );

  it("reports why it refused", () => {
    expect(refuseReason("Epsilon")).toContain("ambiguous");
    expect(refuseReason("Nonexistent Bank")).toContain("no account matches");
  });

  it("uses token-set containment, not substring", () => {
    const live = asRecords(["Epsilon Visa 1234", "Epsilon Visa 12345"]);
    // Substring matching would accept both; token sets pick the exact one.
    expect(matchAccountByName("Epsilon 1234", live).name).toBe("Epsilon Visa 1234");
  });

  it("does not plural-trim Plus or Bonus into a different word", () => {
    const live = asRecords(["Plus Account", "Bonus Account"]);
    expect(matchAccountByName("Plus", live).name).toBe("Plus Account");
    expect(matchAccountByName("Bonus", live).name).toBe("Bonus Account");
  });

  it("strips a parenthesised account id before matching", () => {
    expect(resolvedName("Epsilon Nova Card (abc12345)")).toBe("Epsilon Nova Card");
  });

  it("refuses duplicate live account names instead of picking by order", () => {
    const dupes = [
      { id: "a", name: "Epsilon Nova Card", closed: false },
      { id: "b", name: "Epsilon Nova Card", closed: false },
    ];
    const result = matchAccountByName("Epsilon Nova Card", dupes);
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("duplicate account name");
  });

  it("ignores closed accounts", () => {
    const live = [{ id: "a", name: "Epsilon Nova Card", closed: true }];
    expect(matchAccountByName("Nova", live).matched).toBe(false);
  });

  it("never returns a fact-like object: callers must read .account", () => {
    expect(matchAccountByName("Nova", accounts)).toHaveProperty("matched", true);
  });
});

describe("MemoryStore.cleanup — canonicalisation of suffix facts", () => {
  const storeWith = async (lines) => {
    const { MemoryStore } = await import("../src/memory.js");
    const { mkdtempSync, writeFileSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const dir = mkdtempSync(join(tmpdir(), "mem-331-"));
    const path = join(dir, "MEMORY.md");
    writeFileSync(
      path,
      ["# Long-Term Memory", "", "## Facts", "", ...lines, ""].join("\n"),
    );
    const store = new MemoryStore(path);
    return { store, path };
  };

  it("rewrites a slash form to canonical and drops the duplicate spelling", async () => {
    const { store, path } = await storeWith([
      "- Card/account ending 7111 belongs to Epsilon Nova Card.",
      "- Card ending 7111 belongs to Epsilon Nova Card",
    ]);
    const result = await store.cleanup();
    expect(result.normalised).toBeGreaterThan(0);
    const { readFileSync } = await import("fs");
    const written = readFileSync(path, "utf8");
    expect(written).toContain("Card ending 7111 belongs to Epsilon Nova Card");
    expect(written).not.toContain("Card/account");
    expect(
      written.split("\n").filter((l) => l.includes("ending 7111")).length,
    ).toBe(1);
  });

  it("reports a same-suffix conflict instead of hiding it", async () => {
    const { store, path } = await storeWith([
      "- Card ending 7111 belongs to Epsilon Nova Card",
      "- Card ending 7111 belongs to Epsilon Vista Card",
    ]);
    const result = await store.cleanup();
    const { readFileSync } = await import("fs");
    const written = readFileSync(path, "utf8");
    // Contradiction resolution is newest-wins (pre-existing), but it must be
    // REPORTED: two live mappings for one card is a data problem the user has
    // to decide, and canonicalisation must not quietly pick one.
    expect(result.contradictions.length).toBeGreaterThan(0);
    expect(written).toContain("ending 7111");
  });

  it("is idempotent: a second run reports no normalisation", async () => {
    const { store } = await storeWith([
      "- Card ending 7111 belongs to Epsilon Nova Card",
    ]);
    const first = await store.cleanup();
    expect(first.normalised).toBe(0);
    const second = await store.cleanup();
    expect(second.normalised).toBe(0);
    expect(second.removed).toBe(0);
  });

  it("preserves the Beta 6600 / 166600 alias pair (distinct suffixes, one account)", async () => {
    const { store, path } = await storeWith([
      "- Account ending 166600 belongs to Beta 360",
      "- Account ending 6600 belongs to Beta 360",
    ]);
    await store.cleanup();
    const { readFileSync } = await import("fs");
    const written = readFileSync(path, "utf8");
    expect(written).toContain("Account ending 166600 belongs to Beta 360");
    expect(written).toContain("Account ending 6600 belongs to Beta 360");
  });
});

describe("regressions found in dev-loop review round 1", () => {
  it("does not resolve a closed account's name to a live sibling", () => {
    const withClosedTwin = [
      { id: "eps-account", name: "Epsilon Account", closed: true },
      { id: "eps-nova", name: "Epsilon Nova Card", closed: false },
    ];
    const result = matchAccountByName("Epsilon Account", withClosedTwin);
    expect(result.matched).toBe(false);

    // Also when the closed account is absent from the list entirely: "Epsilon
    // Account" must not degrade into "Epsilon Nova Card" just because "account" is
    // a stopword.
    const onlyNova = [{ id: "eps-nova", name: "Epsilon Nova Card", closed: false }];
    expect(matchAccountByName("Epsilon Account", onlyNova).matched).toBe(false);
    expect(matchAccountByName("Zeta Bank", [
      { id: "zeta-card", name: "Zeta Card", closed: false },
    ]).matched).toBe(false);
  });

  it("still resolves the account that is actually present", () => {
    const live = [
      { id: "eps-account", name: "Epsilon Account", closed: false },
      { id: "eps-nova", name: "Epsilon Nova Card", closed: false },
    ];
    expect(matchAccountByName("Epsilon Nova", live).name).toBe("Epsilon Nova Card");
    expect(matchAccountByName("Epsilon Account", live).name).toBe("Epsilon Account");
  });
});

describe("regressions found in dev-loop review rounds 2-3", () => {
  it("does not let a filler-word retry resolve an absent account to a sibling", async () => {
    const { identityMappingsFromFacts } = await import("../src/bank-movement.js");
    // "Delta One Account" is absent; a containment retry would reach "Delta One Card".
    const m = identityMappingsFromFacts(
      ["Account ending 4321 belongs to Delta One Account"],
      [{ id: "delta-card", name: "Delta One Card", closed: false }],
    );
    expect(m.suffix.get("4321")).toBeUndefined();

    // The legitimate filler case still resolves by exact name.
    const ok = identityMappingsFromFacts(
      ["Account ending 166600 belongs to Beta 360 account"],
      [{ id: "beta", name: "Beta 360", closed: false }],
    );
    expect(ok.suffix.get("166600")?.name).toBe("Beta 360");
  });

  it("arms the safety net for a filler-word fact too", async () => {
    const { hasUsableSuffixFact } = await import("../src/orchestrator.js");
    // This fixture keeps a real bank brand token on purpose: nameMatchesBank
    // needs hasBankToken() to hit its hardcoded known-bank list, and it refuses
    // unknown banks by design ("never assume"), so a fully synthetic brand name
    // cannot exercise this path. The account product name itself is invented.
    const live = [{ id: "dbs-example", name: "DBS Example", closed: false }];
    expect(
      hasUsableSuffixFact(
        [{ text: "Account ending 6600 belongs to DBS Example account", score: 1 }],
        "From: DBS card ending 6600",
        "DBS",
        live,
      ),
    ).toBe(true);
  });

  it("does not let a sibling type fact decide this account's sign", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const { mkdtempSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    void mkdtempSync(join(tmpdir(), "m331-"));
    const config = {
      primaryCurrency: "SGD",
      secondaryCurrency: "MYR",
      primaryBudgetFile: "b1",
      secondaryBudgetFile: "b2",
      llmProvider: "deepseek",
      llmApiKey: "t",
      deepseekApiKey: "t",
    };
    const tools = {
      getPhase1ToolSchemas: () => [],
      setEmailContext: () => {},
      executeTool: async (name) => {
        if (name === "search_memory")
          return {
            results: [
              { text: "Zeta Card is a credit card account", score: 1 },
            ],
          };
        return true;
      },
    };
    const orch = new AgentOrchestrator(config, tools);
    // Only one generic token is shared ("zeta"), so this must not decide.
    await expect(orch._detectAccountType("Zeta Bank")).resolves.toBe("bank");

    // A genuine same-account fact still decides, including a short stored form.
    const tools2 = {
      getPhase1ToolSchemas: () => [],
      setEmailContext: () => {},
      executeTool: async (name) =>
        name === "search_memory"
          ? { results: [{ text: "Epsilon Nova is a credit card account", score: 1 }] }
          : true,
    };
    const orch2 = new AgentOrchestrator(config, tools2);
    await expect(orch2._detectAccountType("Epsilon Nova Card")).resolves.toBe(
      "credit card",
    );
  });

  it("keeps the structured index consistent after cleanup drops a duplicate", async () => {
    const { MemoryStore } = await import("../src/memory.js");
    const { mkdtempSync, writeFileSync, readFileSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const dir = mkdtempSync(join(tmpdir(), "mem-idx-"));
    const path = join(dir, "MEMORY.md");
    writeFileSync(
      path,
      [
        "# Long-Term Memory",
        "",
        "## Facts",
        "",
        "- Card/account ending 7111 belongs to Epsilon Nova Card.",
        "- Card ending 7111 belongs to Epsilon Nova Card",
        "- BUS/MRT maps to Public Transport payee",
        "",
      ].join("\n"),
    );
    const store = new MemoryStore(path);
    await store.cleanup();
    // A later update must not overwrite an unrelated fact through a stale index.
    await store.update(
      "Card ending 7111 belongs to Epsilon Nova Card",
      "Card ending 7111 belongs to Epsilon Vista Card",
    );
    const written = readFileSync(path, "utf8");
    expect(written).toContain("Public Transport payee");
    expect(written).toContain("Epsilon Vista Card");
  });
});

/**
 * Issue #469 item 1 — the kind-word guard must treat a plural type word exactly
 * as it treats the singular one, and the filler retry must accept the plural
 * filler without becoming a containment match.
 *
 * Fixtures below are invented on purpose: the guard is about word shapes, so a
 * synthetic set proves the same property without carrying real account names.
 */
describe("issue #469 item 1: plural type words follow the singular guard", () => {
  const live = (names) =>
    names.map((name) =>
      typeof name === "string" ? { id: name, name, closed: false } : name,
    );

  // A trailing "bank"/"card"/"account" names an account KIND. The guard exists
  // so a kind word cannot be dropped and the name silently resolve to a
  // sibling; plural forms must refuse exactly like the singular does.
  it.each([
    ["Alpha account", ["Alpha Bank"]],
    ["Alpha accounts", ["Alpha Bank"]],
    ["Alpha cards", ["Alpha Bank"]],
    ["Beta accounts", ["Beta Card"]],
    ["Beta banks", ["Beta Card"]],
    ["Beta cards", ["Beta Bank"]],
    ["Gamma One accounts", ["Gamma One Card"]],
    ["Gamma One cards", ["Gamma One Bank"]],
  ])("refuses %s against only %s", (query, names) => {
    expect(matchAccountByName(query, live(names)).matched).toBe(false);
  });

  // Plural must not cost a match that the words actually support.
  it.each([
    ["Alpha banks", ["Alpha Bank"], "Alpha Bank"],
    ["Alpha cards", ["Alpha Card"], "Alpha Card"],
    ["Gamma One accounts", ["Gamma One Account"], "Gamma One Account"],
  ])("resolves %s against %s", (query, names, expected) => {
    expect(matchAccountByName(query, live(names)).name).toBe(expected);
  });

  // A real account whose own name is plural still resolves, both exactly and
  // through the stopword-stripped path.
  it.each([
    ["Alpha Accounts", ["Alpha Accounts"]],
    ["Alpha account", ["Alpha Accounts"]],
    ["Alpha accounts", ["Alpha Accounts"]],
  ])("resolves the plural-named account for %s", (query, names) => {
    expect(matchAccountByName(query, live(names)).name).toBe("Alpha Accounts");
  });

  // Documented behaviour change: a plural type word now picks the single
  // kind-matching account instead of refusing as ambiguous. This is exactly
  // what the singular form already did before the change, so it is pinned
  // rather than treated as a fix.
  it("resolves a plural type word the same way the singular already does", () => {
    const set = ["Delta Account", "Delta Nova Card"];
    expect(matchAccountByName("Delta account", live(set)).name).toBe(
      "Delta Account",
    );
    expect(matchAccountByName("Delta accounts", live(set)).name).toBe(
      "Delta Account",
    );
    expect(matchAccountByName("Beta cards", live(["Beta Bank", "Beta Card"])).name).toBe(
      "Beta Card",
    );
  });

  it("still refuses a closed twin on a plural type word", () => {
    const set = [{ id: "a", name: "Alpha Account", closed: true }, "Alpha Card"];
    expect(matchAccountByName("Alpha accounts", live(set)).matched).toBe(false);
  });

  it("still refuses duplicate account names on a plural type word", () => {
    expect(
      matchAccountByName("Alpha banks", live(["Alpha Bank", "Alpha Bank"]))
        .matched,
    ).toBe(false);
  });
});

describe("issue #469 item 1: the filler retry accepts the plural filler", () => {
  const live = (names) => names.map((name) => ({ id: name, name, closed: false }));

  // The retry only strips the generic trailing "account" filler, so a name the
  // words do not support must still be refused. It stays exact-name-only.
  it.each([
    ["Beta 360 accounts", ["Beta 360"], "Beta 360"],
    ["Alpha Rewards accounts", ["Alpha Rewards"], "Alpha Rewards"],
    ["Delta Deposit accounts", ["Delta Deposit"], "Delta Deposit"],
  ])("resolves %s against %s", (query, names, expected) => {
    expect(resolveFactAccount(query, live(names)).name).toBe(expected);
  });

  it.each([
    ["Alpha accounts", ["Alpha Bank"]],
    ["Gamma One accounts", ["Gamma One Card"]],
    ["Alpha accounts", ["Alpha Card"]],
  ])("does not let the plural retry reach a sibling: %s vs %s", (query, names) => {
    expect(resolveFactAccount(query, live(names)).matched).toBe(false);
  });
});

describe("issue #469 item 1: writing an exact account name always resolves", () => {
  const synthetic = [
    "Alpha Bank",
    "Alpha Card",
    "Alpha Accounts",
    "Beta 360",
    "Gamma Rewards",
    "Delta Deposit",
    "Delta Nova Card",
  ];

  it.each(synthetic)("resolves %s when it is the only account", (name) => {
    expect(
      matchAccountByName(name, [{ id: name, name, closed: false }]).name,
    ).toBe(name);
  });
});

// ── Issue #496: a bank alert may name the product, not the account ────────
describe("account aliases (#496)", () => {
  const live = [
    { id: "ryt", name: "Ryt Bank", closed: false },
    { id: "trust-bank", name: "Trust Bank", closed: false },
    { id: "trust-card", name: "Trust Card", closed: false },
  ];
  const alertFacts = [
    { text: "Main Account is a Ryt Bank account" },
    { text: "Trust Cashback card is a Trust Card account" },
    { text: "Citi Reward is a credit card account" },
    { text: "Trust Bank is a bank account" },
  ];

  it("resolves a product name the alert uses instead of the account name", () => {
    const aliases = accountAliases(alertFacts, live);
    expect(matchAccountByName("Main Account", live, aliases).name).toBe("Ryt Bank");
    expect(matchAccountByName("Trust Cashback card", live, aliases).name).toBe(
      "Trust Card",
    );
  });

  it("only aliases facts whose target is a live account", () => {
    // "credit card" and "bank" are kinds, not accounts, so they stay out.
    const aliases = accountAliases(alertFacts, live);
    expect(aliases.size).toBe(2);
    expect(aliases.has("citi reward")).toBe(false);
    expect(aliases.has("trust bank")).toBe(false);
  });

  it("leaves every existing rule alone when no alias applies", () => {
    const aliases = accountAliases(alertFacts, live);
    // Exact name still wins.
    expect(matchAccountByName("Trust Card", live, aliases).name).toBe("Trust Card");
    // A named-but-absent account still refuses rather than reaching a sibling.
    expect(
      matchAccountByName("Trust Account", [live[2]], aliases).matched,
    ).toBe(false);
    // An unknown product name still refuses.
    expect(matchAccountByName("Some Other Product", live, aliases).matched).toBe(
      false,
    );
  });

  it("does not alias a product name to an account that is not live", () => {
    const aliases = accountAliases(
      [{ text: "Main Account is a Ryt Bank account" }],
      [{ id: "dbs", name: "DBS Account", closed: false }],
    );
    expect(aliases.size).toBe(0);
  });
});

describe("account aliases in the orchestrator path (#496 review)", () => {
  it("applies an alias through hasUsableSuffixFact", async () => {
    const { hasUsableSuffixFact } = await import("../src/orchestrator.js");
    const live = [{ id: "ryt", name: "Ryt Bank", closed: false }];
    const facts = [
      { text: "Main Account is a Ryt Bank account", score: 0.9 },
      { text: "Card ending 1234 belongs to Main Account", score: 0.9 },
    ];
    // Round 1 on c1e1d10: the local wrapper dropped the aliases argument, so
    // this returned false even though the alias map was correct.
    expect(
      hasUsableSuffixFact(facts, "card ending 1234 at Ryt", "Ryt", live),
    ).toBe(true);
  });

  it("does not let a fact shadow a live account name", () => {
    const live = [
      { id: "dbs", name: "DBS Account", closed: false },
      { id: "ryt", name: "Ryt Bank", closed: false },
    ];
    const aliases = accountAliases(
      [{ text: "DBS Account is a Ryt Bank account" }],
      live,
    );
    expect(matchAccountByName("DBS Account", live, aliases).name).toBe(
      "DBS Account",
    );
  });

  it("ignores an alias fact below the search score floor", () => {
    const live = [{ id: "ryt", name: "Ryt Bank", closed: false }];
    expect(
      accountAliases(
        [{ text: "Main Account is a Ryt Bank account", score: 0.1 }],
        live,
      ).size,
    ).toBe(0);
  });
});

describe("alias edge cases (#496 round 1)", () => {
  const live = [
    { id: "ryt", name: "Ryt Bank", closed: false },
    { id: "trust", name: "Trust Bank", closed: false },
    { id: "closed-eps", name: "Epsilon Account", closed: true },
    { id: "nova", name: "Epsilon Nova Card", closed: false },
  ];

  it("refuses a product claimed for two different accounts", () => {
    const aliases = accountAliases(
      [
        { text: "Main Account is a Ryt Bank account" },
        { text: "Main Account is a Trust Bank account" },
      ],
      live,
    );
    expect(aliases.has("main account")).toBe(false);
  });

  it("keeps a parenthesised id out of the alias key", () => {
    const aliases = accountAliases(
      [{ text: "Main Account (abc123) is a Ryt Bank account" }],
      live,
    );
    expect(aliases.get("main account")).toBe("Ryt Bank");
  });

  it("still refuses the closed-twin case with an aliases map present", () => {
    const aliases = accountAliases(
      [{ text: "Epsilon Account is a Epsilon Nova Card account" }],
      live,
    );
    // The closed account still owns its own name, so it is never redirected.
    expect(
      matchAccountByName("Epsilon Account", live, aliases).matched,
    ).toBe(false);
  });
});

describe("alias targets that cannot resolve (#496 round 5)", () => {
  const live = [
    { id: "eps", name: "Epsilon Account", closed: true },
    { id: "ryt", name: "Ryt Bank", closed: false },
  ];

  it("ignores a rival claim from a target that could never resolve", () => {
    const aliases = accountAliases(
      [
        { text: "Main Account is a Epsilon Account account", score: 0.9 },
        { text: "Main Account is a Ryt Bank account", score: 0.9 },
      ],
      live,
      );
    expect(aliases.get("main account")).toBe("Ryt Bank");
    expect(
      matchAccountByName("Main Account", live, aliases).name,
    ).toBe("Ryt Bank");
  });

  it("ignores a rival claim from a duplicate-named target", () => {
    const dupes = [
      { id: "a", name: "Shared Account", closed: false },
      { id: "b", name: "Shared Account", closed: false },
      { id: "ryt", name: "Ryt Bank", closed: false },
    ];
    const aliases = accountAliases(
      [
        { text: "Main Account is a Shared Account account", score: 0.9 },
        { text: "Main Account is a Ryt Bank account", score: 0.9 },
      ],
      dupes,
    );
    expect(aliases.get("main account")).toBe("Ryt Bank");
  });
});
