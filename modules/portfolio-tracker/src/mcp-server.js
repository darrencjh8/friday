/**
 * MCP Server — Streamable HTTP transport (stateful, per-session).
 * Pattern: https://github.com/ferrants/mcp-streamable-http-typescript-server
 * Chosen over SSE because SSE breaks on container restart (session mismatch).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { existsSync } from "fs";
import { pullFromOneDrive, pushToOneDrive } from "./onedrive.js";
import { getAuthUrl, exchangeCodeForToken } from "./onedrive_oauth.js";
import { NOT_CONFIGURED_ERROR } from "./ibkr_flex.js";

export function formatSyncResult(raw) {
    const lines = [];

    // Sync status header
    const parts = [];
    if (raw.summary) parts.push(raw.summary);
    const fi = raw.flex_import;
    // other_imported is a real success the header used to hide: a statement
    // carrying only corporate actions imported fine but printed no IBKR line.
    if (
        fi &&
        (fi.trades_imported > 0 ||
            fi.dividends_imported > 0 ||
            fi.other_imported > 0)
    ) {
        const bits = [];
        if (fi.trades_imported > 0) bits.push(`${fi.trades_imported} trades`);
        if (fi.dividends_imported > 0)
            bits.push(`${fi.dividends_imported} dividends`);
        if (fi.other_imported > 0) bits.push(`${fi.other_imported} other`);
        parts.push(`IBKR: ${bits.join(", ")}`);
    }
    if (parts.length > 0) {
        lines.push(`🔄 ${parts.join(" · ")}`);
    }

    // Error details
    const errs = raw.sync_targets?.filter((r) => r.status === "error") || [];
    for (const e of errs) {
        lines.push(`⚠️ ${e.name || e.account_id}: ${e.error || e.result?.error || "unknown"}`);
    }

    // Remote round-trip failures. A dead OneDrive grant reaches here as
    // { status: "error" }, and reporting that round trip as a success is the
    // defect this guards: the sheet is then written from a stale local file.
    //
    // The IBKR flex legs are read here too. They failed silently for the same
    // reason: the header branch below only fires when trades_imported > 0, and
    // that is necessarily 0 on the path where the pull itself failed, so the
    // failing leg was the one case the header could never report. flex_pull and
    // flex_import are separate tokens with separate expiry, so either can fail
    // while the OneDrive grant is healthy.
    //
    // Kept out of `lines` deliberately — `lines` carries the sync header, and
    // the analysis body below already includes its own, so prepending it would
    // duplicate the header the tests pin.
    const legErrs = [];
    for (const leg of ["pull", "push"]) {
        const r = raw[leg];
        if (r && r.status === "error") {
            legErrs.push(`⚠️ OneDrive ${leg}: ${r.detail || "failed"}`);
        }
    }
    const flexPull = raw.flex_pull;
    // `skipped` is how pullFlexXml marks "this deployment has no IBKR flex
    // configured" (ibkr_flex.js). That is configuration absence, not a remote
    // failure: reporting it on every run would put a warning on every healthy
    // sync, and an operator who sees that every day stops reading the line
    // that #627 exists to make trustworthy. The error-string fallback keeps
    // this working for a payload produced before the `skipped` flag existed.
    if (flexPull && flexPull.success === false && !flexPull.skipped &&
        flexPull.error !== NOT_CONFIGURED_ERROR) {
        legErrs.push(`⚠️ IBKR flex: ${flexPull.error || "failed"}`);
    }
    const flexImport = raw.flex_import;
    // PpClient.importIbkr sets status:"ok" unconditionally (PpClient.java) and
    // reports per-item failures in a separate errors[] list, so status is never
    // "error" in practice. Keying only on status made this branch dead code and
    // a real import failure entirely silent: every trade for the period was
    // dropped while both surfaces reported a clean sync.
    if (flexImport) {
        const detail = flexImport.detail || flexImport.error;
        if (flexImport.status === "error" || detail) {
            legErrs.push(`⚠️ IBKR import: ${detail || "failed"}`);
        } else if (Array.isArray(flexImport.errors) && flexImport.errors.length > 0) {
            const n = flexImport.errors.length;
            legErrs.push(
                `⚠️ IBKR import: ${n} item${n === 1 ? "" : "s"} failed to import — ` +
                    `${flexImport.errors.join("; ")}`,
            );
        } else {
            // The silent-drop route. PpClient counts an item as skipped at four
            // sites that never touch errors[]: an unmapped account, a null
            // portfolio, a null account key, or an item type this build does not
            // handle (PpClient.java). So {0 imported, N skipped, errors: []} is
            // the dominant failure mode, and it rendered byte-identical to a
            // healthy run on both surfaces - the #627 defect class by a second
            // path. Only flag it when nothing at all came in: a statement with
            // items legitimately skipped alongside a real import is normal.
            const imported =
                (flexImport.trades_imported || 0) +
                (flexImport.dividends_imported || 0) +
                (flexImport.other_imported || 0);
            const skipped = flexImport.items_skipped || 0;
            if (imported === 0 && skipped > 0) {
                legErrs.push(
                    `⚠️ IBKR import: nothing imported — all ${skipped} item${skipped === 1 ? "" : "s"} skipped`,
                );
            }
        }
    }

    // taxonomy_export is a fifth remote leg in the same payload (tools.js returns
    // it alongside the other four) and it is the leg whose whole job is writing
    // the sheet the operator reads. It has three failure shapes: status "error"
    // when queryTaxonomies throws, "partial" with an errors[] list when cells fail
    // or a classification has no mapping, and "skipped" per configuration gap.
    // "skipped" is configuration absence, so it must not warn on every run.
    const tax = raw.taxonomy_export;
    if (tax) {
        if (tax.status === "error") {
            legErrs.push(`⚠️ Sheets export: ${tax.detail || tax.error || "failed"}`);
        } else if (tax.status === "partial") {
            const errs = Array.isArray(tax.errors) ? tax.errors : [];
            legErrs.push(
                `⚠️ Sheets export: ${errs.length} cell${errs.length === 1 ? "" : "s"} failed — ` +
                    `${errs.join("; ") || "partial write"}`,
            );
        }
    }

    // portfolio_status is a sixth remote leg. tools.js:1025 stores a failed
    // status fetch as { error: e.message } and nothing downstream consumes it —
    // _buildAnalysis takes taxonomyData, not the status — so before this the
    // only trace of a dead Portfolio.app status call was a console.warn nobody
    // reads in a cron log. Reported here so the cron surface cannot look clean.
    const status = raw.portfolio_status;
    if (status && typeof status === "object" && status.error) {
        legErrs.push(`⚠️ Portfolio status: ${status.error}`);
    }

    // The sync aborted before it assembled a payload (an Actual Budget outage
    // throws out of fetchBudget). Without this the operator got the empty string
    // and the aborting error was lost, which is what let a dead grant look clean
    // during an AB outage.
    const abortErrs = [];
    if (raw.error) {
        abortErrs.push(`❌ Sync aborted: ${raw.error}`);
    }

    const pre = [...legErrs, ...abortErrs];

    // Pre-computed analysis block (the authoritative portfolio display)
    // Return it directly — analysis.message_body already includes its own sync header.
    // The error lines are still prepended, because this early return is
    // the normal path after a taxonomy export and would otherwise hide them.
    if (raw.analysis?.message_body) {
        return pre.length
            ? [...pre, raw.analysis.message_body].join("\n")
            : raw.analysis.message_body;
    }

    // Fallback: no analysis available, show bare sync status
    return [...pre, ...lines].join("\n");
}

function createTools(server, registry) {
    server.tool(
        "portfolio_sync",
        "Full portfolio sync — OneDrive pull → IBKR flex → import → AB sync → push → taxonomy. Returns the complete portfolio report (sync status + formatted holdings, sectors, news). Relay this output directly without re-narrating or adding commentary.",
        {},
        async () => {
            if (!registry._ppBridge) {
                const tokenPath =
                    process.env.ONEDRIVE_REFRESH_TOKEN_PATH ||
                    "/app/config/onedrive/refresh_token";
                const hasToken = existsSync(tokenPath);
                if (!hasToken)
                    return tx({
                        status: "error",
                        error: "OneDrive not authorized. Portfolio file cannot be synced.",
                        action: "Run /onedrive setup to authorize OneDrive, then /onedrive pull to download the portfolio file.",
                    });
                return tx({
                    status: "error",
                    error: "Portfolio file not found on disk. OneDrive pull may not have run yet.",
                    action: "Run /onedrive pull to download the portfolio file from OneDrive.",
                });
            }
            const raw = await registry._computeSyncAll();
            const output = formatSyncResult(raw);
            return { content: [{ type: "text", text: output }] };
        },
    );
    server.tool(
        "portfolio_onedrive_auth_url",
        "Get Microsoft OAuth URL for OneDrive one-time authorization.",
        {},
        async () => {
            try {
                return tx({ url: getAuthUrl() });
            } catch (e) {
                return tx({ error: e.message });
            }
        },
    );
    server.tool(
        "portfolio_onedrive_auth_complete",
        "Complete OneDrive OAuth by exchanging auth code for refresh token.",
        { redirect_uri: z.string().min(1) },
        async (args) => {
            try {
                return tx(await exchangeCodeForToken(args.redirect_uri));
            } catch (e) {
                return tx({ success: false, error: e.message });
            }
        },
    );
    server.tool(
        "portfolio_onedrive_status",
        "Check OneDrive authorization by validating refresh token against Microsoft.",
        {},
        async () => {
            const tokenPath =
                process.env.ONEDRIVE_REFRESH_TOKEN_PATH ||
                "/app/config/onedrive/refresh_token";
            const clientId = process.env.ONEDRIVE_CLIENT_ID || "";
            if (!existsSync(tokenPath))
                return tx({
                    authorized: false,
                    reason: "No token file",
                    action: "Run /onedrive setup",
                });
            try {
                const { readFileSync } = await import("fs");
                const r = await fetch(
                    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/x-www-form-urlencoded",
                        },
                        body: new URLSearchParams({
                            client_id: clientId,
                            refresh_token: readFileSync(
                                tokenPath,
                                "utf8",
                            ).trim(),
                            grant_type: "refresh_token",
                            redirect_uri:
                                "https://login.microsoftonline.com/common/oauth2/nativeclient",
                        }).toString(),
                        signal: AbortSignal.timeout(10000),
                    },
                );
                if (!r.ok) {
                    const t = await r.text();
                    return tx({
                        authorized: false,
                        reason: `HTTP ${r.status}`,
                        detail: t.slice(0, 200),
                        action: "Run /onedrive setup",
                    });
                }
                return tx({
                    authorized: true,
                    client_id: clientId
                        ? clientId.slice(0, 8) + "..."
                        : "not set",
                });
            } catch (e) {
                return tx({
                    authorized: false,
                    reason: e.message,
                    action: "Run /onedrive setup",
                });
            }
        },
    );
    server.tool(
        "portfolio_onedrive_pull",
        "Download Portfolio.portfolio from OneDrive.",
        {},
        async () => tx(await pullFromOneDrive()),
    );
    server.tool(
        "portfolio_onedrive_push",
        "Upload Portfolio.portfolio to OneDrive.",
        {},
        async () => tx(await pushToOneDrive()),
    );
    server.tool(
        "portfolio_insert_transaction",
        "Pull from OneDrive → insert transaction via Java CLI → push back to OneDrive. Fully self-contained.",
        {
            account_id: z.string().min(1),
            security_id: z.string().optional().default(""),
            type: z.enum([
                "Buy",
                "Sell",
                "Dividend",
                "Deposit",
                "Withdrawal",
                "Fee",
                "Tax",
                "Interest",
            ]),
            date: z.string().min(1),
            shares: z.number(),
            price: z.number(),
            currency_code: z.string().min(1),
            fees: z.number().default(0),
            taxes: z.number().default(0),
            notes: z.string().optional().default(""),
            offset_account_id: z.string().optional(),
        },
        async (args) => {
            const result = {};

            // PP_OFFSET_MAP: account UUID → portfolio UUID for share routing
            // (always resolved independently of offset_account_id for cash)
            args._portfolio_id = null;
            if (process.env.PP_OFFSET_MAP) {
                try {
                    const map = JSON.parse(process.env.PP_OFFSET_MAP);
                    args._portfolio_id = map[args.account_id] || null;
                } catch (e) { /* ignore */ }
            }

            // 1. Pull from OneDrive
            try {
                result.pull = await pullFromOneDrive();
            } catch (e) {
                return tx({ error: "OneDrive pull failed", detail: e.message });
            }
            if (result.pull?.status === "error") {
                return tx({
                    error: "OneDrive pull failed",
                    detail: result.pull,
                });
            }

            // 2. Insert transaction
            try {
                result.insert = await registry.executeTool(
                    "insert_pp_transaction",
                    args,
                );
            } catch (e) {
                return tx({
                    error: "Transaction insert failed",
                    detail: e.message,
                    pull: result.pull,
                });
            }
            if (result.insert?.error) {
                return tx({ ...result.insert, pull: result.pull });
            }

            // 3. Push back to OneDrive
            try {
                result.push = await pushToOneDrive();
            } catch (e) {
                result.push = { status: "error", detail: e.message };
            }

            return tx(result);
        },
    );
    server.tool(
        "portfolio_get_all",
        "Get all portfolio accounts, securities, and holdings. Use before inserting transactions.",
        {},
        async () => {
            if (!registry._ppBridge)
                return tx({ error: "PP bridge not configured" });
            return tx(await registry.executeTool("fetch_pp_portfolio", {}));
        },
    );
    server.tool(
        "portfolio_query_security",
        "Query a security by ticker, ISIN, or name. Returns shares held, latest price, market value, and cost basis (total_cost_basis, avg_cost_per_share).",
        { search: z.string().min(1) },
        async (args) => {
            if (!registry._ppBridge)
                return tx({ error: "PP bridge not configured" });
            return tx(
                await registry.executeTool("query_pp_security", {
                    search: args.search,
                }),
            );
        },
    );
    server.tool(
        "portfolio_taxonomy",
        "Query taxonomy breakdown with per-cell children. Returns liquid/illiquid split, each classification's valuation, share_pct, and individual holding children (name, ticker, currency, valuation_native). 'Without Classification' = illiquid assets.",
        { names: z.array(z.string()).optional().default(["Regions (Liquid)"]) },
        async (args) => {
            if (!registry._ppBridge)
                return tx({ error: "PP bridge not configured" });
            return tx(
                await registry.executeTool("query_pp_taxonomies", {
                    taxonomy_names: args.names,
                }),
            );
        },
    );
    server.tool(
        "portfolio_search_memory",
        "Search the PORTFOLIO tracker's legacy security/account notes (read-only; never returns credentials). The finance wiki is the authority. Use a SINGLE keyword such as a broker name (\"IBKR\", \"POEMS\").",
        { query: z.string().min(1) },
        async (args) =>
            tx(await registry.executeTool("search_memory", { query: args.query })),
    );
    server.tool(
        "portfolio_learn_fact",
        "Propose a free-form fact for the finance wiki (queued for the owner's review; credentials are refused). Deduplicated automatically.",
        { fact: z.string().min(1) },
        async (args) =>
            tx(await registry.executeTool("learn_fact", { fact: args.fact })),
    );
}

