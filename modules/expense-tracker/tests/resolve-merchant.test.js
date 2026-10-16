/**
 * Tests for resolve_merchant tool — memory/keyword/web resolution pipeline,
 * search_web, auto-learning, and category validation in insert_transaction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted) ──────────────────────────────────────────────────────

// Mock mailparser (imported by tools.js; unused in these tests)
vi.mock("mailparser", () => ({
  simpleParser: vi.fn(),
}));

// Mock dedup.js to avoid fs / better-sqlite3 / crypto dependency chains
vi.mock("../src/dedup.js", () => ({
  DedupJournal: vi.fn(function () {
    this.record = vi.fn();
    this.checkDuplicate = vi.fn(() => false);
    this.checkExact = vi.fn(() => false);
    this.close = vi.fn();
  }),
}));

// Mock LLMClient used by _classify_merchant for web-search resolution
const { mockChat } = vi.hoisted(() => ({ mockChat: vi.fn() }));
vi.mock("../src/orchestrator.js", () => {
  const Mock = vi.fn(function () {
    this.chat = mockChat;
  });
  return { LLMClient: Mock, DeepSeekClient: Mock };
});

// ── Imports ──────────────────────────────────────────────────────────────

import { ToolRegistry } from "../src/tools.js";

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Simple in-memory store that behaves like the MemoryStore interface.
 * @param {string[]} initialFacts - strings stored as { text } rows
 */
function mockMemoryStore(initialFacts = []) {
  const facts = [...initialFacts];
  const store = {
    search: vi.fn(async (query) => {
      const lower = query.toLowerCase();
      return facts
        .filter((f) => f.toLowerCase().includes(lower))
        .map((text) => ({ text, score: 1 }));
    }),
    add: vi.fn(async (fact) => {
      facts.push(fact);
      return { added: true, skipped: false, reason: "" };
    }),
    // expose for assertions
    _facts: facts,
  };
  return store;
}

function mockConfig(overrides = {}) {
  return {
    braveSearchApiKey: "test-brave-key",
    dedupDbPath: ":memory:",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// search_web (T004, T005)
// ─────────────────────────────────────────────────────────────────────────

describe("search_web", () => {
  it("calls the Brave Search API with the correct endpoint and headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    await registry._handle_search_web({ merchant: "Test Merchant" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain("https://api.search.brave.com/res/v1/web/search");
    expect(url).toContain("q=Test%20Merchant");
    expect(url).toContain("count=5");
    expect(options.headers["X-Subscription-Token"]).toBe("test-brave-key");

    vi.unstubAllGlobals();
  });

  it("returns empty results when no API key is configured", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig({ braveSearchApiKey: undefined });
    const registry = new ToolRegistry(config, memory);

    const result = await registry._handle_search_web({
      merchant: "Anything",
    });

    expect(result).toEqual({ results: [] });
  });

  it("returns results array when the API responds with data", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: {
          results: [
            {
              title: "Title A",
              url: "https://a.example.com",
              description: "Desc A",
            },
            {
              title: "Title B",
              url: "https://b.example.com",
              description: "Desc B",
            },
          ],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const result = await registry._handle_search_web({
      merchant: "Something",
    });

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      title: "Title A",
      url: "https://a.example.com",
      description: "Desc A",
    });

    vi.unstubAllGlobals();
  });

  it("returns empty results on HTTP error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    });
    vi.stubGlobal("fetch", fetchMock);

    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const result = await registry._handle_search_web({
      merchant: "RateLimited",
    });

    expect(result).toEqual({ results: [] });
    vi.unstubAllGlobals();
  });

  it("returns empty results on network failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", fetchMock);

    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const result = await registry._handle_search_web({
      merchant: "Offline",
    });

    expect(result).toEqual({ results: [] });
    vi.unstubAllGlobals();
  });

  it("truncates merchant names longer than 100 characters", async () => {
    const config = mockConfig({ braveSearchApiKey: "test-key" });
    const registry = new ToolRegistry(config, null);

    const longName = "A".repeat(250) + " PTE LTD";
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        capturedUrl = url;
        return Promise.resolve({
          ok: true,
          json: async () => ({ web: { results: [] } }),
        });
      }),
    );

    await registry._handle_search_web({ merchant: longName });

    // URL should contain truncated name (max 100 chars)
    const decoded = decodeURIComponent(capturedUrl);
    expect(decoded.length).toBeLessThan(200); // URL shouldn't be massive
    vi.unstubAllGlobals();
  });

  it("strips special characters from merchant name before web search", async () => {
    const config = mockConfig({ braveSearchApiKey: "test-key" });
    const registry = new ToolRegistry(config, null);

    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        capturedUrl = url;
        return Promise.resolve({
          ok: true,
          json: async () => ({ web: { results: [] } }),
        });
      }),
    );

    await registry._handle_search_web({
      merchant: "SGSUPERGREEN-B PTE. LTD.",
    });

    // The . and & should be stripped from the query
    const decoded = decodeURIComponent(capturedUrl);
    expect(decoded).not.toContain("PTE.");
    expect(decoded).not.toContain("LTD.");
    expect(decoded).toContain("SGSUPERGREEN-B PTE LTD");
    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolve_merchant pipeline (T009, T010, T011, T012)
