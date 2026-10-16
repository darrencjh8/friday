/**
 * MemoryStore — semantic memory with WASM embeddings for the expense tracker.
 *
 * Ported 1:1 from src/agent/memory.py
 * Replaces the hardcoded data/mappings.json with a human-readable MEMORY.md
 * file backed by all-MiniLM-L6-v2 WASM embeddings for semantic search.
 * Structured facts are matched by key only, never by similarity (#471/#472) —
 * see docs/design.md, "Merchant matching: keys, not similarity".
 *
 * Structured dedup (2026-06): facts matching known templates are indexed by
 * (entity, relation) in a Map for O(1) contradiction detection. Free-form
 * facts fall back to cosine-similarity-based semantic dedup.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "fs";
import { dirname } from "path";
import { pipeline, env as transformersEnv } from "@xenova/transformers";

const MEMORY_TEMPLATE = `# Long-Term Memory

## Facts

`;

// Imported for local use and re-exported, so fact handling has one import site.
import {
  CANONICAL_SUFFIX_RE,
  STRUCTURED_PATTERNS,
  accountAliases,
  canonicalSuffixFact,
  matchAccountByName,
  parseSuffixFact,
  stopwords,
} from "./suffix-facts.js";

export {
  CANONICAL_SUFFIX_RE,
  STRUCTURED_PATTERNS,
  accountAliases,
  canonicalSuffixFact,
  matchAccountByName,
  parseSuffixFact,
  stopwords,
};

/** Semantic-dedup cosine-similarity threshold for free-form facts. */
const SEMANTIC_THRESHOLD = 0.88;

/**
 * Minimum cosine similarity for a free-form semantic hit to be returned. This
 * only quiets `search_memory` noise: a mapping is matched by key, never by
 * similarity, so no score can make a neighbour's mapping usable. Issues #420,
 * #471.
 */
const SEARCH_MIN_SIMILARITY = 0.6;

/** Shortest structured entity that may match inside a longer merchant string. */
const MIN_ENTITY_LENGTH = 3;

/** A letter or digit in any script, so a non-ASCII run is not a word boundary. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** True when `needle` occurs in `haystack` on word boundaries, not inside a word. */
function containsWord(haystack, needle) {
  if (!needle) return false;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    const before = at === 0 ? "" : haystack[at - 1];
    const after = haystack[at + needle.length] || "";
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    at = haystack.indexOf(needle, at + 1);
  }
  return false;
}

/**
 * The lowercased key of a fact that maps a merchant to a payee or category
 * (`amaze* alipayprogra` in `AMAZE* ALIPAYPROGRA maps to Misc payee, no
 * category (middle-man processor — varies)`), or null for a free-form fact.
 *
 * Deliberately looser than `_parseStructured`, which indexes dedup keys: a
 * mapping whose tail carries a qualifier still names a merchant, and that
 * qualifier must not hide it from matching.
 */
