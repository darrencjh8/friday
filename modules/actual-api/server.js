const actual = require("@actual-app/api");
const express = require("express");
const { mkdirSync } = require("fs");
const {
    clientVersion,
    isClientBehind,
    serverVersion,
    notifyOnce,
} = require("./version-check");

const PORT = process.env.PORT || 3000;
const SERVER_URL =
    process.env.ACTUAL_BUDGET_SERVER_URL || process.env.ACTUAL_BUDGET_URL;
const PASSWORD = process.env.ACTUAL_BUDGET_PASSWORD;
const PRIMARY_BUDGET_FILE = process.env.ACTUAL_PRIMARY_BUDGET_FILE;
const DATA_DIR = process.env.DATA_DIR || "/tmp/actual-data";
const BUDGET_SWITCH_DELAY_MS = parseInt(
    process.env.BUDGET_SWITCH_DELAY_MS || "2000",
    10,
);

mkdirSync(DATA_DIR, { recursive: true });

if (!PRIMARY_BUDGET_FILE) {
    console.error("ERROR: ACTUAL_PRIMARY_BUDGET_FILE is required but not set");
    process.exit(1);
}

// Catch unhandled rejections from @actual-app/api internal sync
// The library sometimes throws unhandled rejections during background sync
// which would otherwise crash the Node process.
process.on("unhandledRejection", (reason, promise) => {
    console.error(
        "Unhandled Rejection (non-fatal):",
        reason?.message || reason,
    );
    // Do not crash — the API can still serve cached data
});

let initialized = false;
let initPromise = null;
let activeSyncId = null;
let budgetCache = {}; // syncId → loaded flag
let budgetLock = Promise.resolve(); // mutex to serialize budget operations
let lastSwitchTime = 0; // timestamp of last budget switch

async function retryWithBackoff(fn, maxRetries = 3, baseDelayMs = 1000) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastError = e;
            const isNetworkError =
                e.message &&
                (e.message.includes("network") ||
                    e.message.includes("ECONNREFUSED") ||
                    e.message.includes("ECONNRESET") ||
                    e.message.includes("ETIMEDOUT") ||
                    e.message.includes("fetch"));
            if (!isNetworkError || attempt >= maxRetries) throw e;
            const delay = baseDelayMs * Math.pow(2, attempt);
            console.log(
                `Retry ${attempt + 1}/${maxRetries} in ${delay}ms: ${e.message}`,
            );
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastError;
}

function acquireLock() {
    const prev = budgetLock;
    let release;
    budgetLock = new Promise((resolve) => {
        release = resolve;
    });
    // The catch keeps a rejected tail from swallowing the release: without it
    // the await throws before the caller receives release, and the mutex stays
    // wedged for the life of the process. No current caller rejects prev.
    return prev.catch(() => {}).then(() => release);
}

/**
 * Download a budget and confirm it opened. `downloadBudget` resolves even when
 * the library closed the budget on `out-of-sync-migrations` (a newer client
 * migrated it), so the open check is what turns that into a diagnosable error.
 * Issue #799.
 */
async function downloadAndOpen(syncId) {
    await retryWithBackoff(() =>
        actual.downloadBudget(syncId, { password: PASSWORD }),
    );
    if (await budgetIsOpen()) return;
    let detail = "server version could not be read";
    try {
        const client = clientVersion();
        const server = await serverVersion(SERVER_URL);
        if (isClientBehind(client, server)) {
            const message = `ACTUAL_VERSION_MISMATCH: @actual-app/api ${client} is older than sync-server ${server}; a newer client migrated budget ${syncId}. Bump @actual-app/api in modules/actual-api.`;
            await notifyOnce(message);
            throw new Error(message);
        }
        detail = `client ${client}, server ${server}`;
    } catch (e) {
        if (/^ACTUAL_VERSION_MISMATCH/.test(e.message)) throw e;
    }
    throw new Error(
        `Budget ${syncId} did not open after download (${detail}); see actual-api logs`,
    );
}

async function init() {
    if (initialized) return;
    if (initPromise) return initPromise;
    initPromise = (async () => {
        await retryWithBackoff(() =>
            actual.init({
                serverURL: SERVER_URL,
                password: PASSWORD,
                dataDir: DATA_DIR,
            }),
        );
        const budgets = await getBudgets();
        const budget = budgets.find((b) => b.name === PRIMARY_BUDGET_FILE);
        if (!budget) {
            const notFound = new Error(
                `Budget "${PRIMARY_BUDGET_FILE}" not found`,
            );
            // Tagged so `GET /budgets` can answer the real budget names for a
            // mistyped configuration without also masking an authentication or
            // network failure, which must stay a 500.
            notFound.code = "BUDGET_NOT_FOUND";
            throw notFound;
        }
        activeSyncId = budget.groupId || budget.cloudFileId;
        await downloadAndOpen(activeSyncId);
        budgetCache[activeSyncId] = true;
        initialized = true;
        console.log(`Loaded: ${budget.name} (${activeSyncId})`);
    })();
    initPromise.catch((e) => {
        console.error("Init failed, will retry on next request:", e.message);
        initPromise = null;
        initialized = false;
    });
    return initPromise;
}

