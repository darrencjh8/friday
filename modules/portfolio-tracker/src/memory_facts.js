/**
 * FactsMemory — semantic facts/password store for the portfolio tracker.
 *
 * Ported from the expense-tracker MemoryStore (src/memory.js). Backs a
 * human-readable MEMORY.md file with all-MiniLM-L6-v2 WASM embeddings for
 * semantic search, falling back to substring search when the model is absent.
 *
 * This is SEPARATE from the legacy data/mappings.json store (src/memory.js,
 * class MemoryStore) used for security/account/broker mappings — both coexist.
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

const MEMORY_TEMPLATE = `# Long-Term Memory

## Facts

`;

/** @type {Array<{re: RegExp, rel: string}>} */
const STRUCTURED_PATTERNS = [
  // Password facts are keyed by entity (broker) so distinct brokers' passwords
  // are never deduped against each other by semantic similarity. e.g.
  // "IBKR eStatement PDF password is ABCD1234" → entity "ibkr estatement pdf".
  { re: /^(.+?)\s+password\s+(?:is|=|:)\s*(.+)$/i, rel: "password" },
  {
    re: /^(.+?)\s+merchant\s+maps\s+to\s+(.+?)\s+payee$/i,
    rel: "merchant->payee",
  },
  { re: /^(.+?)\s+maps\s+to\s+(.+?)\s+payee$/i, rel: "->payee" },
  { re: /^(.+?)\s+maps\s+to\s+(.+?)\s+category$/i, rel: "->category" },
  { re: /^(.+?)\s+is\s+(?:a|an)\s+(.+?)\s+account$/i, rel: "is-account" },
];

/** Semantic-dedup cosine-similarity threshold for free-form facts. */
const SEMANTIC_THRESHOLD = 0.88;

export class FactsMemory {
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
   * Used after external writes to the MEMORY.md file.
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
    try {
      return await this._semanticSearch(query, topK);
    } catch {
      return this._substringSearch(query, topK);
    }
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
  async add(fact) {
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
        if (parsed.relation === "password") {
          // Passwords rotate — last write wins. Overwrite in place so a
          // freshly-learned password replaces the stale one.
          const oldFact = existing.fact;
          this._dedupSet.delete(oldFact.toLowerCase());
          this._facts[existing.index] = fact;
          this._dedupSet.add(normalized);
          this._structuredIndex.set(key, {
            fact,
            index: existing.index,
            parsed,
          });
          this._rewriteFile();
          return { added: true, updated: true, old: oldFact };
        }
        // Other relations — safe mode: keep the existing fact, skip the new one.
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
  update(oldText, newText) {
    const normNew = newText.trim();
    const normOld = (oldText || "").trim();

    // Guard: empty/whitespace oldText is ambiguous — reject early
    if (!normOld) {
      return { updated: false, found: false };
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
    this._rewriteFile();

    const after = this._facts.length;
    return {
      before,
      after,
      removed: before - after,
      contradictions: structuredContradictions,
    };
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
        const { pipeline, env } = await import("@xenova/transformers");
        // Use the baked model cache (Dockerfile pre-downloads here) for
        // offline-safe, deterministic runtime; remote download remains a
        // fallback when the cache is missing.
        if (env) {
          env.cacheDir = process.env.TRANSFORMERS_CACHE || "/app/.models";
          env.allowRemoteModels = true;
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

    // Get embeddings for all facts (cached)
    const results = [];
    for (const fact of this._facts) {
      try {
        const embedding = await this._getOrComputeEmbedding(fact);
        const similarity = this._cosineSimilarity(queryEmbedding, embedding);
        results.push({ text: fact, score: similarity });
      } catch {
        // Skip facts that fail to embed
        results.push({ text: fact, score: 0 });
      }
    }

    // Sort by similarity descending
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  _substringSearch(query, topK) {
    const q = query.toLowerCase();
    const results = [];
    for (const f of this._facts) {
      if (f.toLowerCase().includes(q)) {
        results.push({ text: f, score: 1.0 });
      }
    }
    return results.slice(0, topK);
  }
}
