/**
 * Load the daily Portfolio Performance balance-sync mapping from the private
 * wiki page. The page is mounted read-only into the container, so the cron run
 * reads the current mapping without a redeploy and without any account
 * identifier living in this repository.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const METRICS = new Set([
    "emergency_total",
    "investment_total",
    "account_balances",
]);
const BUDGETS = new Set(["primary", "secondary"]);

function invalid() {
    throw new Error("Sync target mapping is invalid");
}

function validate(doc) {
    if (!doc || doc.version !== 1 || !Array.isArray(doc.targets) || doc.targets.length === 0) {
        invalid();
    }
    const keys = new Set();
    const destinations = new Set();
    const targets = doc.targets.map((item) => {
        if (!item || typeof item.key !== "string" || !item.key || keys.has(item.key)) invalid();
        if (!BUDGETS.has(item.budget) || !METRICS.has(item.metric)) invalid();
        if (
            typeof item.portfolio_account_id !== "string" ||
            !item.portfolio_account_id ||
            destinations.has(item.portfolio_account_id)
        ) {
            invalid();
        }
        keys.add(item.key);
        destinations.add(item.portfolio_account_id);
        const target = {
            key: item.key,
            budget: item.budget,
            metric: item.metric,
            portfolio_account_id: item.portfolio_account_id,
        };
        if (item.metric === "account_balances") {
            const ids = item.actual_account_ids;
            if (
                !Array.isArray(ids) ||
                ids.length === 0 ||
                new Set(ids).size !== ids.length ||
                ids.some((id) => typeof id !== "string" || !id)
            ) {
                invalid();
            }
            target.actual_account_ids = [...ids];
        }
        return target;
    });
    return targets;
}

export function loadSyncTargets(config = {}) {
    const file =
        config.syncTargetsFile ||
        (config.wikiDir ? join(config.wikiDir, "portfolio-sync-targets.md") : "");
    if (!file) throw new Error("Sync target mapping is not configured");

    let text;
    try {
        text = readFileSync(file, "utf8");
    } catch {
        throw new Error("Sync target mapping cannot be read");
    }

    const block = text.match(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```/);
    let doc;
    try {
        doc = JSON.parse(block ? block[1] : "");
    } catch {
        invalid();
    }
    return validate(doc);
}