const BUDGET_LIST_TTL_MS = 60 * 1000;
let budgetList = null; // { promise, at }

/**
 * The budget list for name resolution, shared by concurrent requests and reused
 * for `BUDGET_LIST_TTL_MS`. Each `getBudgets()` asks the sync server for its file
 * list, so a burst of requests that each fetched it drew HTTP 429s (#73). A
 * rejected fetch is dropped so the next request tries again.
 *
 * ponytail: a budget created on the server stays invisible to name resolution
 * for up to a minute; invalidate on a miss if that ever matters.
 */
function cachedBudgetList() {
    if (budgetList && Date.now() - budgetList.at < BUDGET_LIST_TTL_MS) {
        return budgetList.promise;
    }
    const entry = { promise: getBudgets(), at: Date.now() };
    budgetList = entry;
    entry.promise.catch(() => {
        if (budgetList === entry) budgetList = null;
    });
    return entry.promise;
}

/** Test-only: forget the cached budget list. */
function resetBudgetListCache() {
    budgetList = null;
}

/** Resolve the requested budget, or null. Read-only; takes no lock. */
async function resolveBudgetTarget(budgetIdOrName) {
    await init();
    if (!budgetIdOrName) return null;

    const budgets = await cachedBudgetList();
    const target = budgets.find(
        (b) =>
            (b.groupId || b.cloudFileId) === budgetIdOrName ||
            b.name === budgetIdOrName,
    );
    return target || null;
}

function syncIdOf(budget) {
    return budget.groupId || budget.cloudFileId;
}

/**
 * The raw `actual.getBudgets()` list. It can list the same budget more than
 * once — two DATA_DIR directories holding a copy under one sync id — and every
 * entry must stay visible here: `init()` and `resolveBudgetTarget()` match with
 * `.find()`, so dropping an entry whose name differs from an earlier twin's
 * would hide the very name the caller asked for (#390). Deduplication is a
 * display concern and lives only in the `GET /budgets` response.
 */
async function getBudgets() {
    return retryWithBackoff(() => actual.getBudgets());
}

/**
 * Whether the library currently has a budget open. `getAccounts` is an
 * in-memory read of the loaded spreadsheet, so the probe is cheap, and it is
 * the only public way to ask: the library throws "No budget file is open"
 * instead of exposing its loaded-budget flag.
 *
 * Only that message means the budget is closed. Any other failure is rethrown
 * so it reaches the route's 500 instead of being read as "closed", which would
 * start a download that holds the global lock through its retry backoff.
 */
async function budgetIsOpen() {
    try {
        await actual.getAccounts();
        return true;
    } catch (e) {
        if (/No budget file is open/.test(e?.message || "")) return false;
        throw e;
    }
}

/**
 * Load `activeSyncId` again after the library lost its open budget. The library
 * closes the budget that is open before it fetches the next one, so a
 * `downloadBudget` that fails on the sync server — on its own or as part of a
 * switch — leaves the process budgetless while `activeSyncId` still names the
 * budget that used to be open. Nothing else brings it back: `init()` never runs
 * again, and every later request names that same sync id. Issue #549.
 */
async function reopenActiveBudget() {
    if (!activeSyncId) return;
    await downloadAndOpen(activeSyncId);
    budgetCache[activeSyncId] = true;
    console.log(`Reopened the budget the library had closed (${activeSyncId})`);
}

/**
 * Switch the active budget when `target` differs, and reopen it when the
 * library has none open. The caller MUST hold the lock: `activeSyncId` is what
 * every write resolves against, so changing it outside the lock is the race in
 * issue #506.
 */
