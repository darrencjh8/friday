/**
 * Expense Tracker — Node.js entry point.
 * Ported 1:1 from src/main.py
 */

import express from "express";
import { Config } from "./config.js";
import { createKnowledgeStore } from "./wiki-knowledge.js";
import { ToolRegistry, StatementJournal } from "./tools.js";
import { AgentOrchestrator } from "./orchestrator.js";
import { ImapIdleHandler } from "./imap.js";
import { classifyEmail, dispatchEmail } from "./classify.js";
import { createMcpServer } from "./mcp-server.js";
import { logger } from "./logging.js";
import { DedupJournal } from "./dedup.js";

import { StatementProcessor } from "./statement/orchestrator.js";
import { ProcessingService, RequestJournal, createProcessHandler } from "./processing.js";
import { LearningNotifier, createAnswerHandler } from "./learning-notify.js";
import { migratePendingLearning } from "./learning.js";

// ── Crash diagnostics ──────────────────────────────────────────────

process.on("unhandledRejection", (reason) => {
    logger.error({
        event: "fatal_unhandled_rejection",
        error: String(reason),
    });
    process.exit(1);
});

process.on("uncaughtException", (err) => {
    logger.error({
        event: "fatal_uncaught_exception",
        error: err.message,
    });
    process.exit(1);
});

process.on("beforeExit", (code) => {
    logger.error({
        event: "process_before_exit",
        code,
    });
});

