import { describe, expect, it } from "vitest";
import { zeroDueSummary } from "../../src/statement/orchestrator.js";

const NO_PDF = Buffer.from("Content-Type: text/plain\r\n\r\nbody");

describe("zeroDueSummary with amounts in the body (#49)", () => {
  it.each([
    "Total Due: RM 0.00 Transactions: 05/10 GROCER RM45.50 12/10 CAFE RM8.00",
    "Total Due: RM0.00 05/10 GROCER 45.50",
    "Amount Due: $0 Payment received $120",
  ])("keeps the LLM path for %j", (text) => {
    expect(zeroDueSummary(NO_PDF, text)).toBeNull();
  });

  it.each([
    "Total Due: RM0.00 Minimum Due: RM0.00 Due Date: 24/10/2026",
    "Total Due: RM0.00 Fees: RM0.00",
    "Statement Balance: 0,00 Your card ending 1234 has no activity.",
  ])("still skips a true zero summary %j", (text) => {
    expect(zeroDueSummary(NO_PDF, text)).not.toBeNull();
  });
});
