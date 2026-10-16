/**
 * Card/account suffix facts — one grammar and one resolver, shared by every
 * consumer.
 *
 * This module is deliberately dependency-free: `memory.js` owns fact storage
 * and `bank-movement.js` owns movement resolution, and both must read the same
 * fact shape. Keeping the grammar here is what stops the readers drifting
 * apart again, which is the defect issue #331 was filed about.
 */

/**
 * Card/account suffix facts. Deliberately tolerant on the parts people and
 * models get wrong — a `Card/account` prefix, an optional "in", casing,
 * surrounding whitespace and trailing punctuation — and strict on the parts
 * that matter: the prefix must be a card/account word, and the suffix must be
 * 4-6 digits.
 */
export const CANONICAL_SUFFIX_RE =
  /^(?:card|account)(?:\s*\/\s*account|\s*\/\s*card)?\s+ending(?:\s+in)?\s+(\d{4,6})\s+belongs\s+to\s+([\s\S]+)$/i;

/**
 * Structured fact templates, keyed by (entity, relation). The suffix pattern
 * uses the shared grammar so the index, the safety net and movement resolution
 * agree on what a suffix fact is.
 */
export const STRUCTURED_PATTERNS = [
  {
    re: /^(.+?)\s+merchant\s+maps\s+to\s+(.+?)\s+payee$/i,
    rel: "merchant->payee",
  },
  { re: /^(.+?)\s+maps\s+to\s+(.+?)\s+payee$/i, rel: "->payee" },
  { re: /^(.+?)\s+maps\s+to\s+(.+?)\s+category$/i, rel: "->category" },
  { re: /^(.+?)\s+is\s+(?:a|an)\s+(.+?)\s+account$/i, rel: "is-account" },
  { re: CANONICAL_SUFFIX_RE, rel: "suffix->account" },
];

/** Words that carry no discriminating power in an account name. */
const ACCOUNT_STOPWORDS = new Set([
  "my",
  "the",
  "a",
  "an",
  "card",
  "cards",
  "account",
  "accounts",
  "bank",
  "belongs",
  "to",
  "of",
  "for",
  "this",
  "that",
]);

/** The stopword list, exposed for callers that normalise account names. */
export function stopwords() {
  return [...ACCOUNT_STOPWORDS];
}

/** Lowercase word tokens. Letters and digits only, so a symbol such as the
 *  degree sign in "Beta 90°N" splits the token rather than gluing it, letting
 *  "90n" match "Beta 90N". */
export function accountTokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Drop a parenthesised account id, e.g. "Epsilon Nova Card (22caada9)". */
function stripParenthesisedId(text) {
  return String(text || "").replace(/\s*\([^)]*\)\s*/g, " ").trim();
}

