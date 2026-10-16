/**
 * Issue #796: a card charge in a foreign currency (not the primary or
 * secondary budget currency) is converted to the charged card's currency by an
 * LLM, booked in the card's budget, and the original amount is kept in the
 * note. A failed conversion is held, never booked in the foreign amount.
 *
 * Synthetic data only.
 */
import { describe, it, expect, vi } from "vitest";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { LLMUnavailableError } from "../src/llm-responses.js";

const CONFIG = {
  primaryCurrency: "SGD",
  secondaryCurrency: "MYR",
  primaryBudgetFile: "Budget SGD",
  secondaryBudgetFile: "Budget MYR",
  llmProvider: "deepseek",
  llmApiKey: "k",
  deepseekApiKey: "k",
};
const BODY = "From: alerts@bank.example\nSubject: Card alert\n\nA charge of IDR 50,000.00 at Alpha Ride.";
const TODAY = new Date().toISOString().slice(0, 10);

function orchestrator(phase1, ...conversions) {
  const tools = {
    setEmailContext: vi.fn(),
    getPhase1ToolSchemas: () => [],
    executeTool: vi.fn(async (name) => {
      if (name === "fetch_context")
        return { accounts: [{ id: "acc-card", name: "Test Card", closed: false }], categories: [], payees: [] };
      if (name === "search_memory") return { results: [] };
      return true;
    }),
  };
  const orch = new AgentOrchestrator(CONFIG, tools);
  const reply = (obj) => ({ choices: [{ message: { content: typeof obj === "string" ? obj : JSON.stringify(obj) } }] });
  const chat = vi.fn().mockResolvedValueOnce(reply(phase1));
  for (const c of conversions) {
    if (c instanceof Error) chat.mockRejectedValueOnce(c);
    else chat.mockResolvedValueOnce(reply(c));
  }
  orch._llm = { chat };
  return orch;
}

const charge = (over = {}) => ({
  merchant: "Alpha Ride",
  amount_cents: -5000000,
  date: TODAY,
  currency: "IDR",
  budget_id: "Budget SGD",
  account_id: "acc-card",
  account_name: "Test Card",
  skip: false,
  ...over,
});

describe("foreign-currency card charges (#796)", () => {
  it("converts to the card's currency and keeps the original in the note", async () => {
    const orch = orchestrator(charge(), { amount: 4.1 });
    const out = await orch._runPhase1(BODY, {});
    expect(out.currency).toBe("SGD");
    expect(out.budget_id).toBe("Budget SGD");
    expect(out.amount_cents).toBe(-410);
    expect(out.notes).toMatch(/IDR 50,?000\.00/);
    expect(out.notes).toMatch(/approx/i);
    const prompt = orch._llm.chat.mock.calls[1][0][0].content;
    expect(prompt).toContain("IDR");
    expect(prompt).toContain("SGD");
  });

  it("a card in the secondary budget converts to the secondary currency", async () => {
    const orch = orchestrator(charge({ budget_id: "Budget MYR" }), { amount: 14.5 });
    const out = await orch._runPhase1(BODY, {});
    expect(out.currency).toBe("MYR");
    expect(out.budget_id).toBe("Budget MYR");
    expect(out.amount_cents).toBe(-1450);
  });

  it("keeps the sign of a refund", async () => {
    const orch = orchestrator(charge({ amount_cents: 5000000 }), { amount: 4.1 });
    expect((await orch._runPhase1(BODY, {})).amount_cents).toBe(410);
  });

  it.each([
    ["unparseable", "not json"],
    ["zero", { amount: 0 }],
    ["negative", { amount: -3 }],
    ["missing", {}],
  ])("a %s conversion is held, not booked in the foreign amount", async (_label, reply) => {
    const out = await orchestrator(charge(), reply)._runPhase1(BODY, {});
    expect(out.account_id).toBeFalsy();
    expect(out.notify_message).toMatch(/IDR/);
    expect(out.notify_message).toMatch(/not booked|held/i);
  });

  it("an LLM outage during conversion surfaces as an outage", async () => {
    const orch = orchestrator(charge(), new LLMUnavailableError("down"));
    await expect(orch._runPhase1(BODY, {})).rejects.toBeInstanceOf(LLMUnavailableError);
  });

  it("a charge in the budget currency makes no conversion call", async () => {
    const orch = orchestrator(charge({ currency: "SGD", amount_cents: -410 }));
    const out = await orch._runPhase1(BODY, {});
    expect(out.amount_cents).toBe(-410);
    expect(orch._llm.chat).toHaveBeenCalledTimes(1);
  });
});
