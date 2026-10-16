import { describe, it, expect } from "vitest";
import { parseBankMovement } from "../src/bank-movement.js";
import { OWN_LEGAL_NAME_FACT } from "./helpers/own-name.js";

/**
 * RED evidence for the review findings on PR #654.
 *
 * A person-to-person transfer must never be booked as spend. The Ryt
 * scheduled-transfer branch sets `person_transfer`, but nothing reads it, so
 * the hold only fires when the counterparty happens to be the holder's own
 * legal name AND memory recalls that fact. Any other person always books.
 *
 * Body shape taken from the branch's own uid 1012 fixture (third-party name
 * placeholdered); amounts/dates retained because they are what resolution
 * keys on.
 */
const RYT_SCHEDULED_PERSON = `Dear Customer,

Your scheduled transfer of RM908.25 to ACCOUNT HOLDER on 1/10/2026, 10:02 AM (GMT+8) was successfully completed.

Thank you for banking with us.
Ryt Bank App and head to Scheduled Transfers.`;

/**
 * The only person-hold gate is orchestrator.js:749-765, and it requires the
 * counterparty to be the holder's OWN legal name. A transfer to somebody else
 * must still be held, because there is no verified other leg.
 */
const RYT_OTHER_PERSON = RYT_SCHEDULED_PERSON.replace(
    "ACCOUNT HOLDER",
    "LEE WEI LING",
);

describe("Ryt scheduled transfer to a person is held, not spent", () => {
    it("marks a person counterparty as a person transfer", () => {
        const movement = parseBankMovement(RYT_SCHEDULED_PERSON, {
            senderBank: "Ryt",
            receivedAt: "2026-10-01T02:03:00.000Z",
        });

        // The branch already sets this, so pin the field's meaning: it is what
        // the hold is supposed to key on.
        expect(movement.person_transfer).toBe(true);
        expect(movement.merchant_display_name).toBe("ACCOUNT HOLDER");
    });

    it("holds a transfer to the holder when no legal-name fact is recalled", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        // Memory returns NO legal-name fact. This is the state the branch's
        // safety property silently depends on.
        const facts = [];
        const { result, inserted, hold } = await runTransfer(
            RYT_SCHEDULED_PERSON,
            "ACCOUNT HOLDER",
            facts,
        );

        expect(hold).toBe(true);
        expect(inserted).toBe(false);
        expect(result.action).toBe("notified");
    });

    it("holds a transfer to a person who is not the holder", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        // Legal-name fact IS present — proving the hold cannot be reached by
        // any counterparty other than the holder.
        const facts = [
            {
                text: `${OWN_LEGAL_NAME_FACT} -> ABCD (statement password)`,
                score: 1,
            },
        ];
        const { result, inserted, hold } = await runTransfer(
            RYT_OTHER_PERSON,
            "LEE WEI LING",
            facts,
        );

        expect(hold).toBe(true);
        expect(inserted).toBe(false);
        expect(result.action).toBe("notified");
    });
});

/**
 * Run one Ryt alert through the real pipeline with a single live account at
 * the sender bank (the state where source resolution succeeds).
 */
async function runTransfer(body, merchant, facts) {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const accounts = [{ id: "ryt-1", name: "Ryt Bank Account", closed: false }];
    const calls = [];
    const tools = {
        executeTool: async (name, args) => {
            calls.push({ name, args });
            if (name === "fetch_context")
                return { accounts, categories: [], payees: [] };
            if (name === "search_memory") return { results: facts };
            if (name === "list_facts") return { facts };
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
    orch._llm.chat = async () => ({
        choices: [{ message: { content: "null" } }],
    });

    const phase1 = await orch._runPhase1(body, {
        senderBank: "Ryt",
        receivedAt: "2026-10-01T02:03:00.000Z",
    });
    const phase2 = phase1 ? await orch._resolvePhase2(phase1) : null;
    const result = phase2 ? await orch._executePhase3(phase2) : null;
    const inserted = calls.some((c) => c.name === "insert_transaction");

    return {
        phase1,
        phase2,
        result,
        inserted,
        hold: Boolean(phase2?._hold_unresolved_transfer),
    };
}