async function main() {
    const cfg = Config.fromEnv();
    logger.info({
        event: "starting",
        timestamp: new Date().toISOString(),
    });

    // Knowledge: the wiki's finance pages when WIKI_DIR is set (issue #783),
    // else MEMORY.md, migrated from mappings.json if it does not exist yet.
    const memory = createKnowledgeStore(cfg, {
        onMigrate: () => logger.info({ event: "migrating_mappings_to_memory" }),
    });
    logger.info({
        event: "memory_initialized",
        data: { facts: memory.listFacts().length, source: cfg.wikiDir ? "wiki" : "memory" },
    });

    // Offers moved off the hermes-mounted data volume (#723). With commands on,
    // the old file is deleted rather than imported.
    const learningCommandsOn = Boolean(cfg.telegramBotToken && cfg.telegramHomeChannel);
    if (
        cfg.pendingLearningPath &&
        migratePendingLearning("data/pending-learning.json", cfg.pendingLearningPath, { discard: learningCommandsOn })
    ) {
        logger.info({ event: "pending_learning_migrated", path: cfg.pendingLearningPath });
    }

    const registry = new ToolRegistry(cfg, memory);
    const orchestrator = new AgentOrchestrator(cfg, registry);
    registry.setOrchestrator(orchestrator);
    const dedupJournal = new DedupJournal(cfg.dedupDbPath);

    // Statement reconciliation pipeline (spec/004)
    const statementJournal = new StatementJournal(cfg.statementDbPath);
    registry.setStatementJournal(statementJournal);
    const statementProcessor = new StatementProcessor(cfg, registry);

    const imapHandler = new ImapIdleHandler(
        cfg.imapHost,
        cfg.imapPort,
        cfg.imapUsername,
        cfg.imapPassword,
        dedupJournal,
        cfg.imapMailbox,
    );
    // Seed imapHandler at startup so list_inbox_emails / read_inbox_email
    // work immediately without waiting for the first email to arrive.
    registry.setEmailContext(null, null, imapHandler);

    async function onNewEmail(msg) {
        let result = null;
        try {
            result = await dispatchEmail(
                msg,
                (raw, subject, sender) =>
                    classifyEmail(raw, subject, sender, cfg),
                orchestrator,
                imapHandler,
                statementProcessor,
            );
            // The idle loop keys retries and booked marking off this result.
            return result;
        } catch (err) {
            registry.setEmailContext(msg.msg_id, msg.raw_email, imapHandler);
            const notified = await registry.executeTool("notify_user", {
                message: `Error processing email "${msg.subject || ""}": ${err.message}`,
            });
            if (!notified) {
                logger.error({
                    event: "notify_user_failed",
                    context: "on_new_email_error",
                    error: err.message,
                });
            }
            throw err;
        }
    }

    const app = express();
    app.use(express.json({ limit: "10mb" }));

    // Health check
    // Hermes intake reads email_watcher and starts live booking only once it is off.
    app.get("/health", (_req, res) =>
        res.json({ status: "ok", email_watcher: cfg.emailWatcher === false ? "off" : "on" }),
    );

    // Register MCP SSE BEFORE listening — hermes depends on it
    createMcpServer(registry, app);

    // Register all tool endpoints
    const toolNames = [
        "search_memory",
        "search_wiki",
        "learn_fact",
        "list_facts",
        "update_fact",
        "delete_fact",
        "cleanup_facts",
        "fetch_budgets",
        "fetch_accounts",
        "fetch_categories",
        "fetch_payees",
        "fetch_budget_month",
        "fetch_recent_transactions",
        "insert_transaction",
        "check_duplicate",
        "extract_pdf_text",
        "reconcile_transaction",
        "unclear_transaction",
        "fetch_unreconciled_transactions",
        "record_statement",
        "fetch_statement_history",
        "mark_email_read",
        "notify_user",
        "log_decision",
        "extract_email_content",
        "check_statement_duplicate",
        "resolve_merchant",
        "list_pending_learning",
        "confirm_learning",
        "decline_learning",
        "update_transaction",
        "extract_inbox_pdf",
        "match_broker_deposit",
    ];

    // With commands on, the user's /remember is the only confirm (#723). The
    // answer route is not a tool: it needs a signature only Hermes's plugin
    // (holding the bot token) can compute.
    if (learningCommandsOn) {
        registry.setLearningNotifier(
            new LearningNotifier({ token: cfg.telegramBotToken, chatId: cfg.telegramHomeChannel }),
        );
    }
    app.post(
        "/learning/answer",
        createAnswerHandler({ registry, token: cfg.telegramBotToken, chatId: cfg.telegramHomeChannel }),
    );

    // Processing contract for Hermes email-intake (#783): one signed request
    // per email; Hermes owns the mailbox and every user notification.
    const processing = new ProcessingService({
        orchestrator,
        statementProcessor,
        tools: registry,
        journal: new RequestJournal(cfg.processingDbPath),
    });
    for (const kind of ["transaction", "statement"]) {
        app.post(
            `/process/${kind}`,
            createProcessHandler({ service: processing, kind, secret: cfg.notifySecret }),
        );
    }

    for (const name of toolNames) {
        if (learningCommandsOn && name === "confirm_learning") continue;
        app.post(`/tools/${name.replace(/_/g, "-")}`, async (req, res) => {
            try {
                // `evidence` is the orchestrator's own argument to resolve_merchant
                // (the email, for Jev). A caller on this route must not be able to
                // supply it, or it could spend a Jev call on text it chose (#720).
                const { evidence: _evidence, ...args } = req.body || {};
                const result = await registry.executeTool(name, args);
                res.json(result);
            } catch (e) {
                res.status(e.message?.startsWith("Unknown") ? 404 : 500).json({
                    error: e.message,
                    code: "TOOL_ERROR",
                });
            }
        });
    }

    const port = 8080;
    return new Promise((resolve, reject) => {
        const server = app.listen(port, "0.0.0.0", () => {
            logger.info({
                event: "health_check_started",
                data: { port },
            });
            // Start IMAP idle loop in background, unless Hermes intake books the mail.
            if (cfg.emailWatcher === false) {
                logger.info({ event: "imap_watcher_disabled", reason: "email_intake_live" });
            } else {
                imapHandler.idleLoop(onNewEmail).catch((err) => {
                    logger.error({ event: "imap_idle_error", error: err.message });
                });
            }

            // Periodic dedup cleanup (every 6 hours)
            const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
            setInterval(() => {
                try {
                    dedupJournal.cleanup();
                    logger.debug({ event: "dedup_cleanup_completed" });
                } catch (e) {
                    logger.warn({ event: "dedup_cleanup_failed", error: e.message });
                }
            }, CLEANUP_INTERVAL_MS);

            resolve(server);
        });
        server.on("error", reject);
    });
}

main()
    .then(() => {
        logger.info({ event: "ready" });
    })
    .catch((err) => {
        logger.error({ event: "startup_failed", error: err.message });
        process.exit(1);
    });
