/**
 * Tests for prompt structure — 3-phase pipeline.
 */
import { describe, it, expect } from "vitest";

describe("getPhase1Prompt", () => {
  let prompt;
  beforeAll(async () => {
    const { getPhase1Prompt } = await import("../src/prompts.js");
    prompt = getPhase1Prompt();
  });

  it("includes merchant extraction rule", () => {
    expect(prompt).toContain("merchant");
  });

  it("includes amount in integer cents", () => {
    expect(prompt).toContain("INTEGER cents");
  });

  it("includes currency routing (SGD/MYR)", () => {
    expect(prompt).toContain("SGD");
    expect(prompt).toContain("MYR");
  });

  it("instructs LLM to leave payee_name and category_id blank", () => {
    expect(prompt).toContain("Leave payee_name and category_id BLANK");
  });

  it("references fetch_context tool", () => {
    expect(prompt).toContain("fetch_context");
  });

  it("includes skip detection for non-transactions", () => {
    expect(prompt).toContain("skip");
    expect(prompt).toContain("NOT a transaction");
  });

  it("outputs valid JSON with expected fields", () => {
    expect(prompt).toContain("account_id");
    expect(prompt).toContain("account_name");
    expect(prompt).toContain("raw_description");
  });

  it("instructs LLM to use email sender domain for account matching", () => {
    expect(prompt).toContain("From domain");
    expect(prompt).toMatch(/@dbs\.com/);
  });

  it("instructs LLM to use subject line for card number matching", () => {
    expect(prompt).toContain("Subject line");
    expect(prompt).toMatch(/Card ending/);
  });

  it("instructs LLM to call search_memory with short targeted queries", () => {
    expect(prompt).toContain("search_memory");
    expect(prompt).toMatch(/short(?:est)?|targeted|specific/i);
    expect(prompt).toMatch(/query/i);
  });

  it("forbids searching memory with the whole email body", () => {
    expect(prompt).not.toMatch(/whole email (?:body|text).*search_memory|search_memory.*whole email/i);
    expect(prompt).not.toContain("slice(0, 300)");
  });

  it("lists evidence signals to extract from heterogeneous emails", () => {
    expect(prompt).toMatch(/card number|account ending|suffix/i);
    expect(prompt).toMatch(/subject/i);
    expect(prompt).toMatch(/sender|domain/i);
  });

  it("instructs LLM to use card type for account matching", () => {
    expect(prompt).toContain("Card type");
    expect(prompt).toMatch(/credit.debit/);
  });

  // Fix 1: no hardcoded date in example JSON (#263)
  it("does not contain a hardcoded date in the example JSON", () => {
    // Must not have a literal YYYY-MM-DD date in the example output block
    const exampleBlock = prompt.slice(prompt.indexOf('"date":'));
    expect(exampleBlock).not.toMatch(/"\d{4}-\d{2}-\d{2}"/);
    expect(prompt).toContain("<YYYY-MM-DD from email>");
  });

  // Fix 4: hardened account-matching language (#263)
  it("enforces bank-domain matching with MUST / NEVER cross banks", () => {
    expect(prompt).toContain("MUST match the email sender domain");
    expect(prompt).toContain("NEVER cross banks");
  });

  it("uses ONLY keyword for domain→bank mapping examples", () => {
    expect(prompt).toMatch(/@dbs\.com → ONLY DBS/);
    expect(prompt).toMatch(/@ocbc\.com → ONLY OCBC/);
  });

  // Fix 1: bill payment / transfer sign words (#265)
  it("includes bill payment sign words as negative", () => {
    expect(prompt).toContain("bill payment");
    expect(prompt).toContain("scheduled payment");
    expect(prompt).toContain("transferred");
  });

  it("includes transferred-in sign words as positive", () => {
    expect(prompt).toContain("transferred in");
    expect(prompt).toContain("received payment");
  });

  // Fix 2: inter-account transfer guidance (#265)
  it("includes rule 4b for bill payment / inter-account transfer mapping", () => {
    expect(prompt).toContain("4b.");
    expect(prompt).toContain("SOURCE account");
    expect(prompt).toContain("destination name as the merchant");
  });

  it("provides transfer merchant examples in rule 4b", () => {
    expect(prompt).toContain("Vista");
    expect(prompt).toContain("Nova");
    expect(prompt).toContain("UOB CREDIT CARDS");
  });

  it("makes keyword inference take precedence over explicit + sign", () => {
    expect(prompt).toContain("keyword inference takes");
    expect(prompt).toContain("precedence");
    expect(prompt).toContain("charging +SGD 120.45");
    expect(prompt).toContain("= negative");
  });
});

describe("getCategoryPickerPrompt", () => {
  it("includes the payee name in the prompt", async () => {
    const { getCategoryPickerPrompt } = await import("../src/prompts.js");
    const result = getCategoryPickerPrompt("Toast Box", [
      { id: "cat-food", name: "Food & Dining" },
      { id: "cat-transport", name: "Transport" },
    ]);
    expect(result).toContain("Toast Box");
  });

  it("includes available categories with IDs", async () => {
    const { getCategoryPickerPrompt } = await import("../src/prompts.js");
    const result = getCategoryPickerPrompt("Grab", [
      { id: "cat-food", name: "Food & Dining" },
    ]);
    expect(result).toContain("cat-food");
    expect(result).toContain("Food & Dining");
  });

  it("allows null category_id", async () => {
    const { getCategoryPickerPrompt } = await import("../src/prompts.js");
    const result = getCategoryPickerPrompt("Misc", []);
    expect(result).toContain("null");
  });

  it("handles empty category list", async () => {
    const { getCategoryPickerPrompt } = await import("../src/prompts.js");
    const result = getCategoryPickerPrompt("Unknown", []);
    expect(result).toContain("none available");
  });
});