async function applyBudgetSwitch(target) {
    if (!target) {
        // A request that names no budget falls back to whichever budget is
        // active, so that one has to be open too.
        if (await budgetIsOpen()) return;
        await reopenActiveBudget();
        return;
    }
    const syncId = syncIdOf(target);
    if (syncId === activeSyncId) {
        // The same budget is already active, so the only thing left to do is put
        // it back when the library closed it. That is not a switch, so it skips
        // the switch cooldown and its re-check.
        if (await budgetIsOpen()) return;
        await reopenActiveBudget();
        return;
    }

    // Enforce minimum delay between budget switches for preemptible server stability
    const now = Date.now();
    const timeSinceSwitch = now - lastSwitchTime;
    if (timeSinceSwitch < BUDGET_SWITCH_DELAY_MS) {
        const waitMs = BUDGET_SWITCH_DELAY_MS - timeSinceSwitch;
        console.log(`Waiting ${waitMs}ms before budget switch (cooldown)`);
        await new Promise((r) => setTimeout(r, waitMs));
    }

    // Re-check in case another request already switched
    if (syncId === activeSyncId && (await budgetIsOpen())) return;

    // Always download when switching — @actual-app/api needs it to change active budget
    await downloadAndOpen(syncId);
    budgetCache[syncId] = true;
    activeSyncId = syncId;
    lastSwitchTime = Date.now();
    console.log(`Switched to budget: ${target.name} (${syncId})`);
}

/** Returned by `withBudget` when the request named a budget that does not exist. */
const UNKNOWN_BUDGET = Symbol("unknown-budget");

/**
 * Assert the request's budget, then run `fn` while it stays asserted, returning
 * `fn`'s value. Anything that reads or writes through `@actual-app/api` must run
 * inside `fn`: the library keeps one module-global active budget, so a read
 * outside the lock can observe a budget a concurrent request switched to
 * (#390 reads, #506 writes).
 * `acquireLock` is not reentrant, so `fn` must not re-enter the lock on any
 * path: a `withBudget` call always takes it, and an `ensureBudget` call takes it
 * whenever the requested budget is not already active.
 *
 * ponytail: one global mutex now covers every read, so every read serializes
 * behind it. A cross-budget read waits at least one `BUDGET_SWITCH_DELAY_MS`
 * cooldown plus the `downloadBudget` before it starts, and a read that
 * subsequently needs the budget switched back pays a second cooldown
 * (production sets `BUDGET_SWITCH_DELAY_MS=5000` in
 * `modules/docker-compose.yml`). A slow or failing `downloadBudget` inside the
 * lock delays unrelated reads too, because they queue on the same mutex. The
 * accepted ceiling is that a multi-budget caller pays that latency; the upgrade
 * path is one actual-api process per budget, each with its own `DATA_DIR` and
 * port, because the library offers no per-budget context object.
 */
async function withBudget(req, fn) {
    const requested = getBudgetId(req);
    // Resolution is read-only, so it stays outside the lock; existence cannot
    // change while the process runs, and `applyBudgetSwitch` re-checks the
    // active budget inside the lock.
    const target = await resolveBudgetTarget(requested);
    if (requested && !target) return UNKNOWN_BUDGET;

    const unlock = await acquireLock();
    try {
        await applyBudgetSwitch(target);
        // `return await`, not `return fn()`: a bare return would run the
        // `finally` that releases the lock before `fn` settles.
        return await fn();
    } finally {
        unlock();
    }
}

/**
 * Test-only legacy helper; an integration test still calls it. Routes must use
 * `withBudget` instead: this takes the lock only for the switch and leaves the
 * subsequent read outside it, so a concurrent request can switch the active
 * budget and the read can serve the wrong one (#390).
 */
async function ensureBudget(budgetIdOrName) {
    await init();
    if (!budgetIdOrName) return;

    // Reads stay lock-free when the budget is already active; only a switch
    // needs the lock, so a read never queues behind another request's write.
    const target = await resolveBudgetTarget(budgetIdOrName);
    if (!target || syncIdOf(target) === activeSyncId) return;

    const unlock = await acquireLock();
    try {
        await applyBudgetSwitch(target);
    } finally {
        unlock();
    }
}

function getBudgetId(req) {
    return req.query.budget_id || (req.body && req.body.budget_id) || "";
}

/**
 * True when `value` is an integer number of cents: a safe-integer number, or a
 * plain integer string whose value is a safe integer. Number() alone would also
 * accept true, an array like [5], "0x10", and "1e3", which would book 1, 5,
 * 16, or 1000 cents for input nobody sent as an amount. A nullish or blank
 * value is rejected too, because Number(null) and Number("") are both 0. The
 * value must be a safe integer because a longer digit string coerces to a rounded
 * number. Both the request guard and the persisted-row parse use this, so the
 * two cannot drift apart.
 */
function isSafeIntegerAmount(value) {
    if (typeof value === "number") return Number.isSafeInteger(value);
    if (typeof value !== "string") return false;
    return /^-?\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value));
}

