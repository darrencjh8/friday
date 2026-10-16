/**
 * Tests for FactsMemory — the portfolio-tracker semantic facts/password store.
 * Separate from the legacy mappings.json MemoryStore (memory.js).
 *
 * @xenova/transformers is mocked with deterministic char-bigram embeddings so
 * tests are fast and offline (mirrors expense-tracker/tests/memory.test.js).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("@xenova/transformers", () => {
  function bigramEmbed(text, dim = 16) {
    const emb = new Float32Array(dim);
    for (let i = 0; i < text.length - 1; i++) {
      const bigram = text.charCodeAt(i) * 256 + text.charCodeAt(i + 1);
      emb[Math.abs(bigram) % dim] += 0.1;
    }
    return emb;
  }
  return {
    env: {},
    pipeline: vi.fn().mockResolvedValue(async (text) => ({
      data: bigramEmbed(text),
      dims: [1, 1, 16],
    })),
  };
});

import { FactsMemory } from "../src/memory_facts.js";

function tempFile(suffix, content) {
  const p = join(
    tmpdir(),
    `pt-facts-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`,
  );
  if (content !== undefined) writeFileSync(p, content);
  return p;
}

describe("FactsMemory", () => {
  let memPath;
  let mappingsPath;
  let created;

  beforeEach(() => {
    created = [];
    memPath = tempFile(
      ".md",
      "# Long-Term Memory\n\n## Facts\n\n" +
        "- IBKR eStatement PDF password is ABCD1234\n" +
        "- POEMS monthly statement password is poemsPass99\n" +
        "- US0378331005 maps to sec-aapl security\n",
    );
    mappingsPath = tempFile(
      ".json",
      JSON.stringify({ securities: { foo: "bar" } }),
    );
    created.push(memPath, mappingsPath);
  });

  afterEach(() => {
    for (const p of created) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {}
    }
  });

  it("loads existing facts from MEMORY.md", () => {
    const m = new FactsMemory(memPath);
    expect(m.listFacts().length).toBe(3);
  });

  it("search returns the password fact for a broker keyword", async () => {
    const m = new FactsMemory(memPath);
    await m.ready();
    const results = await m.search("IBKR");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.text.includes("ABCD1234"))).toBe(true);
  });

  it("search respects topK and returns scored, sorted results", async () => {
    const m = new FactsMemory(memPath);
    await m.ready();
    const results = await m.search("password", 2);
    expect(results.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("add persists a new fact to MEMORY.md and is findable", async () => {
    const m = new FactsMemory(memPath);
    await m.ready();
    const res = await m.add("CDP statement password is cdpSecret77");
    expect(res.added).toBe(true);
    const onDisk = readFileSync(memPath, "utf8");
    expect(onDisk).toContain("cdpSecret77");
    const found = await m.search("CDP");
    expect(found.some((r) => r.text.includes("cdpSecret77"))).toBe(true);
  });

  it("dedups exact-duplicate facts", async () => {
    const m = new FactsMemory(memPath);
    await m.ready();
    const res = await m.add("IBKR eStatement PDF password is ABCD1234");
    expect(res.added).toBe(false);
    expect(res.skipped).toBe(true);
  });

  it("rotates a broker password (last write wins)", async () => {
    const m = new FactsMemory(memPath);
    await m.ready();
    const res = await m.add("IBKR eStatement PDF password is NEWPASS999");
    expect(res.added).toBe(true);
    expect(res.updated).toBe(true);
    const facts = m.listFacts();
    expect(facts.some((f) => f.includes("NEWPASS999"))).toBe(true);
    expect(facts.some((f) => f.includes("ABCD1234"))).toBe(false);
    // and only one IBKR password fact remains
    const ibkr = facts.filter((f) => /IBKR.*password/i.test(f));
    expect(ibkr.length).toBe(1);
  });

  it("keeps a different broker's password when rotating one", async () => {
    const m = new FactsMemory(memPath);
    await m.ready();
    await m.add("IBKR eStatement PDF password is NEWPASS999");
    const facts = m.listFacts();
    expect(facts.some((f) => f.includes("poemsPass99"))).toBe(true);
  });

  it("does not touch the legacy mappings.json store", async () => {
    const before = readFileSync(mappingsPath, "utf8");
    const m = new FactsMemory(memPath);
    await m.ready();
    await m.add("DBS Vickers statement password is dbsv123");
    const after = readFileSync(mappingsPath, "utf8");
    expect(after).toBe(before);
  });

  it("falls back to substring search when the model fails to load", async () => {
    const m = new FactsMemory(memPath);
    // Force model-not-loaded path
    m._model = null;
    if (m._modelPromise) m._modelPromise = Promise.resolve(false);
    const results = await m.search("poemsPass99");
    expect(results.some((r) => r.text.includes("poemsPass99"))).toBe(true);
  });
});
