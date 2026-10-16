/**
 * Task 4 tests (#88): search_memory / learn_fact dispatch, password passthrough
 * to the extractors, and password redaction in tool-execution logs.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const ex = vi.hoisted(() => ({ pdfPw: [], emailPw: [] }));

vi.mock("../src/pdf_extractor.js", () => ({
  extractPdfText: vi.fn(async (_b, password = null) => {
    ex.pdfPw.push(password);
    return "PDF TEXT";
  }),
}));
vi.mock("../src/email_handler.js", () => ({
  extractEmailContent: vi.fn(async (_r, password = null) => {
    ex.emailPw.push(password);
    return "EMAIL TEXT";
  }),
}));

import { mkdtempSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ToolRegistry, TOOL_SCHEMAS } from "../src/tools.js";

function makeRegistry(factsMemory) {
  // dedup/memory/ppBridge are unused by the tools under test
  return new ToolRegistry({}, null, null, null, factsMemory);
}

beforeEach(() => {
  ex.pdfPw = [];
  ex.emailPw = [];
  vi.clearAllMocks();
});

describe("ToolRegistry — memory tools (read-only, #783)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pt-proposals-"));
  });

  const registry = (facts) =>
    new ToolRegistry({ wikiProposalsPath: join(dir, "q.jsonl") }, null, null, null, facts);

  it("search_memory delegates to FactsMemory.search", async () => {
    const facts = {
      search: vi.fn(async (q) => [{ text: `hit:${q}`, score: 1 }]),
      add: vi.fn(),
    };
    const res = await registry(facts).executeTool("search_memory", { query: "IBKR" });
    expect(facts.search).toHaveBeenCalledWith("IBKR");
    expect(res.results[0].text).toBe("hit:IBKR");
  });

  it("search_memory never returns a credential-shaped fact", async () => {
    const facts = {
      search: vi.fn(async () => [
        { text: "POEMS statement password is abc123", score: 1 },
        { text: "IBKR account is U0000000", score: 1 },
      ]),
      add: vi.fn(),
    };
    const res = await registry(facts).executeTool("search_memory", { query: "x" });
    expect(res.results.map((r) => r.text)).toEqual(["IBKR account is U0000000"]);
  });

  it("learn_fact refuses a credential and writes nothing", async () => {
    const facts = { search: vi.fn(), add: vi.fn() };
    const res = await registry(facts).executeTool("learn_fact", {
      fact: "POEMS statement password is x",
    });
    expect(res).toMatchObject({ added: false, reason: "secret_refused" });
    expect(facts.add).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "q.jsonl"))).toBe(false);
  });

  it("learn_fact queues other facts as a wiki proposal, never memory", async () => {
    const facts = { search: vi.fn(), add: vi.fn() };
    const reg = registry(facts);
    const res = await reg.executeTool("learn_fact", { fact: "Broker X uses SGD" });
    await reg.executeTool("learn_fact", { fact: "Broker X uses SGD" });
    expect(res).toMatchObject({ added: false, reason: "proposal_queued" });
    expect(facts.add).not.toHaveBeenCalled();
    const lines = readFileSync(join(dir, "q.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ op: "add", fact: "Broker X uses SGD", source: "portfolio-tracker" });
  });

  it("search_memory returns empty when no facts store is wired", async () => {
    const res = await registry(null).executeTool("search_memory", { query: "x" });
    expect(res.results).toEqual([]);
  });
});

describe("ToolRegistry — no passwords in extract tools (#783)", () => {
  it("extract_pdf_text ignores a password argument", async () => {
    const reg = makeRegistry(null);
    await reg.executeTool("extract_pdf_text", {
      pdf_bytes_b64: Buffer.from("x").toString("base64"),
      password: "Secret123",
    });
    expect(ex.pdfPw).toEqual([null]);
  });

  it("extract_email_content ignores a password argument", async () => {
    const reg = makeRegistry(null);
    await reg.executeTool("extract_email_content", { password: "Secret123" });
    expect(ex.emailPw).toEqual([null]);
  });

  it("no tool schema offers a password parameter", () => {
    const schemas = JSON.stringify(makeRegistry(null).getToolSchemas?.() ?? TOOL_SCHEMAS);
    expect(schemas).not.toMatch(/"password"/);
  });
});

describe("ToolRegistry — log redaction", () => {
  it("never writes the password value to logs", async () => {
    const logged = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s) => {
      logged.push(String(s));
    });
    const reg = makeRegistry(null);
    await reg.executeTool("extract_pdf_text", {
      pdf_bytes_b64: "AA==",
      password: "hunter2",
    });
    spy.mockRestore();
    const all = logged.join("\n");
    expect(all).not.toContain("hunter2");
    expect(all).toContain("[REDACTED]");
  });
});