function buildTransaction(body) {
    const {
        account,
        account_id,
        date,
        amount,
        payee,
        payee_name,
        imported_payee,
        notes,
        category,
    } = body || {};
    const txn = {
        account: account || account_id,
        date: date || new Date().toISOString().slice(0, 10),
        // Coerce here so a numeric string reaches addTransactions as a number
        // for a transfer counterpart, and so the response reports the same
        // number whether it echoes the request or the persisted row. `|| 0`
        // keeps a direct caller of this exported helper from receiving NaN for
        // a missing or nonnumeric amount. Route validation runs after this
        // helper, but before the coerced amount reaches the API or response.
        amount: Number(amount) || 0,
        payee_name: payee_name || imported_payee || undefined,
        imported_payee: imported_payee || payee_name || undefined,
        notes: notes || "",
        cleared: false,
    };
    // Pass payee ID through to addTransactions (needed for transfers)
    if (payee) txn.payee = payee;
    if (category) txn.category = category;
    return txn;
}

// The insert is identified by diffing transaction ids around it, so the
// snapshot and the read-back must query the same rows. An in-app rule can
// rewrite the inserted row's date, which would hide it from a window scoped to
// the request date alone, so both queries span the neighbouring days.
// ponytail: a rule that moves the date further than one day, or moves the row
// to another account, still yields a null id. Upgrade path: diff the whole
// account instead of a window if that ever happens in practice.
function readWindow(date) {
    const day = new Date(`${date}T00:00:00Z`);
    const shift = (days) =>
        new Date(day.getTime() + days * 86400000).toISOString().slice(0, 10);
    return { start: shift(-1), end: shift(1) };
}

