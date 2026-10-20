/**
 * WikiKnowledgeStore — the expense-tracker's read-only view of the wiki
 * (issue #783, Phase 1).
 *
 * The finance pages under the wiki's `entities/accounts/` are the single
 * authority for merchant, payee, category, people, account-type and suffix
 * facts. This store parses their tables back into the same fact sentences the
 * old MEMORY.md held ("X maps to Y payee", "Card ending N belongs to A",
 * "A is a credit card account"), so every existing parser and resolver keeps
 * working unchanged and `search_memory` stays compatible.
 *
 * It never writes the wiki. A write (learn/update/delete) becomes a proposal
 * appended to a JSONL queue for review; the wiki changes only through an
 * approved writer in Hermes.
 *
 * Statement passwords are not in the wiki. Until email-intake decrypts
 * statements itself, `legacyPasswordPath` serves ONLY the password facts of the
 * old MEMORY.md so statement processing does not regress; every other legacy
 * fact is ignored.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "fs";
import { dirname, join } from "path";
import { MemoryStore } from "./memory.js";

/** Wiki pages this store reads, relative to the accounts directory. */
export const WIKI_PAGES = [
  "merchant-payee-mappings.md",
  "payee-categories.md",
  "people-transfers.md",
  "card-suffix-mappings.md",
  "banks-cards.md",
];

const SECRET_RE = /password|passcode|passwd|\bpin\b|\bnric\b|\bdob\b|date of birth/i;
const PROPOSAL = "proposal_queued";

/** Cells of a markdown table row, trimmed; null for a non-row or separator. */
function cells(line) {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return null;
  const parts = t.slice(1, -1).split("|").map((c) => c.trim());
  if (parts.every((c) => /^:?-+:?$/.test(c))) return null;
  return parts;
}

/** Strip the backticks that mark an exact key. */
const key = (s) => s.replace(/^`(.*)`$/, "$1").trim();

/** Rows of every table whose header starts with `firstHeader`. */
function tableRows(text, firstHeader) {
  const rows = [];
  let inTable = false;
  let header = null;
  for (const line of text.split("\n")) {
    const c = cells(line);
    if (!line.trim().startsWith("|")) {
      inTable = false;
      header = null;
      continue;
    }
    if (!header) {
      header = c;
      inTable = !!c && c[0].toLowerCase() === firstHeader.toLowerCase();
      continue;
    }
    if (inTable && c) rows.push(c);
  }
  return rows;
}

/**
 * Rows of every table whose header starts with `firstHeader`, as objects keyed
 * by the lower-cased header text, so an optional column can sit anywhere and a
 * row written before the column existed simply lacks it.
 */
function tableRecords(text, firstHeader) {
  const out = [];
  let header = null;
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) {
      header = null;
      continue;
    }
    const c = cells(line);
    if (!header) {
      header = c || [];
      continue;
    }
    if (!c || header[0]?.toLowerCase() !== firstHeader.toLowerCase()) continue;
    out.push(Object.fromEntries(header.map((h, i) => [h.toLowerCase(), c[i] ?? ""])));
  }
  return out;
}

/**
 * `SGD 1,200.5` -> `SGD 1200.50`; null for anything else. The fact keeps two
 * decimals so `incomingRule` in the orchestrator can compare it to cents.
 */