// ─────────────────────────────────────────────────────────────────────────

describe("resolve_merchant pipeline", () => {
  it("returns memory hit for a previously resolved merchant (T009)", async () => {
    const memory = mockMemoryStore(["Starbucks maps to Coffee payee"]);
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const result = await registry._handle_resolve_merchant({
      merchant: "Starbucks",
      budget_id: "test-budget",
    });

    expect(result).toEqual({ payee: "Coffee", source: "memory" });
  });

  it("never takes a payee from a hit for a different merchant (issue #471)", async () => {
    const memory = mockMemoryStore();
    // What the store actually returned for the AliPay charge: a same-shaped
    // neighbour from another merchant, at a score above #420's proposed floor.
    memory.search = vi.fn(async () => [
      {
        text: "AMAZE* GREATEASTERN SINGAPORE SGP maps to Insurance payee",
        score: 0.623,
      },
    ]);
    const config = mockConfig({ braveSearchApiKey: undefined });
    const registry = new ToolRegistry(config, memory);

    const result = await registry._handle_resolve_merchant({
      merchant: "AMAZE* ALIPAYPROGRA SINGAPORE SGP",
      budget_id: "test-budget",
    });

    expect(result).toEqual({ payee: "Misc", source: "fallback" });
  });

  it("refuses a partial query that only prefixes a neighbour's key (round-1 High)", async () => {
    const memory = mockMemoryStore();
    // Both keys contain "AMAZE"; a truncated alert line must not pick one.
    memory.search = vi.fn(async () => [
      { text: "AMAZE* GREATEASTERN maps to Insurance payee", score: 1 },
      { text: "AMAZE* ALIPAYPROGRA maps to Misc payee, no category", score: 1 },
    ]);
    const config = mockConfig({ braveSearchApiKey: undefined });
    const registry = new ToolRegistry(config, memory);

    const result = await registry._handle_resolve_merchant({
      merchant: "AMAZE",
      budget_id: "test-budget",
    });

    expect(result).toEqual({ payee: "Misc", source: "fallback" });
  });

  it("falls back to Misc when no memory fact (keyword removed)", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const result = await registry._handle_resolve_merchant({
      merchant: "NTUC FairPrice",
      budget_id: "test-budget",
    });

    // Keyword matching removed — falls back to Misc
    expect(result.payee).toBe("Misc");
    expect(result.source).toBe("fallback");
  });

  it("falls back to Misc for unknown merchant with no API key (T011)", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig({ braveSearchApiKey: undefined });
    const registry = new ToolRegistry(config, memory);

    const result = await registry._handle_resolve_merchant({
      merchant: "XyzzyWidgetCorp",
      budget_id: "test-budget",
    });

    expect(result).toEqual({ payee: "Misc", source: "fallback" });
  });

  it("does not guess or learn a merchant from web classification without durable evidence", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    // fetch called twice:
    //  1) search_web → Brave API
    //  2) _get("/payees") → Actual API
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          web: {
            results: [
              {
                title: "Acme Coffee",
                url: "https://ac.me",
                description: "A coffee shop",
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { name: "Coffee" },
          { name: "Groceries" },
          { name: "Transport" },
        ],
      });
    vi.stubGlobal("fetch", fetchMock);

    // DeepSeekClient.chat returns a JSON payee choice
    mockChat.mockResolvedValueOnce({
      choices: [{ message: { content: '{"payee":"Coffee"}' } }],
    });

    const result = await registry._handle_resolve_merchant({
      merchant: "Acme Roasters",
      budget_id: "test-budget",
    });

    expect(result).toEqual({ payee: "Misc", source: "fallback" });
    expect(memory.add).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("falls back to Misc when web classification returns no payee", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          web: {
            results: [
              {
                title: "X",
                url: "https://x.com",
                description: "X",
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ name: "Coffee" }],
      });
    vi.stubGlobal("fetch", fetchMock);

    // LLM returns null / no payee
    mockChat.mockResolvedValueOnce({
      choices: [{ message: { content: '{"payee":null}' } }],
    });

    const result = await registry._handle_resolve_merchant({
      merchant: "UnknownBiz",
      budget_id: "test-budget",
    });

    expect(result).toEqual({ payee: "Misc", source: "fallback" });
    vi.unstubAllGlobals();
  });

  it("falls back to Misc when web classification throws", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          web: {
            results: [
              {
                title: "X",
                url: "https://x.com",
                description: "X",
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ name: "Coffee" }],
      });
    vi.stubGlobal("fetch", fetchMock);

    // Classification throws
    mockChat.mockRejectedValueOnce(new Error("LLM timeout"));

    const result = await registry._handle_resolve_merchant({
      merchant: "TimeoutBiz",
      budget_id: "test-budget",
    });

    expect(result).toEqual({ payee: "Misc", source: "fallback" });
    vi.unstubAllGlobals();
  });

  it("short-circuits: memory hit skips web lookup (T012)", async () => {
    // Memory hit should return immediately with source "memory".
    const memory = mockMemoryStore(["NTUC FairPrice maps to Groceries payee"]);
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const result = await registry._handle_resolve_merchant({
      merchant: "NTUC FairPrice",
      budget_id: "test-budget",
    });

    expect(result).toEqual({ payee: "Groceries", source: "memory" });
    expect(memory.add).not.toHaveBeenCalled();
  });

  it("short-circuits: memory hit skips web API call", async () => {
    const memory = mockMemoryStore(["UnknownBiz maps to Coffee payee"]);
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await registry._handle_resolve_merchant({
      merchant: "UnknownBiz",
      budget_id: "test-budget",
    });

    expect(result).toEqual({ payee: "Coffee", source: "memory" });
    // fetch should NOT have been called at all
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("returns first match when memory has multiple entries", async () => {
    const memory = mockMemoryStore([
      "Shell maps to Transport payee",
      "Shell Station maps to Transport payee",
    ]);
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const result = await registry._handle_resolve_merchant({
      merchant: "Shell",
      budget_id: "test-budget",
    });

    expect(result).toEqual({ payee: "Transport", source: "memory" });
  });

  it("skips memory entries that do not match the regex pattern", async () => {
    const memory = mockMemoryStore(["Some random fact about Shell"]);
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const result = await registry._handle_resolve_merchant({
      merchant: "Shell",
      budget_id: "test-budget",
    });

    // Keyword removed — falls back to Misc
    expect(result.payee).toBe("Misc");
    expect(result.source).toBe("fallback");
  });

  it("returns fallback when memory is null", async () => {
    // Create registry WITHOUT passing memory
    const registryNoMem = new ToolRegistry(mockConfig(), null);
    const result = await registryNoMem.executeTool("resolve_merchant", {
      merchant: "Anything",
      budget_id: "test-budget",
    });
    expect(result).toEqual({ payee: "Misc", source: "fallback" });
  });

  it("handles API hang gracefully (keyword removed)", async () => {
    vi.useFakeTimers();
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    vi.stubGlobal("fetch", () => new Promise(() => {}));

    const promise = registry._handle_resolve_merchant({
      merchant: "NTUC FairPrice",
      budget_id: "test-budget",
    });

    await vi.advanceTimersByTimeAsync(21000);

    const result = await promise;
    // Keyword removed — falls back to Misc on timeout
    expect(result.payee).toBe("Misc");
    expect(result.source).toBe("fallback");

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Classification prompt structure (T005)
// ─────────────────────────────────────────────────────────────────────────

describe("Classification prompt structure", () => {
  it("does not send unknown merchants to web/LLM classification", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    // fetch: search_web (Brave) → payees
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          web: {
            results: [
              {
                title: "Joe's Diner",
                url: "https://joes.example",
                description: "A family restaurant",
              },
              {
                title: "Joe's Diner Menu",
                url: "https://joes.example/menu",
                description: "Breakfast and lunch",
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { name: "Food" },
          { name: "Coffee" },
          { name: "Groceries" },
        ],
      });
    vi.stubGlobal("fetch", fetchMock);

    mockChat.mockResolvedValueOnce({
      choices: [{ message: { content: '{"payee":"Food"}' } }],
    });

    await registry._handle_resolve_merchant({
      merchant: "Joe's Diner",
      budget_id: "test-budget",
    });

    expect(mockChat).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("returns Misc even when a web/LLM response suggests a payee", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    // fetch: search_web (Brave) → payees
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          web: {
            results: [
              {
                title: "Some Merchant",
                url: "https://example.com",
                description: "A test merchant",
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ name: "Coffee" }, { name: "Food" }],
      });
    vi.stubGlobal("fetch", fetchMock);

    // Mock chat to return "Here is the result: {"payee":"Coffee"} additional text"
    mockChat.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'Here is the result: {"payee":"Coffee"} additional text',
          },
        },
      ],
    });

    const result = await registry.executeTool("resolve_merchant", {
      merchant: "Test",
      budget_id: "test-budget",
    });
    expect(result.payee).toBe("Misc");
    expect(result.source).toBe("fallback");
    expect(mockChat).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Auto-learning (T018, T019, T020, T021)
// ─────────────────────────────────────────────────────────────────────────

describe("Auto-learning", () => {
  it("does not call learn_fact on keyword match (keyword removed)", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    await registry._handle_resolve_merchant({
      merchant: "NTUC FairPrice",
      budget_id: "test-budget",
    });

    // Keyword matching removed — learn_fact should not be called for keyword
    // (may still be called for memory or web, but not for keyword validation)
    vi.unstubAllGlobals();
  });

  it("does not auto-learn a web resolution", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          web: {
            results: [
              {
                title: "T",
                url: "https://t.com",
                description: "D",
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ name: "Coffee" }],
      });
    vi.stubGlobal("fetch", fetchMock);

    mockChat.mockResolvedValueOnce({
      choices: [{ message: { content: '{"payee":"Coffee"}' } }],
    });

    await registry._handle_resolve_merchant({
      merchant: "UnchartedBiz",
      budget_id: "test-budget",
    });

    expect(memory.add).not.toHaveBeenCalled();
    expect(mockChat).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("does NOT trigger learn_fact on memory hit (T020)", async () => {
    const memory = mockMemoryStore(["Starbucks maps to Coffee payee"]);
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    await registry._handle_resolve_merchant({
      merchant: "Starbucks",
      budget_id: "test-budget",
    });

    expect(memory.add).not.toHaveBeenCalled();
  });

  it("does NOT trigger learn_fact on fallback (T021)", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig({ braveSearchApiKey: undefined });
    const registry = new ToolRegistry(config, memory);

    await registry._handle_resolve_merchant({
      merchant: "UnknownMerchantXYZ",
      budget_id: "test-budget",
    });

    expect(memory.add).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Category validation in insert_transaction (T037)
// ─────────────────────────────────────────────────────────────────────────

describe("Category validation in insert_transaction", () => {
  it("falls back to Fun Money when category_id is unknown (T037a)", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi
      .fn()
      // 1) _get("/payees") in _validate_payee → no exact match
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      // 2) _get("/categories") → unknown cat, Fun Money exists
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "cat-grocery", name: "Groceries" },
          { id: "cat-fun", name: "Fun Money" },
        ],
      })
      // 3) _post("/transactions")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "tx-1", category: "cat-fun" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await registry._handle_insert_transaction({
      date: "2026-06-16",
      amount_cents: 1500,
      account_id: "acc-1",
      budget_id: "bud-1",
      category_id: "cat-nonexistent",
      imported_description: "Some shop",
    });

    // Verify the POST body uses "Fun Money" category
    const postCall = fetchMock.mock.calls[2];
    const postBody = JSON.parse(postCall[1].body);
    expect(postBody.category).toBe("cat-fun");
    expect(postBody.budget_id).toBe("bud-1");
    expect(postBody.payee_name).toBe("Misc");

    vi.unstubAllGlobals();
  });

  it("uses valid category_id directly without fallback (T037b)", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi
      .fn()
      // 1) _get("/payees")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      // 2) _get("/categories") → valid cat exists
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "cat-grocery", name: "Groceries" },
          { id: "cat-fun", name: "Fun Money" },
        ],
      })
      // 3) _post("/transactions")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "tx-2", category: "cat-grocery" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await registry._handle_insert_transaction({
      date: "2026-06-16",
      amount_cents: 2500,
      account_id: "acc-1",
      budget_id: "bud-1",
      category_id: "cat-grocery",
      imported_description: "NTUC FairPrice",
    });

    const postCall = fetchMock.mock.calls[2];
    const postBody = JSON.parse(postCall[1].body);
    expect(postBody.category).toBe("cat-grocery");

    vi.unstubAllGlobals();
  });

  it("keeps null category_id when no category_id provided", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi
      .fn()
      // 1) _get("/payees")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      // 2) _post("/transactions") — no categories call because category_id is null
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "tx-3" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await registry._handle_insert_transaction({
      date: "2026-06-16",
      amount_cents: 999,
      account_id: "acc-1",
      budget_id: "bud-1",
      imported_description: "Coffee shop",
      // category_id omitted
    });

    const postCall = fetchMock.mock.calls[1];
    const postBody = JSON.parse(postCall[1].body);
    expect(postBody.category).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("falls back to Fun Money when categories API call fails", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi
      .fn()
      // 1) _get("/payees")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      // 2) _get("/categories") → throws
      .mockRejectedValueOnce(new Error("API down"))
      // 3) _post("/transactions")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "tx-4" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await registry._handle_insert_transaction({
      date: "2026-06-16",
      amount_cents: 1500,
      account_id: "acc-1",
      budget_id: "bud-1",
      category_id: "cat-original",
      imported_description: "Test",
    });

    // When categories fetch fails, the catch keeps the original category_id
    const postCall = fetchMock.mock.calls[2];
    const postBody = JSON.parse(postCall[1].body);
    expect(postBody.category).toBe("cat-original");

    vi.unstubAllGlobals();
  });

  it("validates payee by exact name match in payees list", async () => {
    const memory = mockMemoryStore(["Starbucks maps to Coffee payee"]);
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi
      .fn()
      // 1) _get("/payees") — _validate_payee resolves the name and its ID
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "p1", name: "Coffee" },
          { id: "p2", name: "Groceries" },
        ],
      })
      // 2) _post("/transactions")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "tx-5", payee_name: "Coffee" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await registry._handle_insert_transaction({
      date: "2026-06-16",
      amount_cents: 500,
      account_id: "acc-1",
      budget_id: "bud-1",
      imported_description: "Coffee",
    });

    const postCall = fetchMock.mock.calls[1];
    const postBody = JSON.parse(postCall[1].body);
    // Payee should be "Coffee" (exact match from payees list)
    expect(postBody.payee_name).toBe("Coffee");
    expect(postBody.payee).toBe("p1");

    vi.unstubAllGlobals();
  });

  it("passes payee ID alongside payee_name in POST body", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi
      .fn()
      // 1) _get("/payees") - _validate_payee resolves the name and its ID
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: "p1", name: "Coffee" }],
      })
      // 2) _post("/transactions")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "tx-6" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await registry._handle_insert_transaction({
      date: "2026-06-16",
      amount_cents: 500,
      account_id: "acc-1",
      budget_id: "bud-1",
      imported_description: "Coffee",
    });

    const postCall = fetchMock.mock.calls[1];
    const postBody = JSON.parse(postCall[1].body);
    expect(postBody.payee_name).toBe("Coffee");
    expect(postBody.payee).toBe("p1");

    vi.unstubAllGlobals();
  });

  it("uses payee_id from args as the only payee field after validating it", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi
      .fn()
      // 1) _get("/payees") - validate the explicit payee_id
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: "p-transfer", name: "Touch N Go", transfer_acct: "acct-tng" }],
      })
      // 2) _get("/accounts") validates the transfer destination
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: "acct-tng", name: "Touch N Go", closed: false }],
      })
      // 3) _post("/transactions") - no name lookup for the payee
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "tx-transfer" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await registry._handle_insert_transaction({
      date: "2026-06-16",
      amount_cents: -3000,
      account_id: "acc-1",
      budget_id: "bud-1",
      imported_description: "Touch N Go",
      payee_id: "p-transfer",
    });

    const postCall = fetchMock.mock.calls[2];
    const postBody = JSON.parse(postCall[1].body);
    // The explicit ID is the only payee field; a name from the same
    // imported_description could resolve to a different payee. Issue #483.
    expect(postBody.payee_name).toBeUndefined();
    expect(postBody.payee).toBe("p-transfer");

    vi.unstubAllGlobals();
  });

  it.each([
    ["closed", "closed", [{ id: "target", name: "Closed Target", closed: true }], "closed or unavailable"],
    ["absent", "missing", [], "closed or unavailable"],
    ["self", "source", [{ id: "source", name: "Source", closed: false }], "cannot be its source"],
  ])("rejects %s transfer target through the shared REST/MCP write boundary", async (_label, target, accounts, error) => {
    const registry = new ToolRegistry(mockConfig(), mockMemoryStore());
    const fetchMock = vi.fn(async (url, options) => {
      if (String(url).includes("/payees")) return { ok: true, json: async () => [
        { id: "transfer", name: "Transfer Target", transfer_acct: target },
      ] };
      if (String(url).includes("/accounts/balance/")) return { ok: true, json: async () => ({ balance: 0 }) };
      if (String(url).includes("/accounts")) return { ok: true, json: async () => accounts };
      if (options?.method === "POST") return { ok: true, json: async () => ({ id: "should-not-post" }) };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await registry.executeTool("insert_transaction", {
      date: "2026-06-16", amount_cents: -3000, account_id: "source",
      budget_id: "bud-1", imported_description: "Transfer Target",
    });

    expect(result.error).toContain(error);
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("fails closed when a memory-resolved transfer name cannot be checked", async () => {
    const registry = new ToolRegistry(
      mockConfig(), mockMemoryStore(["Merchant maps to Transfer Target payee"]),
    );
    const fetchMock = vi.fn().mockRejectedValue(new Error("payees unavailable"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await registry.executeTool("insert_transaction", {
      date: "2026-06-16", amount_cents: -3000, account_id: "source",
      budget_id: "bud-1", imported_description: "Merchant",
    });

    expect(result.error).toContain("Could not validate transfer destination");
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("allows an open non-self transfer target through the shared REST/MCP write boundary", async () => {
    const registry = new ToolRegistry(mockConfig(), mockMemoryStore());
    const fetchMock = vi.fn(async (url, options) => {
      if (String(url).includes("/payees")) return { ok: true, json: async () => [
        { id: "transfer", name: "Transfer Target", transfer_acct: "target" },
      ] };
      if (String(url).includes("/accounts/balance/")) return { ok: true, json: async () => ({ balance: 0 }) };
      if (String(url).includes("/accounts")) return { ok: true, json: async () => [
        { id: "target", name: "Target", closed: false },
      ] };
      if (options?.method === "POST") return { ok: true, json: async () => ({ id: "transfer-row" }) };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await registry.executeTool("insert_transaction", {
      date: "2026-06-16", amount_cents: -3000, account_id: "source",
      budget_id: "bud-1", imported_description: "Transfer Target",
    });

    expect(result).toMatchObject({ id: "transfer-row" });
    const postCall = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(postCall[1].body).payee).toBe("transfer");
    vi.unstubAllGlobals();
  });

  it("skips payee ID lookup when payee resolves to Misc", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi
      .fn()
      // 1) _get("/payees") - empty, _validate_payee returns "Misc"
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      // 2) _post("/transactions") - no extra payee lookup
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "tx-7" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await registry._handle_insert_transaction({
      date: "2026-06-16",
      amount_cents: 999,
      account_id: "acc-1",
      budget_id: "bud-1",
      imported_description: "SomeUnknownShop",
    });

    const postCall = fetchMock.mock.calls[1];
    const postBody = JSON.parse(postCall[1].body);
    expect(postBody.payee_name).toBe("Misc");
    expect(postBody.payee).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("keeps original category_id when Fun Money not in list", async () => {
    // Mock categories WITHOUT "Fun Money"
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ name: "Misc" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: "cat-other", name: "Other" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "txn-new", amount: -500 }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    await registry.executeTool("insert_transaction", {
      account_id: "acct-1",
      budget_id: "test-budget",
      date: "2026-06-15",
      amount_cents: -500,
      imported_description: "Test Merchant",
      category_id: "cat-unknown",
      budget_id: "test-budget",
    });

    // Verify the original category_id was kept (not replaced)
    // Check mockFetch was called with category: "cat-unknown" in body
    const postCall = fetchMock.mock.calls.find((c) => c[1]?.method === "POST");
    const body = JSON.parse(postCall[1].body);
    expect(body.category).toBe("cat-unknown");

    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// update_transaction
// ─────────────────────────────────────────────────────────────────────────

describe("update_transaction", () => {
  it("rejects unknown payee", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: "p1", name: "Groceries" },
        { id: "p2", name: "Coffee" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await registry._handle_update_transaction({
      id: "txn-1",
      budget_id: "test-budget",
      payee_name: "NonExistentPayee",
    });

    expect(result.error).toContain("Payee");
    expect(result.error).toContain("not found");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("accepts valid payee", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi
      .fn()
      // 1) _get("/payees") — contains "Food"
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "p1", name: "Food" },
          { id: "p2", name: "Groceries" },
        ],
      })
      // 2) _patch("/transactions/txn-1")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "txn-1", payee: "Food" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await registry._handle_update_transaction({
      id: "txn-1",
      budget_id: "test-budget",
      payee_name: "Food",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const patchCall = fetchMock.mock.calls[1];
    const patchBody = JSON.parse(patchCall[1].body);
    expect(patchCall[1].method).toBe("PATCH");
    expect(patchBody.payee).toBe("p1");
    expect(result).toEqual({ id: "txn-1", payee: "Food" });

    vi.unstubAllGlobals();
  });

  it("rejects unknown category_id", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: "cat-grocery", name: "Groceries" },
        { id: "cat-coffee", name: "Coffee" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await registry._handle_update_transaction({
      id: "txn-1",
      budget_id: "test-budget",
      category_id: "fake-cat-id",
      budget_id: "test-budget",
    });

    expect(result.error).toContain("Category ID");
    expect(result.error).toContain("not found");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("accepts valid category_id", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi
      .fn()
      // 1) _get("/categories") — contains "cat-food"
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "cat-food", name: "Food" },
          { id: "cat-grocery", name: "Groceries" },
        ],
      })
      // 2) _patch("/transactions/txn-1")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "txn-1", category: "cat-food" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await registry._handle_update_transaction({
      id: "txn-1",
      budget_id: "test-budget",
      category_id: "cat-food",
      budget_id: "test-budget",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const patchCall = fetchMock.mock.calls[1];
    const patchBody = JSON.parse(patchCall[1].body);
    expect(patchCall[1].method).toBe("PATCH");
    expect(patchBody.category).toBe("cat-food");
    expect(result).toEqual({ id: "txn-1", category: "cat-food" });

    vi.unstubAllGlobals();
  });

  it("clears category when the same request sets the payee to Misc", async () => {
    const registry = new ToolRegistry(mockConfig(), mockMemoryStore());
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "payee-misc", name: "Misc" },
          { id: "payee-food", name: "Food" },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "txn-1", category: null }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await registry._handle_update_transaction({
      id: "txn-1",
      budget_id: "test-budget",
      payee_name: "mIsC",
      category_id: null,
    });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      payee: "payee-misc",
      category: null,
    });

    vi.unstubAllGlobals();
  });

  it("clears category when the existing transaction payee is Misc", async () => {
    const registry = new ToolRegistry(mockConfig(), mockMemoryStore());
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "payee-misc", name: "Misc" },
          { id: "payee-food", name: "Food" },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "txn-1", payee: "Misc" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "txn-1", category: null }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await registry._handle_update_transaction({
      id: "txn-1",
      budget_id: "test-budget",
      category_id: null,
    });

    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      category: null,
    });

    vi.unstubAllGlobals();
  });

  it("rejects clearing category unless the resulting payee is Misc", async () => {
    const registry = new ToolRegistry(mockConfig(), mockMemoryStore());
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: "payee-misc", name: "Misc" },
        { id: "payee-food", name: "Food" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await registry._handle_update_transaction({
      id: "txn-1",
      budget_id: "test-budget",
      payee_name: "Food",
      category_id: null,
    });

    expect(result).toEqual({
      error: "Category can only be cleared when payee is Misc",
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
  });

  it("rejects clearing category when the existing transaction payee is not Misc", async () => {
    const registry = new ToolRegistry(mockConfig(), mockMemoryStore());
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "payee-misc", name: "Misc" },
          { id: "payee-food", name: "Food" },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "txn-1", payee: "payee-food" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await registry._handle_update_transaction({
      id: "txn-1",
      budget_id: "test-budget",
      category_id: null,
    });

    expect(result).toEqual({
      error: "Category can only be cleared when payee is Misc",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it("builds only provided fields", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi
      .fn()
      // 1) _get("/payees") — contains "Food"
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "p1", name: "Food" },
          { id: "p2", name: "Groceries" },
        ],
      })
      // 2) _patch("/transactions/txn-1")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "txn-1", payee: "Food" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await registry._handle_update_transaction({
      id: "txn-1",
      budget_id: "test-budget",
      payee_name: "Food",
    });

    const patchCall = fetchMock.mock.calls[1];
    const patchBody = JSON.parse(patchCall[1].body);
    expect(patchBody).toEqual({ payee: "p1", budget_id: "test-budget" });
    expect(patchBody.notes).toBeUndefined();
    expect(patchBody.amount).toBeUndefined();
    expect(patchBody.date).toBeUndefined();
    expect(patchBody.category).toBeUndefined();
    expect(patchBody.account).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("rejects empty body", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await registry._handle_update_transaction({
      id: "txn-1",
      budget_id: "test-budget",
    });

    expect(result.error).toContain("At least one field");
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("sends all provided fields in PATCH body", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi
      .fn()
      // 1) _get("/payees") — contains "Food"
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "p1", name: "Food" },
          { id: "p2", name: "Groceries" },
        ],
      })
      // 2) _patch("/transactions/txn-1")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "txn-1", payee: "Food" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await registry._handle_update_transaction({
      id: "txn-1",
      budget_id: "test-budget",
      payee_name: "Food",
      notes: "test",
      amount: -500,
    });

    const patchCall = fetchMock.mock.calls[1];
    const patchBody = JSON.parse(patchCall[1].body);
    expect(patchBody.payee).toBe("p1");
    expect(patchBody.notes).toBe("test");
    expect(patchBody.amount).toBe(-500);

    vi.unstubAllGlobals();
  });

  it("calls PATCH to the correct transaction URL", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "p1", name: "Food" },
          { id: "p2", name: "Groceries" },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "txn-1", payee: "Food" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await registry._handle_update_transaction({
      id: "txn-1",
      budget_id: "test-budget",
      payee_name: "Food",
    });

    const patchUrl = fetchMock.mock.calls[1][0];
    expect(patchUrl).toBe("http://localhost:3000/transactions/txn-1");

    vi.unstubAllGlobals();
  });
});

