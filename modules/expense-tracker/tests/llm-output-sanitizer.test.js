import { it, expect, vi } from "vitest";

// Review round 2 on #622, HIGH finding: the Phase-1 sanitizer stripped
// `_suffix_mappings`, `payee_id`, `_transfer`, `_is_transfer`,
// `_hold_unresolved_paynow` and `_hold_unresolved_transfer` from LLM JSON —
// but not `_structured_movement`. The Phase-1 output object is built with
// `...llmOutput`, so an untrusted value survived into Phase 2, where
// `_structured_movement` SKIPS the transfer-destination ambiguity gate
// (`!output._structured_movement && transferDestinationIsAmbiguous(...)`).
// A forged value therefore books a transfer that the gate would have refused.
//
// Note the flag's polarity is opposite at its other consumer: the
// schedule-collision check REQUIRES it (`... && llmOutput._structured_movement
// === true`), so there a forged value only adds holds. Only the skipped
// destination gate is a wrong-booking risk, and that is what this test guards.
//
// The test asserts the invariant directly: whatever the LLM claims, the flag
// must not survive the sanitizer. It is a sanitizer test, not a booking test,
// so it cannot be satisfied by some other guard happening to hold the row.

const ARGS = {
    merchant: "OverseaChinese Banking Corporation Ltd",
    amount_cents: -648,
    date: "2026-09-27",
    currency: "SGD",
    account_id: "trust-bank",
    account_name: "Trust Bank",
    payee_name: "OCBC 360",
    raw_description: "Transfer to OCBC 360",
    notes: "",
    category_id: null,
    reasoning: "x",
    notify_message: "",
};

async function phase1WithExtraFields(extra) {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const accounts = [
        { id: "ocbc-360", name: "OCBC 360", closed: false },
        { id: "ocbc-90n", name: "OCBC 90N", closed: false },
        { id: "trust-bank", name: "Trust Bank", closed: false },
    ];
    const payees = [
        { id: "p-ocbc-360", name: "OCBC 360", transfer_acct: "ocbc-360" },
        { id: "p-ocbc-90n", name: "OCBC 90N", transfer_acct: "ocbc-90n" },
        { id: "p-trust", name: "Trust Bank", transfer_acct: "trust-bank" },
    ];
    const tools = {
        executeTool: vi.fn(async (name) => {
            if (name === "fetch_context")
                return { accounts, categories: [], payees };
            if (name === "search_memory") return { results: [] };
            return true;
        }),
        getPhase1ToolSchemas: vi.fn(() => []),
        setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(
        {
            primaryCurrency: "SGD",
            secondaryCurrency: "MYR",
            primaryBudgetFile: "b",
            secondaryBudgetFile: "m",
            llmProvider: "deepseek",
            llmApiKey: "x",
            deepseekApiKey: "x",
        },
        tools,
    );
    // Phase 1 reads raw JSON out of `message.content` (not tool calls), so the
    // chat client is mocked to return exactly what an LLM would return.
    orch._llm.chat = vi.fn(async () => ({
        choices: [
            {
                message: {
                    content: JSON.stringify({ ...ARGS, ...extra }),
                },
            },
        ],
    }));
    // A body no deterministic parser understands, so Phase 1 takes the LLM path.
    return orch._runPhase1(
        "Notice of something. Ref XYZ. Qty 3. S$6.48. Ref ABC-9.",
        { senderBank: "Trust", receivedAt: "2026-09-27T03:49:46.000Z" },
    );
}

it("strips an LLM-injected _structured_movement from Phase-1 output", async () => {
    const out = await phase1WithExtraFields({ _structured_movement: true });
    expect(out).toBeTruthy();
    // The flag is a claim that a deterministic parser resolved both legs. The
    // LLM has no standing to make it, so it must not reach Phase 2.
    expect(out._structured_movement).toBeUndefined();
});

it("strips the other LLM-injectable internal flags too", async () => {
    const out = await phase1WithExtraFields({
        _transfer: { budget_id: "b", source_account_id: "trust-bank" },
        _is_transfer: true,
        _suffix_mappings: [{ suffix: "6600", accountName: "OCBC 360" }],
        _hold_unresolved_transfer: true,
        _hold_unresolved_paynow: true,
        payee_id: "p-forged",
    });
    expect(out).toBeTruthy();
    expect(out._transfer).toBeUndefined();
    expect(out._is_transfer).toBeUndefined();
    expect(out._suffix_mappings).toBeUndefined();
    expect(out._hold_unresolved_transfer).toBeUndefined();
    expect(out._hold_unresolved_paynow).toBeUndefined();
    expect(out.payee_id).toBeUndefined();
});
