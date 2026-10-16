/**
 * Tool Registry for the portfolio tracker.
 * Ported 1:1 from src/agent/tools.py
 *
 * Full schemas and handlers for all tools. No stubs. No TODOs.
 */

import { parseIBKRFlexQuery } from "./ibkr_parser.js";
import { extractEmailContent } from "./email_handler.js";
import { extractPdfText } from "./pdf_extractor.js";
import { SheetsClient } from "./sheets_client.js";
import { pullFromOneDrive, pushToOneDrive } from "./onedrive.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { PpJavaBridge } from "./java_bridge.js";

/** Keys whose values must never be written to logs. */
const SECRET_KEYS = new Set(["password", "passwd", "pwd"]);

/** Facts that look like credentials. Passwords live in Bitwarden, never in a fact store (#783). */
const SECRET_FACT_RE = /password|passcode|passwd|\bpin\b|\bnric\b|\bdob\b|date of birth/i;
/** Keys whose (large) values are truncated in logs to reduce noise. */
const BULKY_KEYS = new Set(["pdf_bytes_b64", "xml_content"]);

/**
 * Return a shallow copy of an args object sanitized for logging: secret values
 * are redacted and bulky values truncated. Non-objects are returned unchanged.
 */
function redactSecrets(args) {
    if (!args || typeof args !== "object") return args;
    const out = {};
    for (const [k, v] of Object.entries(args)) {
        if (SECRET_KEYS.has(k.toLowerCase()) && v) {
            out[k] = "[REDACTED]";
        } else if (BULKY_KEYS.has(k) && typeof v === "string" && v.length > 64) {
            out[k] = `[${v.length} chars]`;
        } else {
            out[k] = v;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const TOOL_SCHEMAS = [
    {
        type: "function",
        function: {
            name: "parse_ibkr_flex_query",
            description:
                "Parse an IBKR flex query XML string into a structured list of transactions.",
            parameters: {
                type: "object",
                properties: {
                    xml_content: {
                        type: "string",
                        description: "Raw XML content of the flex query",
                    },
                },
                required: ["xml_content"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "extract_email_content",
            description:
                "Extract and clean text from the current email, including PDF attachments. An encrypted PDF is reported as [PDF_ENCRYPTED]; this tool never takes a password.",
            parameters: {
                type: "object",
                properties: {},
            },
        },
    },
    {
        type: "function",
        function: {
            name: "extract_pdf_text",
            description:
                "Extract text from a PDF (trade confirmation or statement) from base64-encoded bytes using pdftotext. An encrypted PDF is reported as [PDF_ENCRYPTED]; this tool never takes a password.",
            parameters: {
                type: "object",
                properties: {
                    pdf_bytes_b64: {
                        type: "string",
                        description: "Base64-encoded PDF bytes",
                    },
                },
                required: ["pdf_bytes_b64"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search_memory",
            description:
                "Search the portfolio tracker's learned security/account notes (read-only). Use a SINGLE keyword such as a broker name (\"IBKR\", \"POEMS\"). Never returns credentials.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Single-keyword search query",
                    },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "learn_fact",
            description:
                "Propose a free-form fact for the finance wiki (queued for the owner's review, not saved directly). Credentials are refused.",
            parameters: {
                type: "object",
                properties: {
                    fact: {
                        type: "string",
                        description: "The fact text to remember",
                    },
                },
                required: ["fact"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "fetch_pp_accounts",
            description:
                "Fetch all accounts from Portfolio Performance via Java CLI.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "fetch_pp_securities",
            description:
                "Fetch all securities from Portfolio Performance with ISIN, ticker, name, currency.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "fetch_pp_portfolio",
            description:
                "Fetch the full portfolio structure: accounts, securities, holdings.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "insert_pp_transaction",
            description:
                "Insert a transaction into Portfolio Performance via Java CLI.",
            parameters: {
                type: "object",
                properties: {
                    account_id: { type: "string" },
                    security_id: {
                        type: "string",
                        description:
                            "PP security UUID (empty for cash transactions)",
                    },
                    type: {
                        type: "string",
                        enum: [
                            "Buy",
                            "Sell",
                            "Dividend",
                            "Deposit",
                            "Withdrawal",
                            "Fee",
                            "Tax",
                            "Interest",
                        ],
                    },
                    date: { type: "string", description: "YYYY-MM-DD" },
                    shares: {
                        type: "number",
                        description:
                            "Number of shares (0 for cash transactions)",
                    },
                    price: {
                        type: "number",
                        description:
                            "Price per share or total amount for cash txns",
                    },
                    currency_code: { type: "string" },
                    fees: { type: "number" },
                    taxes: { type: "number" },
                    notes: { type: "string" },
                    offset_account_id: {
                        type: "string",
                        description: "Optional: PP account UUID for offset/cash leg (defaults to reference account of first portfolio)",
                    },
                },
                required: [
                    "account_id",
                    "type",
                    "date",
                    "shares",
                    "price",
                    "currency_code",
                    "fees",
                    "taxes",
                ],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "update_pp_balance",
            description:
                "Update a PP account balance to a specific amount on a given date.",
            parameters: {
                type: "object",
                properties: {
                    account_id: { type: "string" },
                    amount: { type: "number" },
                    currency_code: { type: "string" },
                    date: { type: "string", description: "YYYY-MM-DD" },
                    notes: { type: "string" },
                },
                required: ["account_id", "amount", "currency_code", "date"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "pp-pull",
            description:
                "Force download latest PP file from OneDrive. Use before viewing/modifying PP data to ensure fresh copy.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "pp-push",
            description:
                "Upload PP file to OneDrive to persist changes. MUST call after every pp-update-balance or insert_pp_transaction. After pushing, call pp-sync-all to sync balances and update Google Sheets.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "pp-sync-all",
            description:
                "One-shot full balance sync: pulls latest PP from OneDrive, fetches AB budgets, updates all 3 PP accounts, pushes back to OneDrive, and exports taxonomies to Google Sheets. Returns sync_targets with result/delta/status. Call notify_user with summary after. Do NOT call update_pp_balance separately — pp-sync-all already did it.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "query_pp_taxonomies",
            description:
                "Query Portfolio Performance for holdings aggregated by taxonomy values.",
            parameters: {
                type: "object",
                properties: {
                    taxonomy_names: {
                        type: "array",
                        items: { type: "string" },
                    },
                },
                required: ["taxonomy_names"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "update_google_sheet",
            description: "Update a Google Sheet with data.",
            parameters: {
                type: "object",
                properties: {
                    spreadsheet_id: { type: "string" },
                    range: { type: "string", description: "A1 notation range" },
                    values: {
                        type: "array",
                        items: { type: "array", items: { type: "string" } },
                    },
                },
                required: ["spreadsheet_id", "range", "values"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "notify_user",
            description:
                "Send a notification to the user via the OpenClaw gateway webhook.",
            parameters: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "check_duplicate",
            description:
                "Check if a transaction already exists in the dedup journal.",
            parameters: {
                type: "object",
                properties: {
                    date: { type: "string" },
                    amount_cents: { type: "integer" },
                    account_id: { type: "string" },
                    security_id: { type: "string" },
                    type: { type: "string" },
                },
                required: ["date", "amount_cents", "account_id", "type"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "learn_mapping",
            description: "Persistently learn an association for future use.",
            parameters: {
                type: "object",
                properties: {
                    type: {
                        type: "string",
                        enum: [
                            "securities",
                            "accounts",
                            "categories",
                            "brokers",
                        ],
                    },
                    key: { type: "string" },
                    value: { type: "string" },
                },
                required: ["type", "key", "value"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "log_decision",
            description: "Log the final decision for audit trail.",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string" },
                    reasoning: { type: "string" },
                    transaction_id: { type: "string" },
                },
                required: ["action", "reasoning"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "ask_user_confirmation",
            description:
                "Ask the user for confirmation before proceeding with an action.",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string" },
                    context: {
                        type: "string",
                        description: "Summary of what is being confirmed",
                    },
                    options: {
                        type: "array",
                        items: { type: "string" },
                        description: "Options: approve, reject, edit",
                    },
                },
                required: ["question", "context"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_pp_status",
            description:
                "Get portfolio performance summary: total value, equity value, holdings with prices.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "query_pp_security",
            description:
                "Query a security by ticker, ISIN, or name. Returns shares held, avg entry price, latest price, market value.",
            parameters: {
                type: "object",
                properties: {
                    search: {
                        type: "string",
                        description: "Ticker symbol, ISIN, or security name",
                    },
                    account_id: {
                        type: "string",
                        description: "Optional: filter to a specific portfolio account UUID",
                    },
                },
                required: ["search"],
            },
        },
    },
];

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export class ToolRegistry {
    /**
     * @param {import('./config.js').Config} config
     * @param {import('./dedup.js').DedupJournal} dedupJournal
     * @param {import('./memory.js').MemoryStore} memoryStore
     * @param {import('./java_bridge.js').PpJavaBridge|null} ppBridge
     * @param {import('./memory_facts.js').FactsMemory|null} factsMemory - semantic facts/password store
     */
    constructor(
        config,
        dedupJournal,
        memoryStore,
        ppBridge = null,
        factsMemory = null,
    ) {
        this._config = config;
        this._dedup = dedupJournal;
        this._memory = memoryStore;
        this.__ppBridge = ppBridge;
        this._facts = factsMemory;
        this._currentPdfBytes = Buffer.alloc(0);
        this._currentRawEmail = Buffer.alloc(0);
        this._sheetsClient = null;
    }

    /**
     * Lazy getter for the PP Java bridge.
     * If the bridge was not provided at construction (e.g. XML file missing
     * at startup), checks whether the file now exists on disk and creates
     * the bridge on demand. This avoids requiring a container restart after
     * pp-pull downloads the Portfolio XML for the first time.
     */
    get _ppBridge() {
        if (!this.__ppBridge) {
            const xmlPath = this._config.ppXmlPath;
            if (existsSync(xmlPath)) {
                this.__ppBridge = new PpJavaBridge(
                    this._config.ppJarPath,
                    xmlPath,
                    this._config.ppPassword || "",
                );
            }
        }
        return this.__ppBridge;
    }

    /**
     * Queue a fact for the owner's review instead of writing any store.
     * Identical pending proposals are queued once.
     */
    _proposeFact(fact) {
        fact = String(fact || "").trim();
        if (!fact) return { added: false, reason: "empty fact" };
        if (SECRET_FACT_RE.test(fact)) return { added: false, reason: "secret_refused" };
        const path = this._config?.wikiProposalsPath || "data/wiki-proposals.jsonl";
        const entry = { op: "add", fact, source: "portfolio-tracker" };
        const same = (line) => {
            try {
                const { at, ...rest } = JSON.parse(line);
                return rest.op === entry.op && String(rest.fact).toLowerCase() === fact.toLowerCase();
            } catch {
                return false;
            }
        };
        if (existsSync(path) && readFileSync(path, "utf8").split("\n").some(same)) {
            return { added: false, reason: "proposal_queued" };
        }
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n");
        return { added: false, reason: "proposal_queued" };
    }

    /** Set event context (PDF bytes and raw email for extraction). */
    setEventContext(pdfBytes, rawEmail) {
        this._currentPdfBytes = Buffer.isBuffer(pdfBytes)
            ? pdfBytes
            : Buffer.from(pdfBytes || Buffer.alloc(0));
        this._currentRawEmail = Buffer.isBuffer(rawEmail)
            ? rawEmail
            : Buffer.from(rawEmail || Buffer.alloc(0));
    }

    /** Get all tool schemas in OpenAI function-calling format. */
    getToolSchemas() {
        return TOOL_SCHEMAS;
    }

    /**
     * Execute a tool by name with arguments.
     * @param {string} name
     * @param {object} args
     * @returns {Promise<object>}
     */
    /** While Hermes's processing request runs (#783), notifications go to the request. */
    setNotificationSink(sink) {
        this._notificationSink = sink || null;
    }

    /** Sees every tool call and its result, so a request can derive its status. */
    setCallObserver(observer) {
        this._callObserver = observer || null;
    }

    async executeTool(name, args) {
        if (name === "notify_user" && this._notificationSink) {
            return this._notificationSink(args?.message);
        }
        console.log(
            JSON.stringify({
                event: "tool_exec",
                tool: name,
                args: JSON.stringify(redactSecrets(args)),
            }),
        );
        try {
            const result = await this._dispatch(name, args);
            this._callObserver?.(name, args, result);
            return result;
        } catch (e) {
            console.error(
                JSON.stringify({
                    event: "tool_error",
                    tool: name,
                    error: e.message,
                }),
            );
            const failed = { error: e.message };
            this._callObserver?.(name, args, failed);
            return failed;
        }
    }

    // -----------------------------------------------------------------------
    // Dispatch
    // -----------------------------------------------------------------------

    async _dispatch(name, args) {
        switch (name) {
            // IBKR
            case "parse_ibkr_flex_query":
                return parseIBKRFlexQuery(args.xml_content || "");

            // Email / PDF
            case "extract_email_content":
                return {
                    // Never decrypts: passwords are not this service's to hold (#783).
                    text: await extractEmailContent(this._currentRawEmail, null),
                };

            case "extract_pdf_text": {
                const b64 = args.pdf_bytes_b64 || "";
                const buf = Buffer.from(b64, "base64");
                return {
                    text: await extractPdfText(buf, null),
                };
            }

            // Legacy facts, read-only; credentials are never returned (#783).
            case "search_memory": {
                if (!this._facts) return { results: [] };
                const results = await this._facts.search(args.query || "");
                return {
                    results: (results || []).filter(
                        (r) => !SECRET_FACT_RE.test(String(r?.text ?? r)),
                    ),
                };
            }

            // The wiki is the knowledge authority (#783): a fact is a proposal.
            case "learn_fact":
                return this._proposeFact(args.fact);

            // PP queries
            case "fetch_pp_accounts":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                return this._ppBridge.getAccounts();

            case "fetch_pp_securities":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                return this._ppBridge.getSecurities();

            case "fetch_pp_portfolio":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                return this._ppBridge.getPortfolio();

            // PP mutations
            case "insert_pp_transaction":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };

                // Resolve PP_OFFSET_MAP for portfolio routing (also done in mcp-server for MCP calls)
                if (!args._portfolio_id && process.env.PP_OFFSET_MAP) {
                    try {
                        const map = JSON.parse(process.env.PP_OFFSET_MAP);
                        args._portfolio_id = map[args.account_id] || null;
                    } catch (e) { /* ignore */ }
                }                // Dedup check: compute monetary amount matching Java''s per-type logic
                let amountCents;
                switch (args.type) {
                    case "Buy":
                    case "Sell":
                        amountCents = Math.round((args.price || 0) * Math.abs(args.shares || 0) * 100);
                        break;
                    case "Fee":
                        amountCents = Math.round((args.fees || 0) * 100);
                        break;
                    case "Tax":
                        amountCents = Math.round((args.taxes || 0) * 100);
                        break;
                    default: // Dividend, Deposit, Withdrawal, Interest
                        amountCents = Math.round((args.price || 0) * 100);
                }
                if (this._dedup && this._dedup.check(
                    args.date, amountCents, args.account_id,
                    args.security_id || "", args.type,
                )) {
                    return {
                        status: "duplicate",
                        reason: "Duplicate transaction already recorded",
                    };
                }
                const result = await this._ppBridge.insertTransaction({
                    accountId: args.account_id,
                    securityId: args.security_id || "",
                    txnType: args.type,
                    date: args.date,
                    shares: args.shares,
                    price: args.price,
                    currencyCode: args.currency_code,
                    fees: args.fees ?? 0,
                    taxes: args.taxes ?? 0,
                    notes: args.notes || "",
                    offsetAccountId: args.offset_account_id || null,
                    portfolioId: args._portfolio_id || null,
                });
                // Record dedup after successful insert
                if (result.status !== "error" && this._dedup) {
                    this._dedup.record(
                        args.date, amountCents, args.account_id,
                        result.transaction_id || "",
                        args.security_id || "", args.type,
                    );
                }
                return result;

            case "update_pp_balance":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                return this._ppBridge.updateBalance({
                    accountId: args.account_id,
                    amount: args.amount,
                    currencyCode: args.currency_code,
                    date: args.date,
                    notes: args.notes || "",
                });

            // OneDrive — uses Microsoft Graph API directly, no Java bridge needed
            case "pp-pull":
                try {
                    const result = await pullFromOneDrive();
                    return {
                        status: result.success ? "ok" : "error",
                        detail: result.success ? "downloaded" : result.error,
                    };
                } catch (e) {
                    return { status: "error", detail: e.message };
                }

            case "pp-push":
                try {
                    const result = await pushToOneDrive();
                    return {
                        status: result.success ? "ok" : "error",
                        detail: result.success ? "uploaded" : result.error,
                    };
                } catch (e) {
                    return { status: "error", detail: e.message };
                }

            // Sync all
            case "pp-sync-all":
                return this._computeSyncAll();

            // Taxonomy
            case "query_pp_taxonomies":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                return this._ppBridge.queryTaxonomies(
                    args.taxonomy_names || [],
                );

            // Google Sheets
            case "update_google_sheet":
                return this._updateSheet(
                    args.spreadsheet_id,
                    args.range,
                    args.values,
                );

            // General
            case "notify_user":
                return this._notifyUser(args.message);

            case "check_duplicate": {
                const isDup = this._dedup.check(
                    args.date,
                    args.amount_cents,
                    args.account_id,
                    args.security_id || "",
                    args.type,
                );
                return { is_duplicate: isDup };
            }

            case "learn_mapping":
                this._memory.learn(args.type, args.key, args.value);
                return { status: "learned" };

            case "ask_user_confirmation":
                return {
                    requires_confirmation: true,
                    question: args.question,
                    context: args.context,
                    options: args.options || ["approve", "reject"],
                };

            case "log_decision":
                console.log(
                    JSON.stringify({
                        event: "decision",
                        action: args.action,
                        reasoning: args.reasoning,
                        transaction_id: args.transaction_id || "",
                        timestamp: new Date().toISOString(),
                    }),
                );
                return { status: "logged" };

            // Status / query
            case "get_pp_status":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                {
                    const raw = await this._ppBridge.getStatus();
                    return this._computeStatusSgd(raw);
                }

            case "query_pp_security":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                return this._ppBridge.querySecurity(args.search || "", args.account_id || null);

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }

    // -----------------------------------------------------------------------
    // Notify user
    // -----------------------------------------------------------------------

    async _notifyUser(message) {
        const gatewayUrl =
            process.env.OPENCLAW_GATEWAY_URL || "http://openclaw:18800";
        const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";
        const url = `${gatewayUrl}/api/notify`;
        const headers = { "Content-Type": "application/json" };
        if (gatewayToken) {
            headers["Authorization"] = `Bearer ${gatewayToken}`;
        }
        try {
            const r = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify({ message }),
                signal: AbortSignal.timeout(10000),
            });
            if (r.ok) return { status: "sent" };
            const text = await r.text();
            console.error(
                `Gateway notify failed (HTTP ${r.status}): ${text.slice(0, 200)}`,
            );
            return {
                status: "error",
                detail: `HTTP ${r.status}: ${text.slice(0, 200)}`,
            };
        } catch (e) {
            console.error(`Gateway notify unreachable: ${e.message}`);
            return { status: "error", detail: e.message };
        }
    }

    // -----------------------------------------------------------------------
    // pp-sync-all (orchestrated: pull → AB budgets → update PP → push → sheets → status)
    // -----------------------------------------------------------------------

    async _computeSyncAll() {
        const results = [];
        let pullResult = null;
        let pushResult = null;

        // Step 1: Pull latest PP file from OneDrive
        if (this._ppBridge) {
            try {
                pullResult = await this._ppBridge.pull();
                console.log(
                    JSON.stringify({ event: "pp-pull", result: pullResult }),
                );
            } catch (e) {
                console.warn(
                    `pp-pull failed (continuing with local): ${e.message}`,
                );
                pullResult = { status: "error", detail: e.message };
            }
        }

        // Step 1.5: Pull IBKR flex XML and import trades
        let flexPullResult = null;
        let flexImportResult = null;
        if (this._ppBridge) {
            try {
                const { pullFlexXml } = await import("./ibkr_flex.js");
                flexPullResult = await pullFlexXml();
                console.log(
                    JSON.stringify({
                        event: "ibkr-flex-pull",
                        result: flexPullResult.success,
                    }),
                );
                if (flexPullResult.success && flexPullResult.xml) {
                    const xmlB64 = Buffer.from(flexPullResult.xml).toString(
                        "base64",
                    );
                    flexImportResult = await this._ppBridge.importIbkr(xmlB64);
                    console.log(
                        JSON.stringify({
                            event: "ibkr-flex-import",
                            result: flexImportResult,
                        }),
                    );
                }
            } catch (e) {
                console.warn(
                    `IBKR flex pull/import failed (continuing): ${e.message}`,
                );
                flexPullResult = { success: false, error: e.message };
            }
        }

        // Step 2: Fetch AB budgets with retry
        const _sgdBudget =
            process.env.ACTUAL_PRIMARY_BUDGET_FILE || "SGD Budget";
        const _myrBudget =
            process.env.ACTUAL_SECONDARY_BUDGET_FILE || "MYR Budget";

        const fetchBudget = async (budgetName, maxRetries = 3) => {
            const url = `http://actual-api:3000/budget-12m?budget_id=${encodeURIComponent(budgetName)}`;
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    const resp = await fetch(url, {
                        signal: AbortSignal.timeout(60000),
                    });
                    if (resp.status === 200) return resp.json();
                    const text = await resp.text();
                    if (attempt < maxRetries - 1) {
                        console.warn(
                            `Budget ${budgetName} fetch failed (HTTP ${resp.status}), retry ${attempt + 1}/${maxRetries}`,
                        );
                        await sleep(2 ** attempt * 1000);
                        continue;
                    }
                    throw new Error(
                        `Budget ${budgetName}: HTTP ${resp.status}: ${text}`,
                    );
                } catch (e) {
                    if (attempt < maxRetries - 1) {
                        console.warn(
                            `Budget ${budgetName} fetch error: ${e.message}, retry ${attempt + 1}/${maxRetries}`,
                        );
                        await sleep(2 ** attempt * 1000);
                        continue;
                    }
                    throw e;
                }
            }
        };

        try {
            const sgd = await fetchBudget(_sgdBudget);
            await sleep(1000);
            const myr = await fetchBudget(_myrBudget);

            const today = new Date().toISOString().slice(0, 10);

            const targets = [
                {
                    account_id:
                        this._config.ppEmergencyPrimaryAccount ||
                        "444b04eb-8c55-4efc-9df3-c529612fd2f3",
                    name: "Emergency Funds - SGD",
                    amount: (sgd.emergency_total || 0) / 100,
                    currency: "SGD",
                },
                {
                    account_id:
                        this._config.ppEmergencySecondaryAccount ||
                        "a5f42a18-b882-4225-bea6-90c9eea720b5",
                    name: "Emergency Funds - MYR",
                    amount: (myr.emergency_total || 0) / 100,
                    currency: "MYR",
                },
                {
                    account_id:
                        this._config.ppWarchestPrimaryAccount ||
                        "68815371-05f3-43e9-9669-08b368fe1e9d",
                    name: "Warchest",
                    amount: (sgd.investment_total || 0) / 100,
                    currency: "SGD",
                },
            ];

            for (const t of targets) {
                try {
                    if (!this._ppBridge) {
                        t.status = "skipped";
                        t.error =
                            "OneDrive not synced — portfolio file not downloaded. Run /onedrive setup in Telegram.";
                    } else {
                        const updateResult = await this._ppBridge.updateBalance(
                            {
                                accountId: t.account_id,
                                amount: t.amount,
                                currencyCode: t.currency,
                                date: today,
                                notes: `Synced from AB ${t.name}`,
                            },
                        );
                        t.result = updateResult;
                        t.delta = updateResult.delta ?? 0;
                        t.status = updateResult.status || "updated";
                    }
                } catch (e) {
                    t.result = { error: e.message };
                    t.delta = 0;
                    t.status = "error";
                }
                results.push(t);
                await sleep(500);
            }
        } catch (e) {
            // The legs already ran before this try, so they are returned here too.
            // Returning only { error, sync_targets } is what let a dead OneDrive
            // grant read as a clean run whenever an Actual Budget outage aborted
            // the sync first: the caller had no pull/push to report (dev-loop
            // review round 2, M2). The push has not run yet at this point, so it
            // stays null rather than being reported as a success.
            return {
                error: e.message,
                sync_targets: results,
                pull: pullResult,
                flex_pull: flexPullResult,
                flex_import: flexImportResult,
                push: pushResult,
            };
        }

        // Step 3: Push updated PP file back to OneDrive
        if (this._ppBridge) {
            try {
                pushResult = await this._ppBridge.push();
                console.log(
                    JSON.stringify({ event: "pp-push", result: pushResult }),
                );
            } catch (e) {
                console.error(`pp-push failed: ${e.message}`);
                pushResult = { status: "error", detail: e.message };
            }
        }

        // Step 4: Export taxonomies to Google Sheets
        const taxonomyResult = await this._exportTaxonomiesToSheet();

        // Step 4b: Also query taxonomy data for MCP (liquid/illiquid split)
        let taxonomyData = null;
        let assetClassData = null;
        if (this._ppBridge) {
            try {
                taxonomyData = await this._ppBridge.queryTaxonomies(
                    this._config.taxonomyNames || ["Regions (Liquid)"],
                );
            } catch (e) {
                console.warn(`Failed to query taxonomies: ${e.message}`);
            }
            // Query Asset Classes taxonomy for ETF/Fund detection
            try {
                assetClassData = await this._ppBridge.queryTaxonomies(
                    ["Asset Classes"],
                );
            } catch (e) {
                console.warn(`Failed to query Asset Classes taxonomy: ${e.message}`);
            }
        }

        // Merge Asset Classes into taxonomy data for analysis
        if (taxonomyData && assetClassData) {
            taxonomyData = {
                taxonomies: [
                    ...(taxonomyData.taxonomies || []),
                    ...(assetClassData.taxonomies || []),
                ],
            };
        }

        // Step 5: Get status with SGD-converted totals
        let statusSgd = null;
        if (this._ppBridge) {
            try {
                const rawStatus = await this._ppBridge.getStatus();
                statusSgd = await this._computeStatusSgd(rawStatus);
            } catch (e) {
                console.warn(`Failed to get status after sync: ${e.message}`);
                statusSgd = { error: e.message };
            }
        }

        // Step 6: Build analysis block with SGD conversion
        let analysis = null;
        let fxRatesUsed = {};
        if (taxonomyData) {
            // Collect all unique currencies from taxonomy children
            const currencies = new Set();
            for (const tax of taxonomyData.taxonomies || []) {
                for (const v of tax.values || []) {
                    for (const c of v.children || []) {
                        if (c.currency && c.currency !== "SGD") {
                            currencies.add(c.currency);
                        }
                    }
                }
            }
            fxRatesUsed = await this._fetchLiveRates([...currencies]);
            const syncMeta = {
                accounts_synced: results.filter((r) => r.status === "updated").length,
                accounts_total: results.length,
                accounts_errors: results.filter((r) => r.status === "error").length,
                ibkr_trades: flexImportResult?.trades_imported || 0,
                ibkr_dividends: flexImportResult?.dividends_imported || 0,
                ibkr_skipped: flexImportResult?.items_skipped || 0,
                errors: results.filter((r) => r.status === "error").map((r) => ({
                    account: r.name || r.account_id,
                    error: r.error || r.result?.error || "unknown",
                })),
            };
            // Build analysis first (without news), then fetch news from top holdings
            analysis = this._buildAnalysis(taxonomyData, fxRatesUsed, syncMeta, null);
            let newsBlock = [];
            try {
                const tickers = (analysis.top_holdings || [])
                    .filter((h) => h.ticker && !/^[A-Z]{2}[0-9A-Z]{8,}/.test(h.ticker) && !h.ticker.includes(".EUFUND"))
                    .map((h) => h.ticker);
                if (tickers.length > 0) {
                    newsBlock = await this._fetchNews(tickers);
                }
            } catch (e) {
                console.warn(`News fetch failed: ${e.message}`);
            }
            // Rebuild with news if we got any
            if (newsBlock.length > 0) {
                analysis = this._buildAnalysis(taxonomyData, fxRatesUsed, syncMeta, newsBlock);
            }
        }

        return {
            sync_targets: results,
            summary: `Synced ${results.filter((r) => r.status === "updated").length}/${results.length} accounts`,
            pull: pullResult,
            flex_pull: flexPullResult,
            flex_import: flexImportResult,
            push: pushResult,
            taxonomy_export: taxonomyResult,
            taxonomy_data: taxonomyData,
            portfolio_status: statusSgd,
            analysis,
            fx_rates_used: fxRatesUsed,
        };
    }

    // -----------------------------------------------------------------------
    // SGD-converted status
    // -----------------------------------------------------------------------

    async _computeStatusSgd(rawStatus) {
        const result = { ...rawStatus };
        const summary = result.summary || {};
        const currencies = summary.currencies || {};
        const equityCurrencies = summary.equity_currencies || {};

        if (Object.keys(currencies).length === 0) {
            result.summary = {
                ...summary,
                total_value_sgd: summary.total_value_native || "0.00",
                equity_value_sgd: summary.equity_value_native || "0.00",
            };
            return result;
        }

        const rates = await this._fetchLiveRates();

        let totalSgd = 0;
        for (const [cc, nativeVal] of Object.entries(currencies)) {
            if (cc === "SGD") {
                totalSgd += nativeVal;
            } else if (rates[cc]) {
                totalSgd += nativeVal * rates[cc];
            } else {
                console.warn(`No exchange rate for ${cc} in getStatus`);
            }
        }

        let equitySgd = 0;
        for (const [cc, nativeVal] of Object.entries(equityCurrencies)) {
            if (cc === "SGD") {
                equitySgd += nativeVal;
            } else if (rates[cc]) {
                equitySgd += nativeVal * rates[cc];
            }
        }

        result.summary = {
            ...summary,
            total_value_sgd: totalSgd.toFixed(2),
            equity_value_sgd: equitySgd.toFixed(2),
            fx_rates_used: rates,
        };
        return result;
    }

    // -----------------------------------------------------------------------
    // Build pre-computed analysis block from taxonomy data + fx rates
    // -----------------------------------------------------------------------

    _buildAnalysis(taxonomyData, fxRates, syncMeta, newsBlock) {
        // ── Asset Class → diversified detection ──
        // Reads the "Asset Classes" taxonomy to determine which holdings
        // are diversified (ETFs, funds, cash) vs single-stock positions.
        // Classification names matching these keywords are diversified.
        const DIVERSIFIED_CLASS_KEYWORDS = /\b(ETF|Fund|Index|Bond|Cash)\b/i;
        const assetClassMap = new Map(); // security_uuid → classification name
        for (const tax of taxonomyData.taxonomies || []) {
            if (tax.name && tax.name.toLowerCase().includes("asset")) {
                for (const v of tax.values || []) {
                    for (const c of v.children || []) {
                        const uuid = c.security_uuid || c.ticker || c.name;
                        if (!assetClassMap.has(uuid)) {
                            assetClassMap.set(uuid, v.value);
                        }
                    }
                }
            }
        }

        const diversifiedTypes = (process.env.PP_DIVERSIFIED_TYPES || "ETF,Fund,Mutual Fund,Index Fund")
            .split(",")
            .map((t) => t.trim().toLowerCase());

        // Name-based concentration exemptions (e.g. Warchest, Emergency Fund)
        const exemptNamesRaw = process.env.PP_CONCENTRATION_EXEMPT_NAMES || "Warchest";
        const exemptNames = new Set(
            exemptNamesRaw.split(",").map((n) => n.trim().toLowerCase()),
        );

        const isDiversified = (securityType, uuid, name) => {
            // 0. Accounts and cash are always diversified (not single-stock risk)
            const type = (securityType || "").toLowerCase();
            if (type === "account" || type === "cash") return true;
            // 0b. Name-based exemption (Warchest + configurable)
            if (name && exemptNames.has(name.toLowerCase())) return true;
            // 1. Check asset class taxonomy (authoritative)
            const assetClass = assetClassMap.get(uuid);
            if (assetClass) {
                return DIVERSIFIED_CLASS_KEYWORDS.test(assetClass);
            }
            // 2. Check security_type (forward compat if PP ever provides it)
            return diversifiedTypes.includes(type);
        };

        // Collect all children from liquid taxonomies (exclude "Without Classification")
        const allChildren = [];
        let liquidTotalSgd = 0;
        let illiquidTotalSgd = 0;
        let cashValueSgd = 0;
        let isFirstTaxonomy = true; // Only sum totals from the first (Regions) taxonomy

        const sectors = [];
        const geo = [];
        const deduped = new Map(); // security_uuid → merged child (liquid)
        const illiquidDeduped = new Map(); // security_uuid → merged child (illiquid)

        for (const tax of taxonomyData.taxonomies || []) {
            const isRegions = tax.name && tax.name.toLowerCase().includes("region");
            const isSector = tax.name && tax.name.toLowerCase().includes("sector");
            const isGeo = tax.name && tax.name.toLowerCase().includes("geograph");
            const isAssetClass = tax.name && tax.name.toLowerCase().includes("asset");
            const sumTotals = isRegions || (isFirstTaxonomy && !isSector && !isGeo && !isAssetClass);

            for (const v of tax.values || []) {
                const sgdRate = fxRates[v.currency] || 0;
                const valueSgd = (v.valuation_native || 0) * sgdRate;

                if (v.value === "Without Classification") {
                    if (sumTotals) illiquidTotalSgd += valueSgd;
                    // Collect illiquid children
                    for (const c of v.children || []) {
                        const cr = fxRates[c.currency] || 0;
                        const cv = (c.valuation_native || 0) * cr;
                        const uid = c.security_uuid || c.ticker || c.name;
                        if (!illiquidDeduped.has(uid)) {
                            illiquidDeduped.set(uid, {
                                ticker: c.ticker || "",
                                name: c.name || "",
                                currency: c.currency || "",
                                valuation_native: c.valuation_native || 0,
                                valuation_sgd: Math.round(cv),
                                security_uuid: uid,
                                security_type: c.security_type || "",
                                is_diversified: true, // illiquid = not concentration-relevant
                                price_prev_close: null,
                                price_change_pct: null,
                                stale_days: c.stale_days || 0,
                            });
                        }
                    }
                    continue;
                }

                if (sumTotals) {
                    liquidTotalSgd += valueSgd;

                    // Track cash value
                    if (
                        v.value === "Investable Cash" ||
                        (v.children || []).every(
                            (c) => (c.security_type || "") === "Cash" || (c.security_type || "") === "Account",
                        )
                    ) {
                        cashValueSgd += valueSgd;
                    }
                }

                // Sector taxonomy
                if (isSector) {
                    sectors.push({
                        name: v.value,
                        share_pct: v.share_pct || 0,
                        valuation_sgd: Math.round(valueSgd),
                    });
                }

                // Geography taxonomy
                if (isGeo) {
                    geo.push({
                        name: v.value,
                        share_pct: v.share_pct || 0,
                        valuation_sgd: Math.round(valueSgd),
                    });
                }

                // Collect children with SGD values
                for (const c of v.children || []) {
                    const childRate = fxRates[c.currency] || 0;
                    const childValueSgd =
                        (c.valuation_native || 0) * childRate;
                    const uuid = c.security_uuid || c.ticker || c.name;

                    if (!deduped.has(uuid) && !illiquidDeduped.has(uuid)) {
                        const isCash = v.value === "Investable Cash";
                        deduped.set(uuid, {
                            ticker: c.ticker || "",
                            name: c.name || "",
                            currency: c.currency || "",
                            valuation_native: c.valuation_native || 0,
                            valuation_sgd: Math.round(childValueSgd),
                            security_uuid: uuid,
                            security_type: isCash ? "Cash" : (c.security_type || ""),
                            is_diversified: isCash ? true : isDiversified(c.security_type, uuid, c.name),
                            is_cash: isCash,
                            price_prev_close: c.price_prev_close || null,
                            price_change_pct: c.price_change_pct || null,
                            stale_days: c.stale_days || 0,
                        });
                    }
                }
            }
        }

        // ── Recompute totals from distinct holdings (avoids taxonomy double-count) ──
        liquidTotalSgd = [...deduped.values()].reduce((s, h) => s + h.valuation_sgd, 0);
        illiquidTotalSgd = [...illiquidDeduped.values()].reduce((s, h) => s + h.valuation_sgd, 0);
        cashValueSgd = [...deduped.values()]
            .filter((h) => h.is_cash)
            .reduce((s, h) => s + h.valuation_sgd, 0);

        // Top holdings: top 10 by valuation_sgd (exclude cash)
        const topHoldings = [...deduped.values()]
            .filter((h) => !h.is_cash)
            .sort((a, b) => b.valuation_sgd - a.valuation_sgd)
            .slice(0, 10)
            .map((h) => ({
                ...h,
                share_pct:
                    liquidTotalSgd > 0
                        ? Math.round((h.valuation_sgd / liquidTotalSgd) * 1000) / 10
                        : 0,
            }));

        // Illiquid holdings: top 10 by valuation_sgd (exclude zero/negative)
        const illiquidHoldings = [...illiquidDeduped.values()]
            .filter((h) => h.valuation_sgd > 0)
            .sort((a, b) => b.valuation_sgd - a.valuation_sgd)
            .slice(0, 10)
            .map((h) => ({
                ...h,
                share_pct:
                    illiquidTotalSgd > 0
                        ? Math.round((h.valuation_sgd / illiquidTotalSgd) * 1000) / 10
                        : 0,
            }));

        // Top movers: top 10 by abs(price_change_pct), only non-null
        const moverMap = new Map();
        for (const tax of taxonomyData.taxonomies || []) {
            for (const v of tax.values || []) {
                if (v.value === "Without Classification") continue;
                for (const c of v.children || []) {
                    if (c.price_change_pct != null && c.price_prev_close != null) {
                        const uuid = c.security_uuid || c.ticker || c.name;
                        if (!moverMap.has(uuid)) {
                            const priceNow = c.price_prev_close * (1 + c.price_change_pct / 100);
                            moverMap.set(uuid, {
                                ticker: c.ticker,
                                name: c.name,
                                price_prev_close: Math.round(c.price_prev_close * 100) / 100,
                                price_now: Math.round(priceNow * 100) / 100,
                                price_change_pct: Math.round(c.price_change_pct * 10) / 10,
                            });
                        }
                    }
                }
            }
        }
        const topMovers = [...moverMap.values()]
            .sort(
                (a, b) =>
                    Math.abs(b.price_change_pct) - Math.abs(a.price_change_pct),
            )
            .slice(0, 10);

        // Flags: concentration >20% for non-diversified, stale data >3 days
        const flags = [];
        const displayLabel = (h) => {
            const t = h.ticker || "";
            const looksLikeIsin = /^[A-Z]{2}[0-9A-Z]{8,}\b/.test(t)
                || t.includes(".EUFUND")
                || /^0P0001/.test(t);
            return (t && !looksLikeIsin) ? t : (h.name || t || "?");
        };
        for (const h of topHoldings) {
            const label = displayLabel(h);
            if (!h.is_diversified && h.share_pct > 20) {
                flags.push({
                    severity: "warn",
                    ticker: h.ticker,
                    reason: `${label} at ${h.share_pct}% of liquid — above 20% single-stock threshold`,
                    pct: h.share_pct,
                });
            }
            if (!h.is_diversified && h.share_pct > 10 && h.share_pct <= 20) {
                flags.push({
                    severity: "info",
                    ticker: h.ticker,
                    reason: `${label} at ${h.share_pct}% of liquid — approaching 20% threshold`,
                    pct: h.share_pct,
                });
            }
        }
        const maxStaleDays = topHoldings.reduce(
            (max, h) => Math.max(max, h.stale_days),
            0,
        );
        if (maxStaleDays > 3) {
            flags.push({
                severity: "warn",
                ticker: "",
                reason: `Prices stale — last update ${maxStaleDays} days ago`,
                pct: 0,
            });
        }

        // Build message body
        const grandTotal = liquidTotalSgd + illiquidTotalSgd;
        const cashRatio =
            liquidTotalSgd > 0
                ? Math.round((cashValueSgd / liquidTotalSgd) * 1000) / 10
                : 0;

        const toSgdStr = (n) =>
            n != null
                ? Number(n).toLocaleString("en-SG", {
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 0,
                  })
                : "?";

        const today = new Date().toISOString().slice(0, 10);
        const lines = [];

        // ── Sync status (prepended before portfolio data) ──
        if (syncMeta) {
            const parts = [];
            const accts = syncMeta.accounts_synced != null
                ? `Synced ${syncMeta.accounts_synced}/${syncMeta.accounts_total} AB accounts`
                : null;
            if (syncMeta.accounts_errors > 0) {
                parts.push(`${accts} (${syncMeta.accounts_errors} errors)`);
            } else if (accts) {
                parts.push(accts);
            }
            if (syncMeta.ibkr_trades != null || syncMeta.ibkr_dividends != null) {
                const t = syncMeta.ibkr_trades || 0;
                const d = syncMeta.ibkr_dividends || 0;
                const s = syncMeta.ibkr_skipped || 0;
                let ibkr = `IBKR: ${t} trades, ${d} dividends`;
                if (s > 0) ibkr += ` (${s} skipped)`;
                parts.push(ibkr);
            }
            if (syncMeta.errors && syncMeta.errors.length > 0) {
                for (const e of syncMeta.errors) {
                    parts.push(`⚠️ ${e.account}: ${e.error}`);
                }
            }
            if (parts.length > 0) {
                lines.push(`🔄 ${parts.join(" · ")}`);
                lines.push("");
            }
        }

        // Check for bridge errors
        if (liquidTotalSgd === 0 && illiquidTotalSgd === 0) {
            lines.push(`📊 ${today}`);
            lines.push("");
            lines.push("No portfolio data available. Check OneDrive sync.");
        } else {
            lines.push(`📊 ${today}`);
            lines.push("");
            lines.push(
                `Liquid SGD ${toSgdStr(liquidTotalSgd)} · Illiquid SGD ${toSgdStr(illiquidTotalSgd)} · Total SGD ${toSgdStr(grandTotal)}`,
            );
            lines.push(`Cash ${cashRatio}%`);

            if (topHoldings.length > 0) {
                lines.push("");
                lines.push("**Liquid Holdings**");
                lines.push("");
                lines.push("| Holding | % | SGD |");
                lines.push("|---|---|---|");
                for (const h of topHoldings) {
                    const label = displayLabel(h);
                    lines.push(
                        `| ${label} | ${h.share_pct} | ${toSgdStr(h.valuation_sgd)} |`,
                    );
                }
            }

            if (illiquidHoldings.length > 0) {
                lines.push("");
                lines.push("**Illiquid Holdings**");
                lines.push("");
                lines.push("| Holding | % | SGD |");
                lines.push("|---|---|---|");
                for (const h of illiquidHoldings) {
                    const label = displayLabel(h);
                    lines.push(
                        `| ${label} | ${h.share_pct} | ${toSgdStr(h.valuation_sgd)} |`,
                    );
                }
            }

            if (sectors.length > 0) {
                lines.push("");
                lines.push("| Sector | % | SGD |");
                lines.push("|---|---|---|");
                for (const s of sectors) {
                    lines.push(
                        `| ${s.name} | ${s.share_pct} | ${toSgdStr(s.valuation_sgd)} |`,
                    );
                }
            }

            if (geo.length > 0) {
                lines.push("");
                lines.push("| Region | % | SGD |");
                lines.push("|---|---|---|");
                for (const g of geo) {
                    lines.push(
                        `| ${g.name} | ${g.share_pct} | ${toSgdStr(g.valuation_sgd)} |`,
                    );
                }
            }

            if (topMovers.length > 0) {
                lines.push("");
                lines.push("| Ticker | Prev | Now | Chg |");
                lines.push("|---|---|---|---|");
                for (const m of topMovers) {
                    const sign = m.price_change_pct > 0 ? "+" : "";
                    lines.push(
                        `| ${m.ticker} | ${m.price_prev_close} | ${m.price_now} | ${sign}${m.price_change_pct}% |`,
                    );
                }
            }

            const warnFlags = flags.filter((f) => f.severity === "warn");
            const infoFlags = flags.filter((f) => f.severity === "info");
            if (warnFlags.length > 0 || infoFlags.length > 0) {
                lines.push("");
                for (const f of warnFlags) {
                    lines.push(`⚠️ ${f.reason}`);
                }
                for (const f of infoFlags) {
                    lines.push(`ℹ️ ${f.reason}`);
                }
            }
        }

        // ── News section (pre-fetched from Google News RSS) ──
        if (newsBlock && newsBlock.length > 0) {
            lines.push("");
            lines.push("*News (last 24h)*");
            for (const h of newsBlock) {
                lines.push(h);
            }
        }

        const messageBody = lines.join("\n");

        return {
            date: today,
            liquid_total_sgd: Math.round(liquidTotalSgd),
            illiquid_total_sgd: Math.round(illiquidTotalSgd),
            grand_total_sgd: Math.round(grandTotal),
            cash_ratio_pct: cashRatio,
            cash_value_sgd: Math.round(cashValueSgd),
            top_holdings: topHoldings,
            illiquid_holdings: illiquidHoldings,
            top_movers: topMovers,
            sectors,
            geo,
            flags,
            stale_days: maxStaleDays,
            message_body: messageBody,
        };
    }

    // -----------------------------------------------------------------------
    // Taxonomy export to Google Sheets
    // -----------------------------------------------------------------------

    async _exportTaxonomiesToSheet() {
        const config = this._config;
        if (!config.googleSheetId || !config.googleServiceAccountJson) {
            return {
                status: "skipped",
                reason: "Google Sheets not configured",
            };
        }
        if (
            !config.taxonomySheetMapping ||
            Object.keys(config.taxonomySheetMapping).length === 0 ||
            !config.taxonomyNames
        ) {
            return {
                status: "skipped",
                reason: "No taxonomy sheet mapping configured",
            };
        }
        if (!this._ppBridge) {
            return { status: "skipped", reason: "PP bridge not configured" };
        }

        let taxData;
        try {
            taxData = await this._ppBridge.queryTaxonomies(
                config.taxonomyNames,
            );
        } catch (e) {
            return { status: "error", detail: e.message };
        }

        const taxonomies = taxData.taxonomies || [];
        if (!taxonomies.length) {
            return { status: "skipped", reason: "No taxonomy data returned" };
        }

        const rates = await this._fetchLiveRates();
        const cellsWritten = [];
        const errors = [];

        for (const taxonomy of taxonomies) {
            for (const entry of taxonomy.values || []) {
                const classification = entry.value;
                if (classification === undefined || classification === null)
                    continue;

                // Convert native value to SGD using per-currency breakdown
                const currencies = entry.currencies || {
                    [entry.currency || "SGD"]: entry.valuation_native || 0,
                };
                let valuationSgd = 0;
                for (const [cc, nativeVal] of Object.entries(currencies)) {
                    if (cc === "SGD") {
                        valuationSgd += nativeVal;
                    } else if (rates[cc]) {
                        valuationSgd += nativeVal * rates[cc];
                    } else {
                        errors.push(
                            `No exchange rate for ${cc} (classification: ${classification})`,
                        );
                    }
                }

                const cell = config.taxonomySheetMapping[classification];
                if (!cell) {
                    errors.push(`No cell mapping for '${classification}'`);
                    continue;
                }

                valuationSgd = Math.round(valuationSgd * 100) / 100;
                try {
                    const result = await this._updateSheet(
                        config.googleSheetId,
                        cell,
                        [[valuationSgd]],
                    );
                    cellsWritten.push({
                        classification,
                        cell,
                        value: valuationSgd,
                        currencies,
                        result,
                    });
                } catch (e) {
                    errors.push(
                        `Failed to write ${classification}→${cell}: ${e.message}`,
                    );
                }
            }
        }

        return {
            status: errors.length ? "partial" : "completed",
            cells_written: cellsWritten,
            errors,
        };
    }

    // -----------------------------------------------------------------------
    // Live FX rates from open.er-api.com (free, no key)
    // -----------------------------------------------------------------------

    async _fetchLiveRates(extraCurrencies) {
        const rates = {};
        try {
            const resp = await fetch("https://open.er-api.com/v6/latest/USD", {
                signal: AbortSignal.timeout(10000),
            });
            if (resp.status === 200) {
                const data = await resp.json();
                const apiRates = data.rates || {};
                const usdToSgd = apiRates.SGD || 0;
                if (!usdToSgd) return rates;

                // USD is the API base — handle specially
                rates["USD"] = usdToSgd;

                // Always fetch base currencies
                const baseCurrencies = ["MYR", "GBP", "EUR"];
                // Add any extra currencies seen in portfolio
                const allCurrencies = new Set([...baseCurrencies, ...(extraCurrencies || [])]);

                for (const cc of allCurrencies) {
                    const usdToCc = apiRates[cc];
                    if (usdToCc) {
                        rates[cc] = Math.round(usdToSgd / usdToCc * 10000) / 10000;
                    }
                }
                rates["SGD"] = 1.0;
                console.log(JSON.stringify({ event: "fx_rates", rates }));
            }
        } catch (e) {
            console.warn(`Failed to fetch live exchange rates: ${e.message}`);
        }
        return rates;
    }
    // -----------------------------------------------------------------------
    // News headlines from Google News RSS (free, no key)
    // -----------------------------------------------------------------------

    async _fetchNews(tickers) {
        const headlines = [];
        const now = Date.now();
        const seen = new Set();
        for (const ticker of (tickers || [])) {
            try {
                const q = encodeURIComponent(`${ticker} stock`);
                const url = `https://news.google.com/rss/search?q=${q}&hl=en-SG&gl=SG&ceid=SG:en`;
                const resp = await fetch(url, {
                    signal: AbortSignal.timeout(10000),
                });
                if (resp.status !== 200) continue;
                const xml = await resp.text();
                // Parse RSS items with regex
                const items = xml.split("<item>").slice(1);
                for (const item of items) {
                    const title = (item.match(/<title>(.+?)<\/title>/s) || [])[1] || "";
                    const link = (item.match(/<link>(.+?)<\/link>/s) || [])[1] || "";
                    const pubDate = (item.match(/<pubDate>(.+?)<\/pubDate>/s) || [])[1] || "";
                    const ageMs = now - new Date(pubDate).getTime();
                    if (ageMs > 24 * 3600000) continue;
                    if (!title || !link) continue;
                    const key = title.slice(0, 60);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    // Skip anti-scraping titles (characters spaced out individually)
                    const tokens = title.split(/\s+/).filter(Boolean);
                    const singleCharTokens = tokens.filter((t) => t.length === 1).length;
                    if (tokens.length > 5 && singleCharTokens / tokens.length > 0.3) continue;
                    // Decode HTML entities and strip URLs for clean summary
                    const decoded = title
                        .replace(/&amp;/g, "&")
                        .replace(/&lt;/g, "<")
                        .replace(/&gt;/g, ">")
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'")
                        .replace(/&#x27;/g, "'")
                        .replace(/&apos;/g, "'")
                        .replace(/&nbsp;/g, " ")
                        .replace(/&mdash;/g, "\u2014")
                        .replace(/&ndash;/g, "\u2013")
                        .replace(/&ldquo;/g, "\u201C")
                        .replace(/&rdquo;/g, "\u201D")
                        .replace(/&lsquo;/g, "\u2018")
                        .replace(/&rsquo;/g, "\u2019")
                        .replace(/&hellip;/g, "\u2026")
                        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
                        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
                    // Skip concatenated anti-scraping titles (no spaces, very long)
                    if (!decoded.includes(" ") && decoded.length > 40) continue;
                    headlines.push(`- ${ticker} — ${decoded}`);
                    if (headlines.length >= 10) break;
                }
            } catch (e) {
                console.warn(`News fetch failed for ${ticker}: ${e.message}`);
            }
            if (headlines.length >= 10) break;
        }
        return headlines;
    }

    // -----------------------------------------------------------------------
    // Google Sheets update with retry
    // -----------------------------------------------------------------------

    async _updateSheet(spreadsheetId, rangeStr, values) {
        const config = this._config;
        if (!config.googleServiceAccountJson) {
            return { error: "Google Sheets not configured" };
        }
        const client = new SheetsClient(
            config.googleServiceAccountJson,
            spreadsheetId,
        );
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                return await client.writeRange(rangeStr, values);
            } catch (e) {
                lastError = e;
                if (attempt < 2) await sleep(2 ** attempt * 1000);
            }
        }
        return {
            error: `Google Sheets update failed after 3 attempts: ${lastError?.message}`,
        };
    }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