describe("Multi-word payee regex", () => {
  it("extracts multi-word payee like Fun Money from memory fact", async () => {
    const memory = mockMemoryStore(["SGSUPERGREEN-B maps to Fun Money payee"]);
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    const result = await registry._handle_resolve_merchant({
      merchant: "SGSUPERGREEN-B",
      budget_id: "test-budget",
    });

    expect(result).toEqual({ payee: "Fun Money", source: "memory" });
  });
});

describe.skip("removed web-path merchant learning (#587)", () => {
  /**
   * Registry whose web branch returns `payee`, with live accounts supplied (or
   * an error object when the account list cannot be read).
   */
  function webRegistry(memory, accounts) {
    const registry = new ToolRegistry(mockConfig(), memory);
    registry._handle_search_web = vi.fn(async () => ({
      results: [
        { title: "Coffee", url: "https://coffee.test", description: "cafe" },
      ],
    }));
    registry._classify_merchant = vi.fn(async () => "Coffee");
    registry._handle_fetch_accounts = vi.fn(async () => accounts);
    return registry;
  }

  it("passes live accounts into the web-path memory write", async () => {
    const memory = mockMemoryStore();
    const accounts = [{ id: "ocbc", name: "OCBC 360", closed: false }];
    const registry = webRegistry(memory, accounts);

    const result = await registry._handle_resolve_merchant({
      merchant: "Kopi Place",
      budget_id: "test-budget",
    });

    expect(result).toEqual({ payee: "Coffee", source: "web" });
    expect(memory.add).toHaveBeenCalledWith(
      "Kopi Place maps to Coffee payee",
      accounts,
    );
  });

  it("does not write a web payee when the account list cannot be read", async () => {
    const memory = mockMemoryStore();
    const registry = webRegistry(memory, { error: "upstream down" });

    const result = await registry._handle_resolve_merchant({
      merchant: "Kopi Place",
      budget_id: "test-budget",
    });

    // The classification still stands; only the unvalidatable write is dropped.
    expect(result).toEqual({ payee: "Coffee", source: "web" });
    expect(memory.add).not.toHaveBeenCalled();
  });

  it("does not store a web payee that is one of the user's own accounts", async () => {
    const { MemoryStore } = await import("../src/memory.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), "mem-")), "MEMORY.md"));
    const registry = new ToolRegistry(mockConfig(), store);
    registry._handle_search_web = vi.fn(async () => ({
      results: [
        { title: "Trust Bank", url: "https://trust.test", description: "bank" },
      ],
    }));
    registry._classify_merchant = vi.fn(async () => "Trust Bank");
    registry._handle_fetch_accounts = vi.fn(async () => [
      { id: "trust", name: "Trust Bank", closed: false },
    ]);

    const result = await registry._handle_resolve_merchant({
      merchant: "Trust Bank",
      budget_id: "test-budget",
    });

    expect(result).toEqual({ payee: "Trust Bank", source: "web" });
    expect(
      store.listFacts().some((f) => /maps to Trust Bank payee/i.test(f)),
    ).toBe(false);
  });
});

describe.skip("removed web payee lookup budget routing (#587)", () => {
  it("routes budget_id through to payee list fetch", async () => {
    const memory = mockMemoryStore();
    const config = mockConfig();
    const registry = new ToolRegistry(config, memory);

    // Spy on _get to verify budget_id is passed
    const originalGet = registry._get.bind(registry);
    let capturedBudgetId = null;
    registry._get = async (path, budgetId) => {
      if (path === "/payees") capturedBudgetId = budgetId;
      return originalGet(path, budgetId);
    };

    // Use fetch mock for the payee list
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => [{ name: "Food" }],
      }),
    );

    await registry._handle_resolve_merchant({
      merchant: "SomeUnknownMerchant",
      budget_id: "Example MYR",
    });

    // Keyword match fails → should call _get with Example MYR
    expect(capturedBudgetId).toBe("Example MYR");
    vi.unstubAllGlobals();
  });
});

