/**
 * Java CLI bridge for Portfolio Performance XML manipulation.
 * Ported 1:1 from src/pp_client/java_bridge.py
 *
 * All PP commands: accounts, securities, portfolio, insert, balance,
 * taxonomy, transactions, status, query
 */

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { pullFromOneDrive } from "./onedrive.js";

// Global async lock to serialize all PP file write operations.
// Without this, concurrent updateBalance/insertTransaction calls
// race on OneDrive download → save → upload, corrupting the file.
let writeLock = Promise.resolve();

function acquireWriteLock() {
    let release;
    const next = new Promise((resolve) => {
        release = resolve;
    });
    const prev = writeLock;
    writeLock = writeLock.then(() => next);
    return prev.then(() => release);
}

export class PpJavaBridge {
    /**
     * @param {string} jarPath - Path to pp-cli.jar
     * @param {string} xmlPath - Path to Portfolio.portfolio XML file
     * @param {string} password - Optional PP file password
     * @param {number} timeout - Command timeout in seconds (default 30)
     */
    constructor(jarPath, xmlPath, password = "", timeout = 30) {
        this._jarPath = jarPath;
        this._xmlPath = xmlPath;
        this._password = password;
        this._timeout = timeout * 1000; // convert to ms
    }

    _validateJar() {
        if (!existsSync(this._jarPath)) {
            throw new Error(`Java CLI JAR not found: ${this._jarPath}`);
        }
    }

    /**
     * Execute a Java CLI command and return parsed JSON result.
     * @param {...string} args
     * @returns {Promise<object>}
     */
    async _runCommand(...args) {
        this._validateJar();
        const cmdArgs = ["-jar", this._jarPath];
        cmdArgs.push(args[0]); // command name
        if (this._password) {
            cmdArgs.push("--password", this._password);
        }
        cmdArgs.push(...args.slice(1));

        return new Promise((resolve, reject) => {
            const proc = spawn("java", cmdArgs, {
                stdio: ["ignore", "pipe", "pipe"],
                timeout: this._timeout,
            });

            let stdout = "";
            let stderr = "";

            proc.stdout.on("data", (data) => {
                stdout += data.toString();
            });
            proc.stderr.on("data", (data) => {
                stderr += data.toString();
            });

            proc.on("error", (err) => {
                reject(
                    new Error(
                        `Java not found. Install Java 17+ to use the PP CLI: ${err.message}`,
                    ),
                );
            });

            proc.on("close", async (code) => {
                if (code !== 0) {
                    const errMsg = stderr.trim();

                    // Auto-recover: if file is corrupted, re-download from OneDrive and retry once
                    if (
                        errMsg.includes("IllegalBlockSize") ||
                        errMsg.includes("decrypt") ||
                        errMsg.toLowerCase().includes("corrupt")
                    ) {
                        try {
                            await this._syncFromOneDrive();
                            // Retry the same command
                            const retryProc = spawn("java", cmdArgs, {
                                stdio: ["ignore", "pipe", "pipe"],
                                timeout: this._timeout,
                            });
                            let retryStdout = "";
                            let retryStderr = "";
                            retryProc.stdout.on("data", (d) => {
                                retryStdout += d.toString();
                            });
                            retryProc.stderr.on("data", (d) => {
                                retryStderr += d.toString();
                            });

                            await new Promise((res2, rej2) => {
                                retryProc.on("close", (c2) => {
                                    if (c2 !== 0) {
                                        rej2(
                                            new Error(
                                                retryStderr.trim() ||
                                                    `Java CLI exit ${c2}`,
                                            ),
                                        );
                                    } else {
                                        res2();
                                    }
                                });
                                retryProc.on("error", rej2);
                            });

                            try {
                                resolve(JSON.parse(retryStdout.trim()));
                                return;
                            } catch {
                                reject(
                                    new Error(
                                        `Java CLI error (exit ${code}): ${errMsg}`,
                                    ),
                                );
                                return;
                            }
                        } catch {
                            // Fall through to original error
                        }
                    }

                    // Try to parse error as JSON
                    try {
                        const errData = JSON.parse(errMsg);
                        reject(new Error(errData.error || errMsg));
                    } catch {
                        reject(
                            new Error(
                                `Java CLI error (exit ${code}): ${errMsg || "unknown error"}`,
                            ),
                        );
                    }
                    return;
                }

                try {
                    resolve(JSON.parse(stdout.trim()));
                } catch {
                    resolve({ raw: stdout.trim() });
                }
            });
        });
    }

    /**
     * Re-download PP file from OneDrive after corruption.
     */
    async _syncFromOneDrive() {
        const result = await pullFromOneDrive();
        if (!result.success) {
            throw new Error(`OneDrive recovery pull failed: ${result.error}`);
        }
    }

    /** List all accounts with UUIDs, names, currencies */
    async getAccounts() {
        const result = await this._runCommand(
            "accounts",
            "--file",
            this._xmlPath,
        );
        return Array.isArray(result) ? result : result.accounts || [];
    }

    /** List all securities with ISIN, ticker, name, currency */
    async getSecurities() {
        const result = await this._runCommand(
            "securities",
            "--file",
            this._xmlPath,
        );
        return Array.isArray(result) ? result : result.securities || [];
    }

    /** Full portfolio structure: accounts + securities + holdings */
    async getPortfolio() {
        return this._runCommand("portfolio", "--file", this._xmlPath);
    }