/** Trailing punctuation and collapsed whitespace, for a captured account name. */
function cleanAccountText(text) {
  return String(text || "")
    .replace(/[.,;:!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a card/account suffix fact. Returns `{ suffix, accountName }` or null.
 *
 * Never returns a prefix: `Card/account` is tolerated on input but is not a
 * value the system carries, keys on, or writes. Stored text is always
 * canonical, produced by `canonicalSuffixFact`.
 */
export function parseSuffixFact(text) {
  const m = String(text || "").trim().match(CANONICAL_SUFFIX_RE);
  if (!m) return null;
  const accountName = cleanAccountText(m[2]);
  if (!accountName) return null;
  return { suffix: m[1], accountName };
}

/**
 * The one deterministic way to name a suffix mapping. The prefix is cosmetic —
 * the safety net keys on suffix plus account — so it is derived from the
 * account name, never from whoever wrote the fact.
 */
export function canonicalSuffixFact({ suffix, accountName } = {}) {
  const prefix = /\bcard\b/i.test(String(accountName || "")) ? "Card" : "Account";
  return `${prefix} ending ${suffix} belongs to ${accountName}`;
}

/** Trailing "s" is treated as a plural marker. Only a word that actually ends
 *  in "s" is trimmed, so "dbs" is never reduced to "db". */
function pluralTrim(tokens) {
  return tokens.map((t) =>
    t.endsWith("s") && t.length > 3 && !t.endsWith("ss") ? t.slice(0, -1) : t,
  );
}

/**
 * A trailing type word names a specific account KIND, so the guard below must
 * treat a plural as the same kind word. "accounts" and "cards" are stopwords,
 * so without this map they vanish from `raw` and the guard silently stops
 * firing: "Alpha accounts" would resolve to "Alpha Card" exactly as the
 * singular form is refused. "banks" is not a stopword and already survives, but
 * it maps too so the guard reads the same for all three kinds.
 *
 * Only the kind word is normalised. `raw`, `query` and the exact comparison keep
 * their own plural handling, which is what stops a type word from degrading a
 * named account into a sibling.
 */
const KIND_WORD_SINGULAR = { accounts: "account", banks: "bank", cards: "card" };

/** Refusal result. Always an object, so callers can log why resolution failed. */
function refusal(reason) {
  return { matched: false, id: null, name: null, reason };
}

/**
 * Resolve a fact's account name the way EVERY reader must: normal word
 * matching first, then one bounded retry that strips a trailing filler
 * "account" word.
 *
 * The retry accepts only an EXACT token match against a live account. A
 * containment retry would turn a named-but-absent account into a live sibling:
 * "Delta One Account" would resolve to "Delta One Card". Keeping this here, rather
 * than in each caller, is what stops the three readers drifting apart.
 *
 * @returns the same shape as `matchAccountByName`.
 */
export function resolveFactAccount(accountName, accounts, aliases) {
  // Aliases are a LAST RESORT. A name the resolver can place on its own —
  // exactly, or through the bounded filler retry below — is never redirected.
  // Review round 3 on 66d274d: substituting on the first call let an alias
  // return an account the fact never named, bypassing the retry's
  // exact-match-only invariant.
  const withoutAliases = () => {
    const first = matchAccountByName(accountName, accounts);
    if (first.matched) return first;
    const stripped = String(accountName || "")
      .replace(/\s+accounts?$/i, "")
      .trim();
    if (stripped === String(accountName || "").trim()) return first;
    const target = accountTokens(stripped).join(" ");
    if (!target) return first;
    const exact = (accounts || []).filter(
      (a) => a && accountTokens(a.name).join(" ") === target,
    );
    if (exact.length !== 1) return first;
    return matchAccountByName(exact[0].name, accounts);
  };

  const placed = withoutAliases();
  // Either "nothing matched" reason may be redirected: a product name whose
  // words are all stopwords ("My Card") is exactly the case aliases exist for.
  // Any other refusal — closed, duplicate, ambiguous — means the name is owned
  // by a real account and must not be moved. Review round 4 on 449366d.
  const nothingMatched = () =>
    placed.reason === "no account matches those words" ||
    placed.reason === "no distinctive words in the name";
  if (placed.matched || !nothingMatched() || !aliases || !aliases.size) {
    return placed;
  }
  return matchAccountByName(accountName, accounts, aliases);
}

/**
 * Resolve an account name written by a human or a model to an account.
 *
 * Deterministic word matching, not embeddings: measured against the live
 * account set before these fixtures were anonymised, embedding similarity
 * rejected the three shortest written forms at scores of 0.746, 0.742 and
 * 0.554, and shorter names score worse rather than better.
 *
 * Order matters. Exact matching runs BEFORE stopword removal, otherwise "Epsilon"
 * reduces to the same tokens as "Epsilon Account" and silently resolves to the
 * wrong account — the exact failure this issue is about.
 *
 * CLOSED accounts stay in the candidate set on purpose. Filtering them out
 * first would let a fact naming a closed account resolve to a live sibling:
 * "Epsilon Account" would match "Epsilon Nova Card" once the generic word "account" is
 * dropped. A closed twin must force ambiguity, and resolving to a closed
 * account is itself a refusal.
 *
 * Returns ONE shape always, so callers switch on `matched` rather than
 * truthiness: an unmatched refusal is a non-null object with `matched: false`.
 *
 * @returns {{matched: boolean, id: string|null, name: string|null, reason?: string}}
 */
function matchWithoutAliases(nameText, accounts) {
  const all = (accounts || []).filter(Boolean);
  if (!all.length) return refusal("no live accounts");

  const raw = accountTokens(stripParenthesisedId(nameText));
  if (!raw.length) return refusal("empty account name");

  const nameCounts = new Map();
  for (const account of all) {
    const key = accountTokens(account.name).join(" ");
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }

  const resolve = (account) => {
    if (account.closed) return refusal("account is closed");
    const key = accountTokens(account.name).join(" ");
    if (nameCounts.get(key) > 1) return refusal("duplicate account name");
    return { matched: true, id: account.id, name: account.name };
  };
  const resolveOneOf = (list) => {
    const keys = new Set(list.map((a) => accountTokens(a.name).join(" ")));
    // Two accounts sharing one name cannot be resolved deterministically.
    if (keys.size === 1 && nameCounts.get([...keys][0]) > 1) {
      return refusal("duplicate account name");
    }
    if (list.length !== 1) return refusal("ambiguous");
    return resolve(list[0]);
  };

  // Step 1 — exact match on the full token string, stopwords included.
  const exact = all.filter(
    (a) =>
      accountTokens(stripParenthesisedId(a.name)).join(" ") === raw.join(" "),
  );
  if (exact.length) return resolveOneOf(exact);

  // Step 2 — containment over set-difference tokens (token SET, not substring).
  // Plural trimming AND stopword removal happen only here, after the exact
  // comparison. Applying stopword removal to the exact-comparison input would
  // drop the "account" token and collapse "Epsilon Account" onto a bare
  // "Epsilon", which would then resolve to the wrong account; plural trimming
  // is deferred for the same reason, so singular and plural names stay distinct.
  const query = pluralTrim(raw.filter((w) => !ACCOUNT_STOPWORDS.has(w)));
  if (!query.length) return refusal("no distinctive words in the name");

  // "account" and "bank" are ordinary words in this domain, so they are dropped
  // as stopwords above — but a name that ends with one is naming a specific
  // account KIND. Without this guard "Epsilon Account" would resolve to
  // "Epsilon Nova Card" and "Zeta Bank" to "Zeta Card" whenever the account the
  // user actually named is absent or closed, which is a wrong-account booking.
  // A plural type word names the same kind, so it is normalised first.
  const kindWord =
    KIND_WORD_SINGULAR[raw[raw.length - 1]] || raw[raw.length - 1];
  const requiresKindWord =
    kindWord === "account" ||
    kindWord === "bank" ||
    kindWord === "card";

  const candidates = all.filter((a) => {
    const target = pluralTrim(accountTokens(a.name));
    if (requiresKindWord && !target.includes(kindWord)) return false;
    return query.every((w) => target.includes(w));
  });
  if (candidates.length === 0) return refusal("no account matches those words");
  if (candidates.length > 1) return refusal("ambiguous");
  return resolve(candidates[0]);
}

/**
 * Resolve a written name, falling back to an alias only when the resolver
 * itself cannot place the name.
 *
 * The guard is the resolver, not an exact-token comparison: the resolver also
 * reaches accounts through plural trimming, a kind word and containment, and an
 * exact-token check let a fact redirect a name the resolver could already place
 * (verified: `Ryt Cards is a Ryt Bank account` redirected `Ryt Cards`, which
 * otherwise resolves to `Ryt Card`). Issue #496, review round 2.
 */
export function matchAccountByName(nameText, accounts, aliases) {
  const direct = matchWithoutAliases(nameText, accounts);
  // Only a genuine "nothing matched" may be redirected. A refusal for a closed
  // or duplicate account means the name is owned by a real account, and an alias
  // must never move that account's alerts to a sibling. Review rounds 2 and 4.
  const nothingMatched =
    direct.reason === "no account matches those words" ||
    direct.reason === "no distinctive words in the name";
  if (direct.matched || !nothingMatched) {
    return direct;
  }
  if (!aliases || !aliases.size) return direct;
  const written = accountTokens(stripParenthesisedId(nameText)).join(" ");
  const target = written ? aliases.get(written) : undefined;
  if (!target) return direct;
  return matchWithoutAliases(target, accounts);
}

/**
 * Names a bank alert uses for an account that is not its Actual name:
 * `Main Account is a Ryt Bank account`, `Trust Cashback card is a Trust Card
 * account`. A product name cannot be matched against an account list at all, so
 * the written name is looked up here first. Issue #496.
 *
 * Only facts whose target is a LIVE account become aliases, which is what keeps
 * every type fact out of the map: `Citi Reward is a credit card account` targets
 * `credit card`, and no account is called that. A target that is closed still
 * becomes an alias; the closed-account refusal in `matchAccountByName` is what
 * rejects it, so the behaviour is the same either way.
 *
 * @param {Array<{text?: string}|string>} facts records from `search_memory`
 * @param {Array<{name: string}>} accounts live accounts
 * @returns {Map<string, string>} normalised alias to the live account's name
 */
export function accountAliases(facts, accounts) {
  const aliases = new Map();
  // A product claimed for two different accounts is ambiguous. Remember it so a
  // later fact cannot re-add it and let result order pick the winner.
  const ambiguous = new Set();
  for (const record of facts || []) {
    const text = typeof record === "string" ? record : record?.text;
    // Search results carry a score; an alias must be evidence for the merchant
    // it was retrieved for, so the same floor the suffix path uses applies.
    // Review round 1 on c1e1d10.
    if (typeof record?.score === "number" && record.score < 0.5) continue;
    const m = String(text || "").match(
      /^(.+?)\s+is\s+(?:a|an)\s+(.+?)\s+account$/i,
    );
    if (!m) continue;
    // The lookup strips a parenthesised id, so the key must too, or the alias
    // is silently unreachable. Review round 1 on c1e1d10.
    const alias = accountTokens(stripParenthesisedId(m[1])).join(" ");
    const target = accountTokens(m[2]).join(" ");
    if (!alias || !target) continue;
    if (ambiguous.has(alias)) continue;
    const targets = (accounts || []).filter(
      (a) => a && accountTokens(stripParenthesisedId(a.name)).join(" ") === target,
    );
    // Only an account that can actually resolve may be a target. A closed or
    // duplicate-named one never matches, and if it claimed the product the
    // ambiguity guard below would drop a valid alias for the same key and the
    // alias would be silently dead. Review round 5 on 493aad9.
    const live = targets.length === 1 && !targets[0].closed ? targets[0] : null;
    if (!live) continue;
    if (aliases.has(alias)) {
      if (aliases.get(alias) !== live.name) {
        aliases.delete(alias);
        ambiguous.add(alias);
      }
      continue;
    }
    aliases.set(alias, live.name);
  }
  return aliases;
}