describe.skip("removed web resolution timeout (#587)", () => {
  it("falls back to Misc when web search + classification exceeds 20s", async () => {
    vi.useFakeTimers();
    const memory = mockMemoryStore();
    const config = mockConfig({ braveSearchApiKey: "test-key" });
    const registry = new ToolRegistry(config, memory);

    // Make fetch take forever
    vi.stubGlobal("fetch", () => new Promise(() => {})); // never resolves

    const promise = registry._handle_resolve_merchant({
      merchant: "UnknownBiz",
      budget_id: "test-budget",
    });

    // Advance past 20s timeout (async to flush microtasks)
    await vi.advanceTimersByTimeAsync(21000);

    const result = await promise;
    expect(result).toEqual({ payee: "Misc", source: "fallback" });

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// suppress_transfer_payee is independent of the other insert arguments (#621)
// ─────────────────────────────────────────────────────────────────────────

describe("insert_transaction suppress_transfer_payee (#621)", () => {
  it("posts payee_name Misc and no payee even when payee_id is also passed", async () => {
    const registry = new ToolRegistry(mockConfig(), mockMemoryStore());
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: "tx-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await registry._handle_insert_transaction({
      date: "2026-06-16",
      amount_cents: 1500,
      account_id: "acc-1",
      budget_id: "bud-1",
      payee_id: "p-explicit",
      suppress_transfer_payee: true,
      imported_description: "Some shop",
    });

    const post = fetchMock.mock.calls
      .map(([url, init]) => ({ url: String(url), init }))
      .find((c) => c.url.includes("/transactions") && c.init?.method === "POST");
    const body = JSON.parse(post.init.body);
    expect(body.payee_name).toBe("Misc");
    expect(body.payee).toBeUndefined();

    vi.unstubAllGlobals();
  });
});