function mappingEntity(fact) {
  const text = String(fact || "");
  const normalize = (name) =>
    name
      .replace(/[.,;:!?\s]+$/, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const mapsTo = text.match(/^(.+?)\s+(?:merchant\s+)?maps\s+to\s+/i);
  if (mapsTo) return normalize(mapsTo[1]);
  const isAccount = text.match(/^(.+?)\s+is\s+(?:a|an)\s+(.+?)\s+account$/i);
  if (isAccount) return normalize(isAccount[1]);
  const suffix = text.match(CANONICAL_SUFFIX_RE);
  if (suffix) return normalize(suffix[2]);
  return null;
}

function isMaskedKey(entity) {
  return /[＊*]{2,}/u.test(entity);
}

/**
 * True when `fact` is the mapping for `merchant`. The test is anchored to the
 * fact's own key, never to arbitrary text: a partial query must not select a
 * neighbour's mapping, so `AMAZE` does not match `AMAZE* GREATEASTERN`. The key
 * may still sit inside a longer alert merchant, because a bank alert carries
 * words the stored key does not — `AMAZE* ALIPAYPROGRA SINGAPORE SGP` versus the
 * stored key `AMAZE* ALIPAYPROGRA`. Issue #471.
 */
export function factNamesMerchant(fact, merchant) {
  const query = String(merchant || "").toLowerCase().trim();
  if (!query) return false;
  const entity = mappingEntity(fact);
  if (!entity) return false;
  // An exact key is unambiguous at any length. The length floor exists only to
  // stop a short key matching inside a longer merchant.
  if (query === entity) return true;
  if (entity.length < MIN_ENTITY_LENGTH) return false;
  return containsWord(query, entity);
}

export class MemoryStore {
  /**
   * @param {string} path - Path to MEMORY.md
   * @param {number} [maxFacts=300] - Auto-compact when facts exceed this
   * @param {number} [compactTo=250] - Keep this many facts after compaction
   */
  constructor(path = "data/MEMORY.md", maxFacts = 300, compactTo = 250) {
    this.path = path;
    this._facts = [];
    this._model = null;
    this._modelPromise = null;
    this._embeddingCache = new Map();
    this._initialized = false;
    this._dedupSet = new Set();
    /** @type {Map<string, {fact: string, index: number, parsed: {entity: string, relation: string, value: string}}>} */
    this._structuredIndex = new Map();
    this._maxFacts = maxFacts;
    this._compactTo = compactTo;
    this._init();
  }

  // ── public interface ──────────────────────────────────────────

  /**
   * Reload facts from disk and rebuild the dedup set + structured index.
   * Used after migrateFromMappings() writes new facts to the file.
   */
  reload() {
    this._loadFacts();
    this._dedupExisting();
    this._rebuildIndices();
  }

  get initialized() {
    return this._initialized;
  }

  listFacts() {
    return [...this._facts];
  }

  async search(query, topK = 5) {
    if (!this._facts.length) return [];
    // Exact/substring match first — deterministic for known entities (e.g.
    // "Grab" must resolve to its own fact, not a semantically-near "Amaze
    // Grab"). Semantic search only runs when substring finds nothing, so it
    // acts as a fuzzy fallback for unknown/near-miss merchants.
    const sub = this._substringSearch(query, topK);
    if (sub.length > 0) return sub;
    try {
      const sem = await this._semanticSearch(query, topK);
      if (sem.length > 0) return sem;
    } catch {}
    return [];
  }

  /**
   * Wait for the WASM model to finish loading.
   * @returns {Promise<boolean>} true if model loaded successfully
   */
  async ready() {
    if (this._modelPromise) {
      await this._modelPromise;
    }
    return !!this._model;
  }

  /**
   * Add a fact with three-tier dedup:
   *  1. Exact string match (O(1))
   *  2. Structured key match (O(1)) — contradiction → skip + warn
   *  3. Semantic cosine similarity (O(N), free-form only)
   */
  async add(fact, accounts = []) {
    fact = fact.trim();
    if (!fact) return { added: false, skipped: false, reason: "empty fact" };

    // ── Level 1: exact string dedup ──
    const normalized = fact.toLowerCase();
    if (this._dedupSet.has(normalized)) {
      return { added: false, skipped: true, reason: "duplicate" };
    }

    // ── Level 2: structured dedup (O(1) Map lookup) ──
    const parsed = this._parseStructured(fact);
    if (parsed) {
      const identityReason = this._identityValidationReason(fact, parsed, accounts);
      if (identityReason) {
        return { added: false, skipped: true, reason: identityReason };
      }
      const key = `${parsed.entity}|||${parsed.relation}`;
      const existing = this._structuredIndex.get(key);
      if (existing) {
        if (existing.parsed.value === parsed.value) {
          return {
            added: false,
            skipped: true,
            reason: "structured duplicate",
          };
        }
        // Contradiction: same (entity, relation) but different value.
        // Safe mode: keep the existing fact, skip the new one.
        return {
          added: false,
          skipped: true,
          reason: "contradiction",
          existing: existing.fact,
        };
      }
    }

    // ── Level 3: semantic dedup (free-form facts only) ──
    if (!parsed) {
      if (this._model) {
        try {
          const newEmb = await this._getOrComputeEmbedding(fact);
          for (const existing of this._facts) {
            const existingEmb = await this._getOrComputeEmbedding(existing);
            const similarity = this._cosineSimilarity(newEmb, existingEmb);
            if (similarity > SEMANTIC_THRESHOLD) {
              return {
                added: false,
                skipped: true,
                reason: "semantic duplicate",
              };
            }
          }
        } catch {
          // Semantic dedup failed — fall through
        }
      }
    }

    // ── Add the fact ──
    const index = this._facts.length;
    this._dedupSet.add(normalized);
    this._facts.push(fact);
    if (parsed) {
      this._structuredIndex.set(`${parsed.entity}|||${parsed.relation}`, {
        fact,
        index,
        parsed,
      });
    }
    this._rewriteFile();

    // Auto-compact if over threshold
    let compacted = false;
    if (this._facts.length > this._maxFacts) {
      compacted = true;
      this._compact();
    }

    return { added: true, skipped: false, compacted };
  }

  remove(matchText) {
    const original = this._facts.length;
    this._facts = this._facts.filter((f) => {
      const match = f.toLowerCase().includes(matchText.toLowerCase());
      if (match) {
        this._dedupSet.delete(f.trim().toLowerCase());
      }
      return !match;
    });
    const removed = original - this._facts.length;
    if (removed > 0) {
      this._rebuildIndices();
      // Invalidate cache for removed facts
      for (const key of this._embeddingCache.keys()) {
        if (key.toLowerCase().includes(matchText.toLowerCase())) {
          this._embeddingCache.delete(key);
        }
      }
      this._rewriteFile();
    }
    return { deleted: removed > 0, count: removed };
  }

  /**
   * Update a fact in place. Two-tier matching:
   *  1. Structured key (O(1)): parse oldText, look up (entity, relation)
   *     in _structuredIndex. Handles case/spacing variations via
   *     _parseStructured normalization.
   *  2. Substring fallback (O(N)): matches first fact containing oldText
   *     (after normalizing whitespace).
   *
   * Returns { updated, found, old } — old is the matched fact text
   * so callers can verify the correct fact was updated.
   */
  update(oldText, newText, accounts = []) {
    const normNew = newText.trim();
    const normOld = (oldText || "").trim();

    // Guard: empty/whitespace oldText is ambiguous — reject early
    if (!normOld) {
      return { updated: false, found: false };
    }
    const identityReason = this._identityValidationReason(normNew, undefined, accounts);
    if (identityReason) {
      return { updated: false, found: false, reason: identityReason };
    }

    // ── Tier 1: O(1) structured key lookup ──
    const oldParsed = this._parseStructured(normOld);
    if (oldParsed) {
      const key = `${oldParsed.entity}|||${oldParsed.relation}`;
      const existing = this._structuredIndex.get(key);
      if (existing) {
        const oldFact = existing.fact;
        this._facts[existing.index] = normNew;
        this._embeddingCache.delete(oldFact);
        this._rebuildIndices();
        this._rewriteFile();
        return { updated: true, found: true, old: oldFact };
      }
      // Structured parse succeeded but key not in index —
      // fall through to substring match.
    }

    // ── Tier 2: substring match (handles partial and free-form) ──
    const normOldSubstr = normOld.toLowerCase().replace(/\s+/g, " ");
    for (let i = 0; i < this._facts.length; i++) {
      if (
        this._facts[i]
          .toLowerCase()
          .replace(/\s+/g, " ")
          .includes(normOldSubstr)
      ) {
        const oldFact = this._facts[i];
        this._facts[i] = normNew;
        this._embeddingCache.delete(oldFact);
        this._rebuildIndices();
        this._rewriteFile();
        return { updated: true, found: true, old: oldFact };
      }
    }
    return { updated: false, found: false };
  }

  // ── compaction ───────────────────────────────────────────────

  /**
   * Compact memory: resolve contradictions, deduplicate subsumed facts,
   * and trim to compactTo. Keeps the most specific (longest) facts and
   * the newest ones. For contradictions, newest (last in file) wins.
   */
  compact() {
    const before = this._facts.length;
    this._compact();
    const after = this._facts.length;
    return { before, after, removed: before - after };
  }

  _compact() {
    // Step 0: Resolve structured contradictions — newest wins
    this._resolveContradictions();

    // Step 1: Remove subsumed facts (keep longer version)
    const remaining = [];
    const sorted = [...this._facts].sort((a, b) => b.length - a.length);
    for (const fact of sorted) {
      const lower = fact.toLowerCase();
      const subsumed = remaining.some((r) => r.toLowerCase().includes(lower));
      if (!subsumed) remaining.push(fact);
    }

    // Step 2: Trim to compactTo — remove oldest first
    if (remaining.length > this._compactTo) {
      // Keep payee mappings ("maps to") over general facts
      const mappings = remaining.filter((f) =>
        f.toLowerCase().includes("maps to"),
      );
      const general = remaining.filter(
        (f) => !f.toLowerCase().includes("maps to"),
      );
      // Trim general facts first, then mappings if needed
      let toDrop = remaining.length - this._compactTo;
      const keepGeneral = general.slice(Math.min(toDrop, general.length));
      toDrop -= general.length - keepGeneral.length;
      const keepMappings = mappings.slice(Math.min(toDrop, mappings.length));
      remaining.length = 0;
      remaining.push(...keepGeneral, ...keepMappings);
    }

    this._facts = remaining;
    this._rebuildIndices();
    this._rewriteFile();
  }

  /**
   * Full manual cleanup: resolve structured contradictions and semantic
   * near-duplicates in free-form facts. Returns the contradictions list
   * for review.
   * @returns {Promise<{before: number, after: number, removed: number, contradictions: Array<{old: string, new: string}>}>}
   */
  async cleanup() {
    const before = this._facts.length;
    let changed = false;

    // Step 0: canonicalise suffix facts. Duplicates are NOT dropped here —
    // dropping one spelling before contradiction resolution would change which
    // conflicting mapping survives (last-wins runs over the remaining lines).
    const normalised = this._canonicaliseSuffixFacts();
    if (normalised.count > 0) changed = true;

    // Step 1: Resolve structured contradictions — newest wins
    const structuredContradictions = this._resolveContradictions();

    // Step 2: Semantic dedup on free-form facts
    let freeFormRemoved = 0;
    if (this._model) {
      const kept = [];
      for (const fact of this._facts) {
        // Skip already-structured facts (they were handled in step 1)
        if (this._parseStructured(fact)) {
          kept.push(fact);
          continue;
        }
        let isDup = false;
        try {
          const emb = await this._getOrComputeEmbedding(fact);
          for (let i = 0; i < kept.length; i++) {
            // Only compare free-form to free-form
            if (this._parseStructured(kept[i])) continue;
            const keptEmb = await this._getOrComputeEmbedding(kept[i]);
            if (this._cosineSimilarity(emb, keptEmb) > SEMANTIC_THRESHOLD) {
              isDup = true;
              // Keep the longer fact (more specific)
              if (fact.length > kept[i].length) {
                kept[i] = fact;
              }
              break;
            }
          }
        } catch {
          /* skip on embedding failure */
        }
        if (!isDup) kept.push(fact);
        else freeFormRemoved++;
      }
      this._facts = kept;
    }

    this._rebuildIndices();
    // Exact duplicates of one mapping are only safe to drop AFTER
    // contradiction resolution, so the last-wins choice was already made from
    // the full line set.
    const dropped = this._dropDuplicateSuffixFacts();
    if (dropped > 0) {
      changed = true;
      // The drop removed facts, so the structured index still holds entries
      // whose `index` points past the new array. Rebuilding here is required:
      // `update()` trusts that index and would otherwise overwrite an
      // unrelated fact.
      this._rebuildIndices();
    }
    // Rewriting unconditionally bumps the file mtime on every run, which races
    // the 6-hourly memory backup and makes "did cleanup change anything?"
    // unanswerable. Only write when something actually changed.
    if (changed || before !== this._facts.length) this._rewriteFile();

    const after = this._facts.length;
    return {
      before,
      after,
      removed: before - after,
      normalised: normalised.count,
      contradictions: structuredContradictions,
    };
  }

  /**
   * Remove repeated spellings of one mapping, comparing the PARSED
   * (suffix, account) pair rather than the raw text: two lines can read
   * differently and still mean one mapping.
   *
   * Deliberately separate from canonicalisation so it cannot influence which
   * conflicting mapping wins; call it after `_resolveContradictions`.
   *
   * @returns {number} how many duplicate lines were dropped.
   */
  _dropDuplicateSuffixFacts() {
    const seen = new Set();
    const kept = [];
    let dropped = 0;
    for (const fact of this._facts) {
      const parsed = parseSuffixFact(fact);
      if (!parsed) {
        kept.push(fact);
        continue;
      }
      const key = `${parsed.suffix}|||${parsed.accountName.toLowerCase()}`;
      if (seen.has(key)) {
        dropped++;
        continue;
      }
      seen.add(key);
      kept.push(fact);
    }
    this._facts = kept;
    return dropped;
  }

  /**
   * Rewrite suffix facts to their canonical form.
   *
   * Tolerance reads a "Card/account …" or trailing-full-stop phrasing but never
   * rewrites it, so without this pass the file keeps the spelling a user or
   * Hermes happened to produce. Comparison is on the raw line, so an already
   * canonical fact is left untouched and repeated runs are no-ops.
   *
   * @returns {{count: number}} how many lines were rewritten.
   */
  _canonicaliseSuffixFacts() {
    let count = 0;
    this._facts = this._facts.map((fact) => {
      const parsed = parseSuffixFact(fact);
      if (!parsed) return fact;
      const canonical = canonicalSuffixFact(parsed);
      if (canonical !== fact) count++;
      return canonical;
    });
    return { count };
  }

  /**
   * Resolve structured contradictions in-place.
   * For each (entity, relation) with multiple values, keep the last one
   * (newest, since facts are appended). Returns overwritten facts for logging.
   * @returns {Array<{old: string, new: string}>}
   */
  _resolveContradictions() {
    const contradictions = [];
    const seen = new Map(); // key → { fact, index }

    for (let i = 0; i < this._facts.length; i++) {
      const fact = this._facts[i];
      const parsed = this._parseStructured(fact);
      if (!parsed) continue;

      const key = `${parsed.entity}|||${parsed.relation}`;
      const existing = seen.get(key);
      if (existing && existing.parsed.value !== parsed.value) {
        contradictions.push({ old: existing.fact, new: fact });
      }
      seen.set(key, { fact, index: i, parsed }); // last write wins
    }

    if (contradictions.length > 0) {
      // Rebuild facts: keep all free-form + resolved structured
      const resolved = new Set([...seen.values()].map((s) => s.fact));
      const freeForm = this._facts.filter((f) => !this._parseStructured(f));
      // Merge, preserving original order
      const merged = [];
      for (const f of this._facts) {
        if (resolved.has(f) || freeForm.includes(f)) {
          merged.push(f);
          resolved.delete(f); // only keep first occurrence
        }
      }
      this._facts = merged;
    }

    return contradictions;
  }

  get stats() {
    return {
      count: this._facts.length,
      maxFacts: this._maxFacts,
      compactTo: this._compactTo,
    };
  }

  // ── structured parsing ────────────────────────────────────────

  /**
   * Parse a fact into { entity, relation, value } if it matches a known
   * structured template. Returns null for free-form facts.
   * @param {string} fact
   * @returns {{entity: string, relation: string, value: string} | null}
   */
  _identityValidationReason(fact, parsed = this._parseStructured(fact), accounts = []) {
    if (!parsed) return null;
    if (isMaskedKey(parsed.entity)) return "masked key";
    const suffixKey = /^(?:card|account)\s+ending\s+\d{4,6}$/i.test(parsed.entity);
    // The same matcher the resolver uses, so a key written as a stored account
    // alias ("Nova Card" for "DBS Nova Card") is refused too. Review round 2.
    const accountKey = matchAccountByName(
      parsed.entity,
      accounts,
      accountAliases(this._facts, accounts),
    ).matched;
    if (
      (parsed.relation === "->category" ||
        parsed.relation === "merchant->payee" ||
        parsed.relation === "->payee") &&
      (suffixKey || accountKey)
    ) {
      return "self identity";
    }
    return null;
  }

  _parseStructured(fact) {
    for (const { re, rel } of STRUCTURED_PATTERNS) {
      const m = fact.match(re);
      if (m) {
        const entity = this._normalizeEntity(m[1]);
        let value = m[2].trim().toLowerCase();
        // Normalize: strip trailing " account" — the pattern already
        // ends with "account", so "bank account account" → "bank"
        value = value.replace(/\s+account$/, "");
        value = value
          .replace(/[.,;:!?\s]+$/, "")
          .replace(/\s+/g, " ")
          .trim();
        return { entity, relation: rel, value };
      }
    }
    return null;
  }

  /**
   * Normalize an entity name for comparison: lowercase, strip trailing
   * punctuation/whitespace, collapse multiple spaces.
   * @param {string} name
   * @returns {string}
   */
  _normalizeEntity(name) {
    return name
      .replace(/[.,;:!?\s]+$/, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  // ── index maintenance ─────────────────────────────────────────

  /** Rebuild dedup set and structured index from current facts. */
  _rebuildIndices() {
    this._dedupSet.clear();
    this._structuredIndex.clear();
    for (let i = 0; i < this._facts.length; i++) {
      const fact = this._facts[i];
      this._dedupSet.add(fact.trim().toLowerCase());
      const parsed = this._parseStructured(fact);
      if (parsed) {
        this._structuredIndex.set(`${parsed.entity}|||${parsed.relation}`, {
          fact,
          index: i,
          parsed,
        });
      }
    }
  }

  // ── file I/O ──────────────────────────────────────────────────

  _init() {
    this._ensureFile();
    this._loadFacts();
    this._dedupExisting();
    this._rebuildIndices();
    this._loadModel();
    this._initialized = true;
  }

  // ── dedup ────────────────────────────────────────────────────

  _dedupExisting() {
    const seen = new Set();
    const unique = [];
    for (const f of this._facts) {
      const n = f.trim().toLowerCase();
      if (!seen.has(n)) {
        seen.add(n);
        unique.push(f);
      }
    }
    if (unique.length < this._facts.length) {
      this._facts = unique;
      this._rewriteFile();
    }
  }

  // ── file I/O ──────────────────────────────────────────────────

  _ensureFile() {
    if (!existsSync(this.path)) {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, MEMORY_TEMPLATE);
    }
  }

  _loadFacts() {
    const content = readFileSync(this.path, "utf8");
    let inFacts = false;
    const facts = [];
    for (const line of content.split("\n")) {
      if (line.trim().startsWith("## Facts")) {
        inFacts = true;
        continue;
      }
      if (inFacts && line.trim().startsWith("##")) break;
      if (inFacts && line.trim().startsWith("- ")) {
        facts.push(line.trim().slice(2).trim());
      }
    }
    this._facts = facts;
  }

  _rewriteFile() {
    const tmp = this.path + ".tmp";
    const lines = ["# Long-Term Memory", "", "## Facts", ""];
    for (const f of this._facts) lines.push(`- ${f}`);
    writeFileSync(tmp, lines.join("\n") + "\n");
    try {
      renameSync(tmp, this.path);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch (_) {}
      throw e;
    }
  }

  // ── embedding ─────────────────────────────────────────────────

  _loadModel() {
    this._modelPromise = (async () => {
      try {
        // Use the baked model cache when running in the container (Docker
        // sets TRANSFORMERS_CACHE=/app/.models and pre-downloads the model);
        // otherwise leave transformers' default writable cache so dev/CI do
        // not fail with EACCES on a non-existent /app path.
        if (transformersEnv) {
          if (process.env.TRANSFORMERS_CACHE) {
            transformersEnv.cacheDir = process.env.TRANSFORMERS_CACHE;
          }
          transformersEnv.allowRemoteModels = true;
        }
        this._model = await pipeline(
          "feature-extraction",
          "Xenova/all-MiniLM-L6-v2",
        );
        return true;
      } catch {
        this._model = null;
        return false;
      }
    })();
  }

  /**
   * Mean-pool token embeddings into a single sentence embedding.
   * @param {Float32Array} data - Flattened tensor data
   * @param {number[]} dims - Tensor shape [batch, seqLen, hiddenDim]
   * @returns {number[]} pooled embedding (normalized)
   */
  _meanPool(data, dims) {
    const [, seqLen, dim] = dims;
    const embedding = new Array(dim).fill(0);
    for (let i = 0; i < seqLen; i++) {
      for (let j = 0; j < dim; j++) {
        embedding[j] += data[i * dim + j];
      }
    }
    for (let j = 0; j < dim; j++) {
      embedding[j] /= seqLen;
    }
    return this._normalize(embedding);
  }

  /**
   * L2-normalize a vector in-place.
   * @param {number[]} vec
   * @returns {number[]} the same (now normalized) vector
   */
  _normalize(vec) {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] /= norm;
      }
    }
    return vec;
  }

  /**
   * Cosine similarity between two vectors.
   * @param {number[]} a
   * @param {number[]} b
   * @returns {number} similarity in [0, 1]
   */
  _cosineSimilarity(a, b) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Get or compute the embedding for a text string.
   * Uses cache to avoid recomputation.
   * @param {string} text
   * @returns {Promise<number[]>} normalized embedding vector
   */
  async _getOrComputeEmbedding(text) {
    if (this._embeddingCache.has(text)) {
      return this._embeddingCache.get(text);
    }
    if (!this._model) {
      throw new Error("Model not loaded");
    }
    const output = await this._model(text);
    const embedding = this._meanPool(output.data, output.dims);
    this._embeddingCache.set(text, embedding);
    return embedding;
  }

  async _semanticSearch(query, topK) {
    if (!this._model) return this._substringSearch(query, topK);

    // Compute query embedding
    const queryOutput = await this._model(query);
    const queryEmbedding = this._meanPool(queryOutput.data, queryOutput.dims);

    // Get embeddings for the facts the semantic path can answer (cached). A
    // structured mapping is matched by key, never by similarity, so embedding
    // it only to discard the hit just burns the first query after process
    // start: 159 of 238 live facts were embedded for nothing (#473).
    const results = [];
    for (const fact of this._facts) {
      if (mappingEntity(fact)) continue;
      try {
        const embedding = await this._getOrComputeEmbedding(fact);
        const similarity = this._cosineSimilarity(queryEmbedding, embedding);
        results.push({ text: fact, score: similarity });
      } catch {
        // Skip facts that fail to embed
        results.push({ text: fact, score: 0 });
      }
    }

    // Sort by similarity descending, then keep only what the semantic path is
    // allowed to answer: free-form notes above the floor. A structured merchant
    // mapping is matched by key, never by similarity.
    results.sort((a, b) => b.score - a.score);
    return results
      .filter((r) => this._acceptSemanticHit(r.text, r.score))
      .slice(0, topK)
      .map((r) => ({ ...r, match: "fuzzy" }));
  }

  /**
   * The semantic path exists for free-form notes, not for merchant mappings.
   * Measured against the live fact set, similarity puts a different merchant
   * first for 68 of 159 structured facts, and `AMAZE* GREATEASTERN` scores
   * 0.623 against the `AMAZE* ALIPAYPROGRA SINGAPORE SGP` alert — the wrong
   * booking in #471. A structured fact is therefore never reachable by
   * similarity, and a free-form hit must clear the floor. Issues #420, #471.
   * #472 accepts that a misspelled key can no longer reach its mapping this
   * way and records what a stricter rule would need; see
   * `docs/design.md`, "Merchant matching: keys, not similarity".
   */
  _acceptSemanticHit(fact, score) {
    if (mappingEntity(fact)) return false;
    return score >= SEARCH_MIN_SIMILARITY;
  }

  _substringSearch(query, topK) {
    const q = query.toLowerCase();
    const forward = [];
    const reverse = [];
    for (const f of this._facts) {
      const entity = mappingEntity(f);
      // Category resolution queries a payee. Only its own category mapping is
      // authoritative: a different entity containing the same words (for
      // example "Maxis Fibre" for "Utilities") must not win by file order.
      if (entity === q) {
        forward.push({ text: f, score: 1.0, match: "exact", ownEntity: true });
        continue;
      }
      if (f.toLowerCase().includes(q)) {
        forward.push({ text: f, score: 1.0, match: "exact", ownEntity: false });
        continue;
      }
      // The merchant carries words the stored key does not — a location suffix,
      // a terminal id. When the key still names it, this is an exact match.
      if (
        entity &&
        entity.length >= MIN_ENTITY_LENGTH &&
        containsWord(q, entity)
      ) {
        reverse.push({
          text: f,
          score: 1.0,
          match: "exact",
          specificity: entity.length,
        });
      }
    }
    // Prefer the mapping whose entity exactly equals the query. A longer entity
    // is the more specific match only among merchant-key reverse matches.
    forward.sort((a, b) => Number(b.ownEntity) - Number(a.ownEntity));
    reverse.sort((a, b) => b.specificity - a.specificity);
    return [...forward, ...reverse]
      .slice(0, topK)
      .map(({ specificity, ownEntity, ...result }) => result);
  }

  // ── migration ─────────────────────────────────────────────────

  static migrateFromMappings(mappingsPath, memoryPath) {
    if (!existsSync(mappingsPath)) {
      mkdirSync(dirname(memoryPath), { recursive: true });
      writeFileSync(memoryPath, MEMORY_TEMPLATE);
      return;
    }
    try {
      const data = JSON.parse(readFileSync(mappingsPath, "utf8"));
      const facts = [];
      for (const [name, type] of Object.entries(data.accounts || {})) {
        facts.push(`- ${name} is a ${type} account`);
      }
      for (const [keyword, payee] of Object.entries(data.payees || {})) {
        facts.push(`- ${keyword} merchant maps to ${payee} payee`);
      }
      for (const [keyword, cat] of Object.entries(data.categories || {})) {
        facts.push(`- ${keyword} maps to ${cat} category`);
      }
      const lines = ["# Long-Term Memory", "", "## Facts", "", ...facts, ""];
      mkdirSync(dirname(memoryPath), { recursive: true });
      writeFileSync(memoryPath, lines.join("\n"));
    } catch {
      mkdirSync(dirname(memoryPath), { recursive: true });
      writeFileSync(memoryPath, MEMORY_TEMPLATE);
    }
  }
}