const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/budgets", async (req, res) => {
    try {
        try {
            await init();
        } catch (e) {
            // Only the tagged not-found result is tolerated here, because that
            // is the one outcome where actual.init() succeeded and only the
            // configured name failed to match: this endpoint exists to reveal
            // the real names to the operator who mistyped it. Any other
            // init() rejection is re-thrown and answered 500 below.
            if (e?.code !== "BUDGET_NOT_FOUND") throw e;
        }
        const budgets = await getBudgets();
        // Display-only deduplication: the library can list one budget once per
        // DATA_DIR copy, all sharing the sync id it switches on. Entries are
        // keyed by `syncIdOf`; an entry with no id cannot be proven a duplicate
        // and is kept. When a later entry is named `PRIMARY_BUDGET_FILE` and the
        // kept entry of the same sync id is not, the later one replaces it, so
        // the operator sees the name the process actually loads. Otherwise the
        // first entry of the group is kept.
        const seen = new Map(); // syncId -> index in `unique`
        const unique = [];
        const drops = [];
        for (const b of budgets) {
            const syncId = syncIdOf(b);
            if (!syncId) {
                unique.push(b);
                continue;
            }
            if (!seen.has(syncId)) {
                seen.set(syncId, unique.length);
                unique.push(b);
                continue;
            }
            const index = seen.get(syncId);
            const kept = unique[index];
            // The configured name is preferred only when it appears later in the
            // same sync-id group; an entry already named `PRIMARY_BUDGET_FILE`
            // stays kept, as does the first entry when neither is configured.
            const preferLater =
                kept.name !== PRIMARY_BUDGET_FILE &&
                b.name === PRIMARY_BUDGET_FILE;
            if (preferLater) {
                unique[index] = b;
            }
            const dropped = preferLater ? kept : b;
            drops.push(
                `"${dropped.name}" (sync id ${syncId}, kept "${unique[index].name}")`,
            );
        }
        if (drops.length > 0) {
            console.log(
                `getBudgets: dropped ${drops.length} duplicate budget ${
                    drops.length === 1 ? "entry" : "entries"
                } — ${drops.join("; ")}`,
            );
        }
        res.json(
            unique.map((b) => ({
                name: b.name,
                groupId: b.groupId || null,
                cloudFileId: b.cloudFileId || null,
            })),
        );
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/accounts", async (req, res) => {
    try {
        const accounts = await withBudget(req, () => actual.getAccounts());
        if (accounts === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json(accounts);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/categories", async (req, res) => {
    try {
        const categories = await withBudget(req, () => actual.getCategories());
        if (categories === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json(categories);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/budget-month", async (req, res) => {
    try {
        // The month is request-shaped, so it is settled before the lock.
        const month = req.query.month || new Date().toISOString().slice(0, 7);
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
            return res.status(400).json({ error: "month must be YYYY-MM" });
        }
        const budgetMonth = await withBudget(req, () =>
            actual.getBudgetMonth(month),
        );
        if (budgetMonth === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json(budgetMonth);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/budget-12m", async (req, res) => {
    try {
        const payload = await withBudget(req, async () => {
            const now = new Date();
            let total12m = 0,
                emergency = 0,
                invest = 0;

            // Current month balance
            const curYM = now.toISOString().slice(0, 7);
            try {
                const curData = await actual.getBudgetMonth(curYM);
                for (const g of curData.categoryGroups || [])
                    for (const c of g.categories || []) {
                        if (c.name === "Emergency")
                            emergency = c.balance || 0;
                        if (c.name === "General Investment")
                            invest = c.balance || 0;
                    }
            } catch (e) {
                /* ignore */
            }

            // Next 12 months budgeted
            for (let i = 1; i <= 12; i++) {
                const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
                const ym = d.toISOString().slice(0, 7);
                try {
                    const data = await actual.getBudgetMonth(ym);
                    for (const g of data.categoryGroups || [])
                        for (const c of g.categories || [])
                            total12m += c.budgeted || 0;
                } catch (e) {
                    /* month may not exist yet */
                }
            }
            return {
                total_12_month_budgeted: total12m,
                emergency_balance: emergency,
                investment_balance: invest,
                emergency_total: total12m + emergency,
                investment_total: invest,
                currency: "cents",
            };
        });
        if (payload === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json(payload);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/accounts/balance/:id", async (req, res) => {
    try {
        // Id and cutoff are request-shaped, so both are validated before the
        // lock: a rejected request must not queue behind, or trigger, a switch.
        if (!req.params.id || req.params.id.trim() === "") {
            return res.status(400).json({ error: "Account id is required" });
        }
        let cutoff = undefined;
        if (req.query.cutoff) {
            const d = new Date(req.query.cutoff);
            if (isNaN(d.getTime())) {
                return res
                    .status(400)
                    .json({ error: "Invalid cutoff date (use YYYY-MM-DD)" });
            }
            cutoff = d;
        }
        const balance = await withBudget(req, () =>
            actual.getAccountBalance(req.params.id, cutoff),
        );
        if (balance === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json({ id: req.params.id, balance: balance ?? null });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Read-only schedule list for the requested budget. `getSchedules()` is the
 * only way to see a due scheduled posting BEFORE Actual materialises it: the
 * transactions endpoint cannot, which is why an alert-derived row and a due
 * `posts_transaction` schedule could both land (#586). Guarded like every
 * other route so a missing or throwing library method is a 500, never a crash.
 */
app.get("/schedules", async (req, res) => {
    try {
        if (typeof actual.getSchedules !== "function") {
            return res
                .status(500)
                .json({ error: "Schedules are not supported by this client" });
        }
        const schedules = await withBudget(req, () => actual.getSchedules());
        if (schedules === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json(Array.isArray(schedules) ? schedules : []);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/payees", async (req, res) => {
    try {
        const payees = await withBudget(req, () => actual.getPayees());
        if (payees === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json(payees);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/transactions", async (req, res) => {
    try {
        // Input validation stays outside the lock: it is pure, and a rejected
        // request should not switch budgets. The budget the request names is
        // asserted inside the critical section below instead, because a
        // concurrent request can switch the active budget between the check and
        // the insert (#506).
        const txn = buildTransaction(req.body);
        if (!txn.account) {
            return res.status(400).json({ error: "Account is required" });
        }
        // Amount is money at a trust boundary, so reject a missing or
        // non-integer amount instead of booking it as 0 cents. The full rule,
        // including why blanks and unsafe integers are rejected, lives on
        // isSafeIntegerAmount above.
        if (!isSafeIntegerAmount(req.body?.amount)) {
            return res
                .status(400)
                .json({ error: "Amount must be an integer number of cents" });
        }
        // The snapshot is account-scoped, so the account must be present or the
        // read-back could match a row in a different account.
        // readWindow parses the date and shifts it to the neighbouring days, so
        // an out-of-contract date would either throw inside readWindow or emit a
        // window outside YYYY-MM-DD; reject it explicitly instead. The round
        // trip rejects impossible calendar dates such as 2026-13-01 that a shape
        // check alone accepts, and the year range keeps the shifted dates
        // four-digit ("0000-01-01" would otherwise read back a year -000001).
        const parsedDate = new Date(`${txn.date}T00:00:00Z`);
        if (
            Number.isNaN(parsedDate.getTime()) ||
            parsedDate.toISOString().slice(0, 10) !== txn.date
        ) {
            return res
                .status(400)
                .json({ error: "Invalid date (use YYYY-MM-DD)" });
        }
        if (txn.date < "1000-01-01" || txn.date > "9999-12-30") {
            // Well-formed but outside the range whose neighbouring days stay
            // four-digit, so the format message above would contradict it.
            return res
                .status(400)
                .json({ error: "Date out of supported range" });
        }
        const window = readWindow(txn.date);
        // Serialize the snapshot, the insert, and the read-back. Without this,
        // a concurrent POST could insert the same account's row between this
        // request's snapshot and its read-back, and the read-back would report
        // that stranger's id as this insert's id. The lock is global rather
        // than per-account because runTransfers inserts a counterpart into the
        // destination account, so a lock keyed on the request's account would
        // not cover it. ponytail: a global lock, so inserts queue behind each
        // other and behind a budget switch; key it per account if either the
        // insert rate or the budget-switch cooldown ever makes that visible.
        let beforeIds = null;
        let created = null;
        // withBudget serializes the budget assertion, the snapshot, the insert
        // and the read-back, and answers 400 for a budget that does not exist
        // instead of writing into whichever budget is active.
        const knownBudget = await withBudget(req, async () => {
            // Snapshot the account's rows first so the insert can be identified
            // unambiguously afterwards, even if a rule rewrites its amount, date,
            // or payee.
            try {
                beforeIds = new Set(
                    (
                        await actual.getTransactions(
                            txn.account,
                            window.start,
                            window.end,
                        )
                    ).map((t) => t.id),
                );
            } catch {
                // Without a trustworthy snapshot no row on the window can be
                // proven new, so the read-back is skipped rather than naming a
                // stranger's row. The insert still commits and the response
                // reports a null id.
            }
            // runTransfers makes a transfer payee create its counterpart in the
            // destination account on insert, matching an in-app payee change.
            await actual.addTransactions(txn.account, [txn], {
                runTransfers: true,
            });
            // @actual-app/api resolves addTransactions to "ok" (it discards the
            // new ids), so read the row back to report its real id. Only a row
            // absent from the pre-insert snapshot qualifies; matching on amount
            // or payee alone could return a pre-existing transaction.
            // ponytail: the diff shows which rows are new, not which one this
            // request inserted. When more than one row is new — a rule that also
            // changes transactions on the window, or a PATCH moving a row into
            // it — nothing can be attributed, so the response reports a null id
            // and the request's own fields. Claiming the true id would need
            // addTransactions to return the ids it currently discards.
            if (beforeIds) {
                try {
                    const newRows = (
                        await actual.getTransactions(
                            txn.account,
                            window.start,
                            window.end,
                        )
                    ).filter((t) => !beforeIds.has(t.id));
                    // All or nothing: a single new row is the insert, but adding
                    // a second would make both the id and the fields a guess.
                    if (newRows.length === 1) created = newRows[0];
                } catch {
                    // Read-back is best-effort; the insert already committed.
                }
            }
        });
        if (knownBudget === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        // A synced or imported row can carry the amount as a string and a rule
        // can rewrite it, so the persisted value is held to the same rule as the
        // request: a number, or a plain integer string whose value is a safe
        // integer. Anything else -- a nullish or blank value, a fraction, or a
        // value outside the safe-integer range -- falls back to the amount the
        // request asked for rather than being reported as exact cents.
        const persistedAmount = created?.amount;
        const responseAmount = isSafeIntegerAmount(persistedAmount)
            ? Number(persistedAmount)
            : txn.amount;
        res.json({
            id: created ? created.id : null,
            account: txn.account,
            // Prefer the persisted row: a transfer clears the category, and
            // rules can rewrite notes, amount, date, or cleared, so the request
            // body can be stale. account and payee_name have no comparable
            // persisted value here, so they keep echoing the request.
            date: created?.date ?? txn.date,
            amount: responseAmount,
            payee_name: txn.payee_name,
            notes: created?.notes ?? txn.notes,
            category: (created ? created.category : txn.category) || null,
            cleared: created?.cleared ?? txn.cleared,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/transactions/:id", async (req, res) => {
    try {
        const txn = await withBudget(req, async () =>
            (
                await actual.getTransactions(
                    undefined,
                    "1970-01-01",
                    new Date().toISOString().slice(0, 10),
                )
            ).find((transaction) => transaction.id === req.params.id),
        );
        if (txn === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        if (!txn)
            return res.status(404).json({ error: "Transaction not found" });
        res.json(txn);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Link two EXISTING rows on two different accounts into one transfer pair
 * (issue #598).
 *
 * Actual only writes `transfer_id` from its transfer engine, and that engine is
 * reachable two ways, both wrong for a pair that already exists:
 *   - `runTransfers` on a row carrying the other account's transfer payee calls
 *     onInsert/onUpdate with no `transfer_id`, so it creates a SECOND
 *     counterpart row — the #598 incident already has one row per leg.
 *   - Writing `transfer_id` alone is undone: onUpdate sees no transferred
 *     account and calls removeTransfer, which nulls it back.
 * Writing each leg's own transfer payee AND the partner's `transfer_id`
 * together links the pair in place and creates no counterpart row. Both are
 * verified against a scratch budget on the vendored @actual-app/api 26.9.0.
 */
app.post("/transactions/link-transfer", async (req, res) => {
    try {
        const { outgoing_id, incoming_id } = req.body || {};
        if (!outgoing_id || !incoming_id) {
            return res
                .status(400)
                .json({ error: "outgoing_id and incoming_id are required" });
        }
        if (outgoing_id === incoming_id) {
            return res
                .status(400)
                .json({ error: "A transfer needs two distinct transactions" });
        }
        // The assertion, the reads and the writes share one locked critical
        // section, so a concurrent budget switch cannot land the second write
        // in a different budget (#390, #506).
        const outcome = await withBudget(req, async () => {
            // The route receives ids, not the legs' dates. Keep the existing
            // all-history lookup, but include the Singapore calendar day through
            // its end. UTC "today" excluded a 00:36 SGT #598 pair for a third of
            // the clock and made the route return 404 before either link write.
            const singaporeTomorrow = new Date(
                Date.now() + 8 * 3600000 + 86400000,
            ).toISOString().slice(0, 10);
            const [rows, payees, accounts] = await Promise.all([
                actual.getTransactions(undefined, "1970-01-01", singaporeTomorrow),
                actual.getPayees(),
                actual.getAccounts(),
            ]);
            const byId = new Map((rows || []).map((row) => [row.id, row]));
            const outgoing = byId.get(outgoing_id);
            const incoming = byId.get(incoming_id);
            if (!outgoing || !incoming) {
                return { error: "Transaction not found", status: 404 };
            }
            // A leg already inside a transfer must not be re-pointed: its
            // counterpart row belongs to the pair it was booked with.
            if (outgoing.transfer_id || incoming.transfer_id) {
                return {
                    error: "Transaction is already part of a transfer",
                    status: 400,
                };
            }
            // The pair contract the #598 fallback matches on: opposite signs, a
            // distinct account each, and the same magnitude. A same-account or
            // same-sign pair is a data error, not a transfer.
            if (outgoing.account === incoming.account) {
                return {
                    error: "Transfer legs must sit on two different accounts",
                    status: 400,
                };
            }
            if (
                !Number.isInteger(outgoing.amount) ||
                !Number.isInteger(incoming.amount) ||
                outgoing.amount === 0 ||
                incoming.amount === 0 ||
                Math.sign(outgoing.amount) === Math.sign(incoming.amount) ||
                Math.abs(outgoing.amount) !== Math.abs(incoming.amount)
            ) {
                return {
                    error: "Transfer legs must be opposite, equal amounts",
                    status: 400,
                };
            }
            const live = (accounts || []).filter((a) => !a.closed);
            const isLive = (id) => live.some((account) => account.id === id);
            if (!isLive(outgoing.account) || !isLive(incoming.account)) {
                return { error: "Transfer account is closed or unavailable", status: 400 };
            }
            // Each leg needs the OTHER account's transfer payee. Without it the
            // engine has no transferred account to point at, so the link cannot
            // be written at all.
            const payeeFor = (accountId) =>
                (payees || []).find(
                    (payee) => payee.transfer_acct === accountId && payee.id,
                ) || null;
            const payeeForIncoming = payeeFor(incoming.account);
            const payeeForOutgoing = payeeFor(outgoing.account);
            if (!payeeForIncoming || !payeeForOutgoing) {
                return {
                    error: "No transfer payee for one of the accounts",
                    status: 400,
                };
            }
            // A leg that already points at a transfer account while carrying no
            // transfer_id is a half-pair left by a failed link-back (the engine
            // inserts the counterpart first and links it back second). Writing
            // such a leg, or restoring its transfer payee, makes the engine's
            // onUpdate call addTransfer and INSERT a third counterpart row, so
            // refuse the pair up front instead of inventing a transaction.
            const transferAcctIds = new Set(
                (payees || [])
                    .filter((payee) => payee.transfer_acct)
                    .map((payee) => payee.id),
            );
            if (
                (!outgoing.transfer_id && transferAcctIds.has(outgoing.payee)) ||
                (!incoming.transfer_id && transferAcctIds.has(incoming.payee))
            ) {
                return {
                    error: "A leg already points at a transfer account while unlinked",
                    status: 400,
                };
            }
            // Cleared categories belong to an expense/income pair; a transfer
            // pair carries none, or the residual expense #598 is about stays.
            const outgoingFields = {
                payee: payeeForIncoming.id,
                transfer_id: incoming.id,
                category: null,
            };
            const incomingFields = {
                payee: payeeForOutgoing.id,
                transfer_id: outgoing.id,
                category: null,
            };
            await actual.updateTransaction(outgoing.id, outgoingFields);
            try {
                await actual.updateTransaction(incoming.id, incomingFields);
            } catch (error) {
                // The public API has no atomic two-row update. The first write
                // does not only touch its own row: the engine's onUpdate sees a
                // transfer payee plus a transfer_id and keeps the pair
                // consistent, so the incoming row has already adopted the
                // outgoing account's transfer payee by the time the second
                // write fails. Restoring the first leg alone would therefore
                // leave a half-pair whose far side no longer matches the
                // tracker's Misc-payee candidate search, so neither leg is
                // restored and a retry can never relink the pair.
                // Restore BOTH rows, each to the fields it was read with, so the
                // pair is exactly the unlinked one the caller can retry.
                try {
                    await actual.updateTransaction(outgoing.id, {
                        payee: outgoing.payee || null,
                        transfer_id: outgoing.transfer_id || null,
                        // The external row field is `category`; `category_id` is
                        // the DB column and is undefined on a row read back from
                        // getTransactions, which would silently blank the
                        // category the compensation is meant to restore.
                        category: outgoing.category || null,
                    });
                    // The engine's updateTransfer also copies the written row's
                    // notes and schedule onto the counterpart, so restore those
                    // too: without it a failed link leaves the incoming row
                    // advertising the outgoing leg's statement reference.
                    await actual.updateTransaction(incoming.id, {
                        payee: incoming.payee || null,
                        transfer_id: incoming.transfer_id || null,
                        category: incoming.category || null,
                        notes: incoming.notes ?? null,
                        schedule: incoming.schedule ?? null,
                    });
                } catch (rollbackError) {
                    throw new Error(
                        `Transfer link failed and compensation failed: ${rollbackError.message}`,
                    );
                }
                throw error;
            }
            return {
                status: "linked",
                outgoing_id: outgoing.id,
                incoming_id: incoming.id,
            };
        });
        if (outcome === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        if (outcome.error) {
            return res.status(outcome.status || 400).json({ error: outcome.error });
        }
        res.json(outcome);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/transactions", async (req, res) => {
    try {
        const { account_id, cleared, since_date, until_date } = req.query;
        const today = new Date().toISOString().slice(0, 10);
        const start = since_date || "2020-01-01";
        const end = until_date || today;
        const txns = await withBudget(req, async () => {
            let rows = await actual.getTransactions(
                account_id || undefined,
                start,
                end,
            );
            if (cleared === "false") {
                rows = rows.filter((t) => !t.cleared);
            }
            return rows;
        });
        if (txns === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json(txns);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete("/transactions/:id", async (req, res) => {
    try {
        const knownBudget = await withBudget(req, () =>
            actual.deleteTransaction(req.params.id),
        );
        if (knownBudget === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json({ status: "deleted", id: req.params.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/transactions/:id/clear", async (req, res) => {
    try {
        const { notes } = req.body || {};
        const fields = { cleared: true };
        if (notes) fields.notes = notes;
        const knownBudget = await withBudget(req, () =>
            actual.updateTransaction(req.params.id, fields),
        );
        if (knownBudget === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json({ status: "cleared", id: req.params.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/transactions/:id/unclear", async (req, res) => {
    try {
        const knownBudget = await withBudget(req, () =>
            actual.updateTransaction(req.params.id, { cleared: false }),
        );
        if (knownBudget === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json({ status: "uncleared", id: req.params.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.patch("/transactions/:id", async (req, res) => {
    try {
        if (
            req.body.amount !== undefined &&
            !isSafeIntegerAmount(req.body.amount)
        ) {
            return res
                .status(400)
                .json({ error: "Amount must be an integer number of cents" });
        }
        const fields = {};
        if (req.body.payee !== undefined) fields.payee = req.body.payee;
        if (req.body.notes !== undefined) fields.notes = req.body.notes;
        if (req.body.amount !== undefined)
            fields.amount = Number(req.body.amount);
        if (req.body.date !== undefined) fields.date = req.body.date;
        if (req.body.category !== undefined)
            fields.category = req.body.category;
        if (req.body.account !== undefined) fields.account = req.body.account;
        if (req.body.cleared !== undefined) fields.cleared = req.body.cleared;
        if (Object.keys(fields).length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }
        const knownBudget = await withBudget(req, () =>
            actual.updateTransaction(req.params.id, fields),
        );
        if (knownBudget === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json({ status: "updated", id: req.params.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, "0.0.0.0", () =>
    console.log(`actual-api listening on :${PORT}`),
);

module.exports = {
    getBudgetId,
    buildTransaction,
    readWindow,
    init,
    ensureBudget,
    resetBudgetListCache,
};