    /**
     * Insert a transaction into Portfolio Performance.
     */
    async insertTransaction({
        accountId,
        securityId = "",
        txnType,
        date,
        shares,
        price,
        currencyCode,
        fees = 0,
        taxes = 0,
        notes = "",
        offsetAccountId = null,
        portfolioId = null,
    }) {
        const release = await acquireWriteLock();
        try {
            const args = [
                "insert",
                "--file",
                this._xmlPath,
                "--account-id",
                accountId,
                "--type",
                txnType,
                "--date",
                date,
                "--shares",
                String(shares),
                "--price",
                String(price),
                "--currency",
                currencyCode,
                "--fees",
                String(fees),
                "--taxes",
                String(taxes),
            ];
            if (securityId) {
                args.push("--security-id", securityId);
            }
            if (portfolioId) {
                args.push("--portfolio-id", portfolioId);
            }
            if (offsetAccountId) {
                args.push("--offset-account-id", offsetAccountId);
            }
            if (notes) {
                args.push("--notes", notes);
            }
            return this._runCommand(...args);
        } finally {
            release();
        }
    }

    /**
     * Update an account balance to a specific amount.
     */
    async updateBalance({ accountId, amount, currencyCode, date, notes = "" }) {
        const release = await acquireWriteLock();
        try {
            const args = [
                "balance",
                "--file",
                this._xmlPath,
                "--account-id",
                accountId,
                "--amount",
                String(amount),
                "--currency",
                currencyCode,
                "--date",
                date,
            ];
            if (notes) {
                args.push("--notes", notes);
            }
            return this._runCommand(...args);
        } finally {
            release();
        }
    }

    /**
     * Query holdings aggregated by taxonomy values.
     * @param {string[]} names - Taxonomy names e.g. ["Regions (Liquid)"]
     */
    async queryTaxonomies(names) {
        const args = [
            "taxonomy",
            "--file",
            this._xmlPath,
            "--names",
            names.join(","),
        ];
        return this._runCommand(...args);
    }

    /** List all transactions */
    async getTransactions() {
        const result = await this._runCommand(
            "transactions",
            "--file",
            this._xmlPath,
        );
        return Array.isArray(result) ? result : result.transactions || [];
    }

    /**
     * Portfolio performance summary: holdings with prices, total value,
     * per-currency breakdown.
     */
    async getStatus() {
        return this._runCommand("status", "--file", this._xmlPath);
    }

    /**
     * Query a security by ticker, ISIN, or name.
     * Returns shares held, avg entry price, latest price, market value.
     */
    async querySecurity(search, accountId) {
        const args = [
            "query",
            "--file",
            this._xmlPath,
            "--search",
            search,
        ];
        if (accountId) {
            args.push("--account-id", accountId);
        }
        return this._runCommand(...args);
    }

    /**
     * Download latest PP file from OneDrive.
     * Call before viewing/editing PP data to ensure fresh copy.
     */
    async pull() {
        try {
            const result = await pullFromOneDrive();
            return {
                status: result.success ? "ok" : "error",
                detail: result.success ? "downloaded" : result.error,
            };
        } catch (e) {
            return { status: "error", detail: e.message };
        }
    }

    /**
     * Import IBKR Flex Query XML into Portfolio Performance.
     * Uses the same IBFlexStatementExtractor as the PP desktop UI.
     * Handles: trades, dividends, deposits, fees, interest, taxes,
     * corporate actions, sales tax, FX conversions.
     * Matches securities by CONID → ISIN → ticker + exchange suffix.
     * Auto-creates missing securities.
     *
     * @param {string} xmlContentB64 - Base64-encoded IBKR flex query XML
     * @returns {Promise<object>}
     */
    async importIbkr(xmlContentB64) {
        const release = await acquireWriteLock();
        try {
            const { writeFileSync, unlinkSync } = await import("fs");
            const { tmpdir } = await import("os");
            const { join } = await import("path");
            const { randomBytes } = await import("crypto");

            const xmlContent = Buffer.from(xmlContentB64, "base64").toString(
                "utf8",
            );
            const tmpFile = join(
                tmpdir(),
                `ibkr-flex-${randomBytes(8).toString("hex")}.xml`,
            );
            writeFileSync(tmpFile, xmlContent);

            const sgdAccount = process.env.IBKR_PP_SGD_ACCOUNT;
            const usdAccount = process.env.IBKR_PP_USD_ACCOUNT;
            const portfolioAccount =
                process.env.IBKR_PP_PORTFOLIO_ACCOUNT || "";

            if (!sgdAccount) throw new Error("IBKR_PP_SGD_ACCOUNT is required");
            if (!usdAccount) throw new Error("IBKR_PP_USD_ACCOUNT is required");

            try {
                const args = [
                    "import",
                    "--file",
                    this._xmlPath,
                    "--ibkr-xml",
                    tmpFile,
                    "--ibkr-sgd-account",
                    sgdAccount,
                    "--ibkr-usd-account",
                    usdAccount,
                ];
                if (portfolioAccount) {
                    args.push("--ibkr-portfolio-account", portfolioAccount);
                }
                return await this._runCommand(...args);
            } finally {
                try {
                    unlinkSync(tmpFile);
                } catch {
                    /* cleanup best-effort */
                }
            }
        } finally {
            release();
        }
    }

    /**
     * Upload PP file to OneDrive to persist changes.
     * Call after making changes.
     */
    async push() {
        try {
            const { pushToOneDrive } = await import("./onedrive.js");
            const result = await pushToOneDrive(this._xmlPath);
            return {
                status: result.success ? "ok" : "error",
                detail: result.success ? "uploaded" : result.error,
            };
        } catch (e) {
            return { status: "error", detail: e.message };
        }
    }
}
