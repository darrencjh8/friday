// Reproduction for dev-loop code review round 2, finding M2.
//
// A coincident Actual Budget outage must not suppress the OneDrive signal: the
// early return in _computeSyncAll must carry the leg results that already ran.
// The path is resolved from the working directory, because the driver runs this
// once in a base worktree (must fail) and once at HEAD (must pass).
import { formatSyncResult } from "./src/mcp-server.js";

// The exact shape the tools.js:953 early return produced before the fix.
const raw = {
    error: "Budget SGD Budget: HTTP 500: boom",
    sync_targets: [
        { name: "Warchest", status: "skipped", delta: 0, error: "OneDrive not synced" },
    ],
};

const out = formatSyncResult(raw);
if (out.includes("boom")) {
    console.log("PASS repro627.m2-ab-budget-abort-reaches-the-operator");
    process.exit(0);
}
console.log(`--- actual output: ${JSON.stringify(out)} ---`);
console.log(
    "FAIL repro627.m2-ab-budget-abort-reaches-the-operator: the AB abort reason was not reported, so a dead grant looked clean during an AB outage",
);
process.exit(1);
