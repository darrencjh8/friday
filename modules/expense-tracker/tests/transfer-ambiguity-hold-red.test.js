import { describe, it, expect } from "vitest";
import { parseBankMovement } from "../src/bank-movement.js";

/**
 * RED evidence for the review findings on PR #654 (second file).
 *
 * Finding A (High): the Ryt branch's own comment claims resolution "holds
 * rather than guessing when that is ambiguous". It does not. `own_account`
 * carries only a bank, `resolveAccountByBank` requires exactly one live match,
 * so with 2+ accounts at the sender bank `_resolveMovementToOutput` returns
 * null and the alert is DROPPED as "couldn't understand" — never held, never
 * booked, never surfaced. That is the exact regression this branch exists to
 * remove, and it hits any holder with two accounts at Ryt.
 *
 * Finding B (High, hardening): `_card_repayment` is a new Phase-1 field the
 * sanitizer list does not delete, so an LLM can forge it. It currently only
 * adds a hold, but it is LLM-reachable control flow and belongs with its
 * siblings.
 */

const RYT_SCHEDULED = `Dear Customer,

Your scheduled transfer of RM908.25 to ACCOUNT HOLDER on 1/10/2026, 10:02 AM (GMT+8) was successfully completed.

Thank you for banking with us.
Ryt Bank App and head to Scheduled Transfers.`;

describe("Ryt scheduled transfer with an ambiguous sender-bank account", () => {
    it("is held, never silently dropped, when two accounts share the bank", async () => {
        const { phase1, result } = await runAmbiguous();

        // The failure mode is a null phase1: every parser declines and the
        // user gets "Couldn't understand this transaction alert."
        expect(phase1).not.toBeNull();
        expect(result.action).toBe("notified");
        expect(result.details).not.toBe("Couldn't understand this transaction alert.");
    });

    it("cannot be forged into Phase-1 output", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const accounts = [
            { id: "dbs-acct", name: "DBS Account", closed: false },
            { id: "ocbc-360", name: "OCBC 360", closed: false },
            { id: "trust", name: "Trust Bank", closed: false },
        ];
        const tools = {
            executeTool: async (name) => {
                if (name === "fetch_context")
                    return { accounts, categories: [], payees: [] };
                if (name === "search_memory") return { results: [] };
                return true;
            },
            getPhase1ToolSchemas: () => [],
            setEmailContext: () => {},
        };
        const orch = new AgentOrchestrator(
            {
                primaryCurrency: "SGD",
                secondaryCurrency: "MYR",
                primaryBudgetFile: "b",
                secondaryBudgetFile: "m",
                llmProvider: "deepseek",
                llmApiKey: "test",
                deepseekApiKey: "test",
            },
            tools,
        );
        orch._llm.chat = async () => ({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            merchant: "OverseaChinese Banking Corporation Ltd",
                            amount_cents: -648,
                            date: "2026-09-27",
                            currency: "SGD",
                            account_id: "trust",
                            account_name: "Trust Bank",
                            payee_name: "",
                            category_id: null,
                            reasoning: "x",
                            notify_message: "",
                            _card_repayment: true,
                        }),
                    },
                },
            ],
        });

        const out = await orch._runPhase1(
            "Notice of something. Ref XYZ. Qty 3. S$6.48. Ref ABC-9.",
            { senderBank: "Trust", receivedAt: "2026-09-27T03:49:46.000Z" },
        );

        expect(out).toBeTruthy();
        expect(out._card_repayment).toBeUndefined();
    });
});

async function runAmbiguous() {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    // Two live accounts at Ryt — ordinary for a real holder.
    const accounts = [
        { id: "ryt-1", name: "Ryt Bank Account", closed: false },
        { id: "ryt-2", name: "Ryt Savings Account", closed: false },
    ];
    const calls = [];
    const tools = {
        executeTool: async (name, args) => {
            calls.push({ name, args });
            if (name === "fetch_context")
                return { accounts, categories: [], payees: [] };
            if (name === "search_memory") return { results: [] };
            if (name === "list_facts") return { facts: [] };
            if (name === "check_duplicate") return false;
            if (name === "check_schedule_collision") return false;
            if (name === "find_link_candidate")
                return { candidate: null, matches: 0 };
            if (name === "find_inserted_transfer") return null;
            if (name === "reserve_transfer")
                return { status: "reserved", entry: { id: 1 } };
            return true;
        },
        getPhase1ToolSchemas: () => [],
        setEmailContext: () => {},
    };
    const orch = new AgentOrchestrator(
        {
            primaryCurrency: "SGD",
            secondaryCurrency: "MYR",
            primaryBudgetFile: "budget-sgd",
            secondaryBudgetFile: "budget-myr",
            llmProvider: "deepseek",
            llmApiKey: "test",
            deepseekApiKey: "test",
        },
        tools,
    );
    // Stands in for a real LLM that cannot read this sentence either — the
    // branch's own justification for parsing it deterministically.
    orch._llm.chat = async () => ({
        choices: [{ message: { content: "null" } }],
    });

    const phase1 = await orch._runPhase1(RYT_SCHEDULED, {
        senderBank: "Ryt",
        receivedAt: "2026-10-01T02:03:00.000Z",
    });
    const phase2 = phase1 ? await orch._resolvePhase2(phase1) : null;
    const result = phase2 ? await orch._executePhase3(phase2) : null;

    return { phase1, phase2, result, calls };
}