// Issue #680 - reproduction probe for the dropped incoming credit.
//
// Payload of `loop.py repro`. Tracked in the repository so the driver can run it
// in its throwaway BASE worktree (tracked files only, no node_modules). See
// repro-680-loader.mjs for why the dependencies are stubbed, and
// darrencjh8/codex-router#352 for why the driver cannot be handed a real install.
//
// It prints a line naming the reproduction on failure and exits non-zero, so the
// driver's `failure_line_mentions` check has real evidence to read.
import { AgentOrchestrator } from "./src/orchestrator.js";

// The live `Darren SGD` accounts and the real suffix fact, from Actual Budget
// and the fact store.
const ACCOUNTS = [
    { id: "acc-dbs", name: "DBS Account", closed: false },
    { id: "acc-altitude", name: "DBS Altitude Card", closed: false },
    { id: "acc-yuu", name: "DBS Yuu Card", closed: false },
];
const FACTS = ["Account ending 7222 belongs to DBS Account"];

// uid 1030, PII-redacted the way this repository redacts production bodies: the
// suffix is kept so suffix-to-account pairing still resolves, names and amounts
// are shortened.
const BODY =
    "digibank Alerts - You have received a transfer Transaction Ref: 0126100100114350 " +
    "Dear Customer, You have received SGD 1000.00 via FAST transfer on 01 Oct 2026 21:14 SGT. " +
    "From: ACCOUNT HOLDER To: Your DBS/ POSB account ending 7222 ";

const tools = {
    executeTool: async (name, args) => {
        if (name === "fetch_context") return { accounts: ACCOUNTS, categories: [], payees: [] };
        if (name === "search_memory")
            return {
                results: FACTS.filter((f) => f.includes(String(args?.query ?? ""))).map((text) => ({
                    text,
                })),
            };
        if (name === "list_facts") return { facts: FACTS.map((text) => ({ text })) };
        return true;
    },
    getPhase1ToolSchemas: () => [],
    setEmailContext: () => {},
};

const orch = new AgentOrchestrator(
    {
        primaryCurrency: "SGD",
        secondaryCurrency: "MYR",
        primaryBudgetFile: "Darren SGD",
        secondaryBudgetFile: "Darren MYR",
        llmProvider: "deepseek",
        llmApiKey: "t",
        deepseekApiKey: "t",
    },
    tools,
);
// Any LLM fallback throws, so a drop cannot be masked by the extractor route.
orch._llm = {
    chat: async () => {
        throw new Error("LLM must not be reached");
    },
};

const out = await orch._runStructuredMovement(BODY, "DBS", "2026-10-01T13:14:00.000Z");
console.log("resolved:", JSON.stringify(out));

if (out === null) {
    console.log("FAIL: an incoming credit into a resolvable account is dropped (issue #680)");
    process.exit(1);
}
if (out.account_name !== "DBS Account" || out.amount_cents !== 100000) {
    console.log(
        `FAIL: an incoming credit into a resolvable account is dropped (issue #680) ` +
            `- booked to ${out.account_name} / ${out.amount_cents}`,
    );
    process.exit(1);
}
console.log("PASS: incoming credit booked on DBS Account");
