/**
 * Issue #796: the Phase-1 date fallback and its 15-day window are measured from
 * the email's received time, not the wall clock. email-intake processes mail
 * late (moved out of Spam, already read, after downtime, replays); a wall-clock
 * "today" books such mail on the processing day or rejects it as too old.
 *
 * Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentOrchestrator } from "../src/orchestrator.js";

const NOW = "2026-10-12T04:00:00.000Z";
const RECEIVED = "2026-09-20T02:00:00.000Z"; // 22 days before NOW

function orchestrator(llmDate) {
  const tools = {
    setEmailContext: vi.fn(),
    getPhase1ToolSchemas: () => [],
    executeTool: vi.fn(async (name) => {
      if (name === "fetch_context")
        return { accounts: [{ id: "acc-1", name: "Test Card", closed: false }], categories: [], payees: [] };
      if (name === "search_memory") return { results: [] };
      return true;
    }),
  };
  const orch = new AgentOrchestrator(
    {
      primaryCurrency: "SGD",
      secondaryCurrency: "MYR",
      primaryBudgetFile: "Budget SGD",
      secondaryBudgetFile: "Budget MYR",
      llmProvider: "deepseek",
      llmApiKey: "k",
      deepseekApiKey: "k",
    },
    tools,
  );
  const answer = {
    merchant: "Alpha Cafe",
    amount_cents: -500,
    date: llmDate,
    currency: "SGD",
    account_id: "acc-1",
    account_name: "Test Card",
    skip: false,
  };
  orch._llm = {
    chat: vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] })),
  };
  return orch;
}

const NO_DATE_BODY = "From: alerts@bank.example\nSubject: Card alert\n\nA charge of SGD 5.00 at Alpha Cafe.";
const DATED_BODY = "From: alerts@bank.example\nSubject: Card alert\n\nA charge of SGD 5.00 at Alpha Cafe on 19 Sep 2026.";

describe("Phase 1 date is anchored to the email's received time (#796)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => vi.useRealTimers());

  it("a body without a date books on the received date, not the processing day", async () => {
    const result = await orchestrator("2026-09-01")._runPhase1(NO_DATE_BODY, { receivedAt: RECEIVED });
    expect(result.date).toBe("2026-09-20");
  });

  it("a dated body older than 15 days from now is accepted when near its received time", async () => {
    const orch = orchestrator("2026-09-19");
    const result = await orch._runPhase1(DATED_BODY, { receivedAt: RECEIVED });
    expect(result.date).toBe("2026-09-19");
    expect(orch._llm.chat).toHaveBeenCalledTimes(1);
  });

  it("without a received time the fallback stays the processing day", async () => {
    const result = await orchestrator("2026-09-01")._runPhase1(NO_DATE_BODY, {});
    expect(result.date).toBe("2026-10-12");
  });
});