export function createMcpServer(registry, app) {
    const transports = {};

    app.post("/mcp", async (req, res) => {
        try {
            const sessionId = req.headers["mcp-session-id"];
            let transport;

            if (sessionId && transports[sessionId]) {
                transport = transports[sessionId];
            } else {
                // No session or stale session (container restart): create new
                const server = new McpServer({
                    name: "portfolio-tracker",
                    version: "1.0.0",
                });
                createTools(server, registry);
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    enableJsonResponse: true,
                    onsessioninitialized: (sid) => {
                        transports[sid] = transport;
                    },
                });
                transport.onclose = () => {
                    const sid = transport.sessionId;
                    if (sid) delete transports[sid];
                };
                await server.connect(transport);
            }
            await transport.handleRequest(req, res, req.body);
        } catch (e) {
            console.error(
                JSON.stringify({ event: "mcp_error", error: e.message }),
            );
            if (!res.headersSent)
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal server error" },
                    id: null,
                });
        }
    });

    app.get("/mcp", async (req, res) => {
        const sessionId = req.headers["mcp-session-id"];
        if (!sessionId || !transports[sessionId]) {
            res.status(400).end("Invalid session");
            return;
        }
        try {
            await transports[sessionId].handleRequest(req, res);
        } catch (e) {
            if (!res.headersSent) res.status(500).end();
        }
    });

    app.delete("/mcp", async (req, res) => {
        const sessionId = req.headers["mcp-session-id"];
        if (!sessionId || !transports[sessionId]) {
            res.status(400).end("Invalid session");
            return;
        }
        try {
            await transports[sessionId].handleRequest(req, res);
        } catch (e) {
            if (!res.headersSent) res.status(500).end();
        }
    });

    console.log(
        JSON.stringify({
            event: "mcp_server_ready",
            transport: "streamable-http",
        }),
    );
}

function tx(result) {
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