function incomingAmount(cell) {
  const m = String(cell || "").trim().match(/^([A-Za-z]{3})\s*([\d,]+(?:\.\d{1,2})?)$/);
  if (!m) return null;
  const value = Number(m[2].replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? `${m[1].toUpperCase()} ${value.toFixed(2)}` : null;
}

/** Bullets in a `## heading` section, with markdown emphasis removed. */
function sectionBullets(text, heading) {
  const out = [];
  let inSection = false;
  for (const line of text.split("\n")) {
    if (/^##\s/.test(line)) {
      inSection = line.replace(/^##\s+/, "").trim().toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (inSection && /^\s*-\s+/.test(line)) {
      out.push(
        line
          .replace(/^\s*-\s+/, "")
          .replace(/^\(L\d+\)\s*/, "")
          .replace(/\*\*/g, "")
          .replace(/`/g, "")
          .trim(),
      );
    }
  }
  return out;
}

const article = (word) => (/^[aeiou]/i.test(word) ? "an" : "a");
const active = (status) => String(status || "").toLowerCase() !== "rejected";

/**
 * Fact sentences for the accounts pages under `wikiDir`.
 * @param {string} wikiDir
 * @returns {string[]}
 */
export function wikiFacts(wikiDir) {
  const read = (name) => {
    const p = join(wikiDir, name);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  };
  const facts = [];

  const merchants = read("merchant-payee-mappings.md");
  facts.push(...sectionBullets(merchants, "Routing rules"));
  for (const [k, payee, override, status] of tableRows(merchants, "Merchant key")) {
    if (!active(status) || !k || !payee) continue;
    facts.push(`${key(k)} maps to ${payee} payee`);
    if (override) facts.push(`${key(k)} maps to ${override} category`);
  }

  for (const [payee, category, status] of tableRows(read("payee-categories.md"), "Payee")) {
    if (active(status) && payee && category) facts.push(`${payee} maps to ${category} category`);
  }

  // A row with an "Incoming amount" is a rule for a credit of exactly that
  // amount from that sender, and nothing else: the same sender sending another
  // amount stays Misc. An amount that does not parse adds no fact at all.
  for (const row of tableRecords(read("people-transfers.md"), "Name in descriptor")) {
    const name = row["name in descriptor"];
    const { payee, category } = row;
    if (!name || !payee) continue;
    const amountCell = row["incoming amount"];
    let subject = name;
    if (amountCell) {
      const amount = incomingAmount(amountCell);
      if (!amount) continue;
      subject = `Incoming ${amount} from ${name}`;
    }
    facts.push(`${subject} maps to ${payee} payee`);
    if (category) facts.push(`${subject} maps to ${category} category`);
  }

  const suffix = read("card-suffix-mappings.md");
  for (const [n, account] of tableRows(suffix, "Card ending")) {
    if (/^\d{4,6}$/.test(n) && account) facts.push(`Card ending ${n} belongs to ${account}`);
  }
  for (const [n, account] of tableRows(suffix, "Account ending")) {
    if (/^\d{4,6}$/.test(n) && account) facts.push(`Account ending ${n} belongs to ${account}`);
  }

  for (const [name, type, status] of tableRows(read("banks-cards.md"), "Name")) {
    if (!active(status) || !name || !type) continue;
    const base = type.replace(/\s*\(.*\)\s*$/, "").replace(/\s+account$/i, "").trim();
    if (base) facts.push(`${name} is ${article(base)} ${base} account`);
  }

  return facts.filter((f) => !SECRET_RE.test(f));
}

/** Password facts only, from the legacy MEMORY.md. */
function legacyPasswordFacts(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().startsWith("- "))
    .map((l) => l.trim().slice(2).trim())
    .filter((f) => /password/i.test(f));
}

export class WikiKnowledgeStore extends MemoryStore {
  /**
   * @param {{wikiDir: string, proposalsPath: string, legacyPasswordPath?: string}} opts
   */
  constructor(opts) {
    // MemoryStore's constructor loads facts before a subclass body runs, so the
    // options travel in `path`, the only field it sets first.
    super(opts);
  }

  get _opts() {
    return this.path;
  }

  // ── read side ────────────────────────────────────────────────

  _ensureFile() {}

  _rewriteFile() {}

  _loadFacts() {
    const { wikiDir, legacyPasswordPath } = this._opts;
    this._facts = [...wikiFacts(wikiDir), ...legacyPasswordFacts(legacyPasswordPath)];
    this._signature = this._currentSignature();
  }

  /** mtime + size of every source file; a change invalidates the facts. */
  _currentSignature() {
    const { wikiDir, legacyPasswordPath } = this._opts;
    const files = WIKI_PAGES.map((p) => join(wikiDir, p));
    if (legacyPasswordPath) files.push(legacyPasswordPath);
    return files
      .map((f) => {
        try {
          const s = statSync(f);
          return `${s.mtimeMs}:${s.size}`;
        } catch {
          return "-";
        }
      })
      .join("|");
  }

  _refreshIfChanged() {
    if (this._currentSignature() !== this._signature) {
      this.reload();
      this._embeddingCache.clear();
    }
  }

  listFacts() {
    this._refreshIfChanged();
    return super.listFacts();
  }

  async search(query, topK = 5) {
    this._refreshIfChanged();
    return super.search(query, topK);
  }

  // ── write side: proposals only ───────────────────────────────

  /** True when an identical proposal is already waiting in the queue. */
  _queued(entry) {
    const { proposalsPath } = this._opts;
    if (!existsSync(proposalsPath)) return false;
    const want = JSON.stringify({ ...entry, fact: entry.fact?.toLowerCase() });
    return readFileSync(proposalsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .some((line) => {
        try {
          const { at, ...rest } = JSON.parse(line);
          return JSON.stringify({ ...rest, fact: rest.fact?.toLowerCase() }) === want;
        } catch {
          return false;
        }
      });
  }

  _queue(entry) {
    if (this._queued(entry)) return;
    const { proposalsPath } = this._opts;
    mkdirSync(dirname(proposalsPath), { recursive: true });
    appendFileSync(
      proposalsPath,
      JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n",
    );
  }

  async add(fact) {
    fact = String(fact || "").trim();
    if (!fact) return { added: false, skipped: false, reason: "empty fact" };
    if (SECRET_RE.test(fact)) return { added: false, skipped: true, reason: "secret_refused" };
    const lower = fact.toLowerCase();
    if (this.listFacts().some((f) => f.toLowerCase() === lower)) {
      return { added: false, skipped: true, reason: "duplicate" };
    }
    this._queue({ op: "add", fact });
    return { added: false, skipped: true, reason: PROPOSAL };
  }

  update(oldText, newText) {
    if (SECRET_RE.test(`${oldText} ${newText}`)) {
      return { updated: false, found: false, reason: "secret_refused" };
    }
    this._queue({ op: "update", old: oldText, fact: newText });
    return { updated: false, found: false, reason: PROPOSAL };
  }

  remove(matchText) {
    if (SECRET_RE.test(String(matchText))) {
      return { deleted: false, count: 0, reason: "secret_refused" };
    }
    this._queue({ op: "remove", match: matchText });
    return { deleted: false, count: 0, reason: PROPOSAL };
  }

  compact() {
    const n = this.listFacts().length;
    return { before: n, after: n, removed: 0 };
  }

  async cleanup() {
    const n = this.listFacts().length;
    return { before: n, after: n, removed: 0, normalised: 0, contradictions: [] };
  }
}

/**
 * The knowledge store for this process: the wiki when `wikiDir` is set, else
 * the legacy MEMORY.md store (with its one-time mappings.json migration).
 * @param {{wikiDir?: string, wikiProposalsPath?: string, memoryPath: string}} cfg
 * @param {{mappingsPath?: string, onMigrate?: () => void}} [opts]
 */
export function createKnowledgeStore(cfg, { mappingsPath = "data/mappings.json", onMigrate } = {}) {
  if (cfg.wikiDir) {
    return new WikiKnowledgeStore({
      wikiDir: cfg.wikiDir,
      proposalsPath: cfg.wikiProposalsPath || "data/wiki-proposals.jsonl",
      legacyPasswordPath: cfg.memoryPath,
    });
  }
  const memory = new MemoryStore(cfg.memoryPath);
  if (memory.listFacts().length === 0 && existsSync(mappingsPath)) {
    onMigrate?.();
    MemoryStore.migrateFromMappings(mappingsPath, cfg.memoryPath);
    // Reload after migration (avoids second WASM model load)
    memory.reload();
  }
  return memory;
}
