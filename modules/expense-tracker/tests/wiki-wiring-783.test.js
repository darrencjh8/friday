/**
 * Issue #783 Phase 1 wiring: with WIKI_DIR set the tracker reads the wiki
 * through WikiKnowledgeStore, exposes `search_wiki`, and a /remember answer
 * still confirms (the wiki row itself is written by Hermes).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("@xenova/transformers", () => ({
  pipeline: vi.fn().mockRejectedValue(new Error("no model in tests")),
  env: {},
}));

import { Config } from "../src/config.js";
import { createKnowledgeStore, WikiKnowledgeStore } from "../src/wiki-knowledge.js";
import { MemoryStore } from "../src/memory.js";
import { ToolRegistry } from "../src/tools.js";
import { toolShapes } from "../src/mcp-server.js";

const REQUIRED_ENV = {
  IMAP_HOST: "h",
  IMAP_USERNAME: "u",
  IMAP_PASSWORD: "p",
  ACTUAL_BUDGET_URL: "http://a",
  ACTUAL_BUDGET_PASSWORD: "p",
  ACTUAL_PRIMARY_BUDGET_FILE: "b",
  ACTUAL_PRIMARY_CURRENCY: "SGD",
  NOTIFY_URL: "http://n",
  HERMES_WEBHOOK_SECRET: "s",
};

const PAGE = `---
title: Merchant to payee mappings
---
# Merchant to payee mappings

| Merchant key | Payee | Category override | Status | Source |
|---|---|---|---|---|
| \`Alpha Cafe\` | Food |  | confirmed | L1 |
`;

describe("wiki wiring (#783)", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wiki-wiring-"));
    mkdirSync(join(root, "accounts"));
    writeFileSync(join(root, "accounts", "merchant-payee-mappings.md"), PAGE);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads WIKI_DIR and the proposal queue path from the environment", () => {
    const cfg = new Config({
      ...REQUIRED_ENV,
      WIKI_DIR: "/wiki/accounts",
      WIKI_PROPOSALS_PATH: "/data/q.jsonl",
    });

    expect(cfg.wikiDir).toBe("/wiki/accounts");
    expect(cfg.wikiProposalsPath).toBe("/data/q.jsonl");
  });

  it("defaults to no wiki, so local runs keep the MEMORY.md store", () => {
    const cfg = new Config({ ...REQUIRED_ENV });

    expect(cfg.wikiDir).toBe("");
    expect(cfg.wikiProposalsPath).toBe("data/wiki-proposals.jsonl");
  });

  it("builds the wiki store when WIKI_DIR is set, with legacy passwords only", () => {
    const store = createKnowledgeStore({
      wikiDir: join(root, "accounts"),
      wikiProposalsPath: join(root, "q.jsonl"),
      memoryPath: join(root, "MEMORY.md"),
    });

    expect(store).toBeInstanceOf(WikiKnowledgeStore);
    expect(store._opts.legacyPasswordPath).toBe(join(root, "MEMORY.md"));
    expect(store.listFacts()).toContain("Alpha Cafe maps to Food payee");
  });

  it("builds the MEMORY.md store when WIKI_DIR is unset", () => {
    const store = createKnowledgeStore({ wikiDir: "", memoryPath: join(root, "MEMORY.md") });

    expect(store).toBeInstanceOf(MemoryStore);
    expect(store).not.toBeInstanceOf(WikiKnowledgeStore);
  });

  it("exposes search_wiki with the same results as search_memory", async () => {
    const store = createKnowledgeStore({
      wikiDir: join(root, "accounts"),
      wikiProposalsPath: join(root, "q.jsonl"),
      memoryPath: join(root, "MEMORY.md"),
    });
    const registry = new ToolRegistry({}, store);

    const wiki = await registry.executeTool("search_wiki", { query: "Alpha Cafe" });
    const legacy = await registry.executeTool("search_memory", { query: "Alpha Cafe" });

    expect(wiki.results[0].text).toBe("Alpha Cafe maps to Food payee");
    expect(wiki).toEqual(legacy);
    expect(registry.getToolSchemas().map((t) => t.name ?? t.function?.name)).toContain("search_wiki");
    expect(toolShapes.search_wiki).toBeDefined();
  });

  it("confirms a /remember answer when the store queues it as a proposal", async () => {
    const store = createKnowledgeStore({
      wikiDir: join(root, "accounts"),
      wikiProposalsPath: join(root, "q.jsonl"),
      memoryPath: join(root, "MEMORY.md"),
    });
    const registry = new ToolRegistry(
      { pendingLearningPath: join(root, "pending.json") },
      store,
    );
    registry._identityAccounts = async () => [];
    const id = registry._pendingLearning.offer({ descriptor: "Beta Bar", payee: "Drinks" });

    const result = await registry._confirmLearning(id);

    expect(result).toMatchObject({ confirmed: true, fact: "Beta Bar maps to Drinks payee" });
    expect(registry._pendingLearning.get(id)).toBeFalsy();
    const queued = JSON.parse(readFileSync(join(root, "q.jsonl"), "utf8").trim());
    expect(queued).toMatchObject({ op: "add", fact: "Beta Bar maps to Drinks payee" });
  });
});
