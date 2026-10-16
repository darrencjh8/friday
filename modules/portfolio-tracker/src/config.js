/**
 * Environment-based configuration for the portfolio tracker.
 * Ported 1:1 from src/config.py
 */

import { readFileSync } from "fs";

const REQUIRED_ENV_VARS = [
    "DEEPSEEK_API_KEY",
    "ACTUAL_BUDGET_URL",
    "ACTUAL_BUDGET_PASSWORD",
    "ACTUAL_PRIMARY_BUDGET_FILE",
];

export class Config {
    constructor(env = process.env) {
        // Validate required env vars
        const missing = REQUIRED_ENV_VARS.filter((k) => !env[k]);
        if (missing.length > 0) {
            throw new Error(
                `Missing required environment variables: ${missing.join(", ")}`,
            );
        }

        // Required
        this.deepseekApiKey = env.DEEPSEEK_API_KEY || "";

        // LLM: the codex-router's auto-thinking (Responses API), with direct
        // DeepSeek as the fallback (#695)
        this.llmBaseUrl = env.LLM_BASE_URL || "http://codex-router:4100/v1";
        this.llmModel = env.LLM_MODEL || "auto-thinking";
        this.llmApiKey = env.LLM_API_KEY || "";
        this.llmReasoningEffort = env.LLM_REASONING_EFFORT || "low";
        this.actualBudgetUrl = env.ACTUAL_BUDGET_URL || "";
        this.actualBudgetPassword = env.ACTUAL_BUDGET_PASSWORD || "";
        this.primaryBudgetFile = env.ACTUAL_PRIMARY_BUDGET_FILE || "";
        this.secondaryBudgetFile = env.ACTUAL_SECONDARY_BUDGET_FILE || "";

        // Google Sheets — supports both file path and inline JSON
        const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
        if (raw && (raw.startsWith("/") || raw.startsWith("./"))) {
            try {
                this.googleServiceAccountJson = readFileSync(raw, "utf8");
            } catch {
                this.googleServiceAccountJson = raw;
            }
        } else {
            this.googleServiceAccountJson = raw;
        }
        this.googleSheetId = env.GOOGLE_SHEET_ID || "";

        // Taxonomy
        const taxonomyRaw =
            env.TAXONOMY_NAMES || "Sector,Geography,Asset Class";
        this.taxonomyNames = taxonomyRaw
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);

        const mappingRaw = env.TAXONOMY_SHEET_MAPPING || "";
        this.taxonomySheetMapping = {};
        if (mappingRaw) {
            for (const pair of mappingRaw.split(",")) {
                const colonIdx = pair.indexOf(":");
                if (colonIdx > 0) {
                    const key = pair.slice(0, colonIdx).trim();
                    const cell = pair.slice(colonIdx + 1).trim();
                    this.taxonomySheetMapping[key] = cell;
                }
            }
        }

        // Portfolio Performance
        this.ppXmlPath = env.PP_XML_PATH || "/data/portfolio.xml";
        this.ppJarPath = env.PP_JAR_PATH || "/app/pp-cli.jar";
        this.ppPassword = env.PP_PASSWORD || "";

        // PP account UUIDs for balance sync
        this.ppEmergencyPrimaryAccount = env.PP_EMERGENCY_PRIMARY_ACCOUNT || "";
        this.ppEmergencySecondaryAccount =
            env.PP_EMERGENCY_SECONDARY_ACCOUNT || "";
        this.ppWarchestPrimaryAccount = env.PP_WARCHEST_PRIMARY_ACCOUNT || "";

        // Data paths
        this.dedupDbPath = env.DEDUP_DB_PATH || "data/dedup.db";
        this.processingDbPath = env.PROCESSING_DB_PATH || "data/processing.db";
        // Shared with Hermes; signs /process/portfolio requests (#783).
        this.hermesWebhookSecret = env.HERMES_WEBHOOK_SECRET || "";
        this.mappingsPath = env.MAPPINGS_PATH || "data/mappings.json";
        // Semantic facts/password store (separate from mappings.json)
        this.portfolioMemoryPath =
            env.PORTFOLIO_MEMORY_PATH || "data/MEMORY.md";

        // User
        this.userName = env.USER_NAME || "there";
        this.systemPromptExtra = env.SYSTEM_PROMPT_EXTRA || "";

        // IMAP for email processing
        this.imapHost = env.IMAP_HOST || "imap.example.com";
        this.imapPort = parseInt(env.IMAP_PORT || "993", 10);
        this.imapUsername = env.IMAP_USERNAME || "";
        this.imapPassword = env.IMAP_PASSWORD || "";
        this.imapFolder = env.IMAP_FOLDER || "Trades";

        // Gateway / notifications
        this.openclawGatewayUrl =
            env.OPENCLAW_GATEWAY_URL || "http://openclaw:18800";
        this.notificationSmtpHost =
            env.NOTIFICATION_SMTP_HOST || "smtp.example.com";
        this.notificationSmtpPort = parseInt(
            env.NOTIFICATION_SMTP_PORT || "587",
            10,
        );
        this.notificationEmail = env.NOTIFICATION_EMAIL || "";
        // Facts are proposals for the finance wiki, never a local store (#783).
        this.wikiProposalsPath = env.WIKI_PROPOSALS_PATH || "data/wiki-proposals.jsonl";

        // OneDrive
        this.onedriveRefreshTokenPath =
            env.ONEDRIVE_REFRESH_TOKEN_PATH ||
            "/app/config/onedrive/refresh_token";
        this.onedriveDataDir = env.ONEDRIVE_DATA_DIR || "/data/onedrive";
        if (!env.ONEDRIVE_CLIENT_ID) {
            throw new Error(
                "Missing required environment variable: ONEDRIVE_CLIENT_ID",
            );
        }
        this.onedriveClientId = env.ONEDRIVE_CLIENT_ID;

        // IBKR Flex Web Service
        this.ibkrFlexToken = env.IBKR_FLEX_TOKEN || "";
        this.ibkrFlexQueryId = env.IBKR_FLEX_QUERY_ID || "";
    }

    static fromEnv() {
        return new Config();
    }
}
