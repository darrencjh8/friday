/**
 * IMAP IDLE handler for monitoring an IMAP inbox.
 * Ported 1:1 from src/imap/idle_handler.py
 * Uses imapflow for async IMAP with IDLE support.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { logger } from "./logging.js";
import { extractPdfFromBuffer } from "./extractors.js";

/** Minutes before an email the LLM could not read is tried again (#694). */
const LLM_RETRY_MINUTES = 5;

export class ImapIdleHandler {
    IDLE_TIMEOUT = 15; // fast retry, dedup prevents re-processing
    RECONNECT_DELAY = 5;

    /**
     * @param {string} host
     * @param {number} port
     * @param {string} username
     * @param {string} password
     * @param {import('./dedup.js').DedupJournal} [dedupJournal]
     * @param {string} [mailbox="INBOX"]
     */
    constructor(
        host,
        port,
        username,
        password,
        dedupJournal = null,
        mailbox = "INBOX",
    ) {
        this._host = host;
        this._port = port;
        this._username = username;
        this._password = password;
        this._client = null;
        this._running = false;
        this._dedup = dedupJournal;
        this._mailbox = mailbox;
    }

    async connect() {
        const client = new ImapFlow({
            host: this._host,
            port: this._port,
            secure: true,
            auth: { user: this._username, pass: this._password },
            logger: false,
            disableAutoIdle: true,
        });
        this._client = client;
        client.on?.("error", (err) => {
            logger.warn({
                event: "imap_client_error",
                error: err?.message || String(err),
                retry_in_s: this.RECONNECT_DELAY,
            });
            if (this._client === client) this._client = null;
        });
        await client.connect();
        await client.mailboxOpen(this._mailbox);
    }

    async disconnect() {
        if (this._client) {
            try {
                await this._client.logout();
            } catch {}
            this._client = null;
        }
    }

    async fetchUnread() {
        if (!this._client) return [];
        // A UID identifies a message only inside one UIDVALIDITY epoch. When the
        // server changes it, every uid the journal remembers may now belong to a
        // different message, so the journal drops that state before this batch
        // is checked (issue #558).
        if (this._dedup)
            this._dedup.noteMailboxUidValidity(
                this._client.mailbox?.uidValidity,
            );
        const messages = [];
        const seen = new Set();
        for await (const msg of this._client.fetch(
            { unseen: true },
            { source: true, envelope: true },
        )) {
            if (seen.has(msg.uid)) continue;
            seen.add(msg.uid);
            try {
                const parsed = await simpleParser(msg.source);
                messages.push({
                    msg_id: String(msg.uid),
                    from: parsed.from?.text || "",
                    subject: parsed.subject || "",
                    date: parsed.date?.toISOString() || "",
                    raw_email: msg.source,
                });
            } catch {
                /* skip unparseable */
            }
        }
        return messages;
    }

    async markRead(msgId) {
        if (!this._client) return;
        try {
            // msgId is stored as string from fetchUnread — convert to number for UID-based ops
            const uid = Number(msgId);
            if (Number.isNaN(uid)) return;
            await this._client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
        } catch {
            /* ignore */
        }
    }

    async idleLoop(callback) {
        this._running = true;
        logger.info({
            event: "imap_idle_starting",
            host: this._host,
            port: this._port,
            mailbox: this._mailbox,
        });
        while (this._running) {
            try {
                if (!this._client) {
                    logger.info({
                        event: "imap_connecting",
                        host: this._host,
                        port: this._port,
                        mailbox: this._mailbox,
                    });
                    await this.connect();
                    logger.info({ event: "imap_connected" });
                }
                const unread = await this.fetchUnread();
                if (unread.length > 0) {
                    logger.info({
                        event: "imap_unread_found",
                        count: unread.length,
                    });
                }
                for (const msg of unread) {
                    if (
                        this._dedup &&
                        (this._dedup.isRecentlyProcessed(msg.msg_id) ||
                            this._dedup.isMessageBooked(msg.msg_id))
                    ) {
                        logger.info({
                            event: "imap_recently_skipped",
                            uid: msg.msg_id,
                            subject: msg.subject,
                        });
                        continue;
                    }
                    try {
                        logger.info({
                            event: "imap_processing",
                            subject: msg.subject,
                            from: msg.from,
                        });
                        const result = await callback(msg);
                        if (this._dedup) {
                            // An LLM outage leaves the email unread and retries it
                            // soon instead of waiting out the full cooldown (#694).
                            if (result?.action === "llm_unavailable") {
                                this._dedup.recordProcessed(
                                    msg.msg_id,
                                    LLM_RETRY_MINUTES,
                                );
                            } else {
                                this._dedup.recordProcessed(msg.msg_id);
                            }
                            // A message that reached a verdict must book nothing
                            // on a later pass, even after the retry cooldown
                            // expires (issue #557). An uncertain outcome stays
                            // retryable, which is what the cooldown is for.
                            if (
                                result &&
                                ["inserted", "duplicate", "skipped"].includes(
                                    result.action,
                                )
                            )
                                this._dedup.markMessageBooked(msg.msg_id);
                        }
                    } catch (e) {
                        logger.error({
                            event: "imap_callback_error",
                            error: e.message,
                        });
                    }
                }
                // Wait for new mail. Per imapflow's official API docs
                // (https://imapflow.com/docs/api/imapflow-client):
                // - idle() does NOT accept arguments (timeoutMs was silently ignored)
                // - maxIdleTime is designed to *restart* IDLE, not return from it
                // - The proper pattern is to listen for the 'exists' event and
                //   break IDLE by calling another command (e.g. noop()).
                //
                // We start IDLE for real-time push, and use a keepalive noop()
                // to break out periodically (every IDLE_TIMEOUT seconds) so the
                // loop can call fetchUnread() and detect any missed messages.
                await new Promise((resolve, reject) => {
                    let settled = false;
                    const onExists = () => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        // Break IDLE so idle() resolves and the loop continues
                        this._client?.noop()?.catch(() => {});
                        resolve();
                    };
                    const keepalive = setTimeout(() => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        logger.debug({
                            event: "imap_keepalive",
                            msg: "Keepalive NOOP to break IDLE",
                        });
                        // Break IDLE with a NOOP so the loop can poll for changes
                        this._client?.noop()?.catch(() => {});
                        resolve();
                    }, this.IDLE_TIMEOUT * 1000);

                    const cleanup = () => {
                        clearTimeout(keepalive);
                        if (this._client) {
                            this._client.removeListener?.("exists", onExists);
                            this._client.removeListener?.("expunge", onExists);
                        }
                    };

                    if (!this._client) {
                        cleanup();
                        resolve();
                        return;
                    }
                    // Register event listeners for real-time push (mocks may lack EventEmitter)
                    this._client.on?.("exists", onExists);
                    this._client.on?.("expunge", onExists);
                    // Start IDLE for server push notifications.
                    // In production: idle() resolves when noop() breaks it.
                    // In tests with mocks: idle() may resolve immediately.
                    this._client.idle().then(
                        () => {
                            if (settled) return;
                            settled = true;
                            cleanup();
                            resolve();
                        },
                        (e) => {
                            if (settled) return;
                            settled = true;
                            cleanup();
                            reject(e);
                        },
                    );
                });
            } catch (e) {
                logger.warn({
                    event: "imap_error",
                    error: e.message,
                    retry_in_s: this.RECONNECT_DELAY,
                });
                await new Promise((r) =>
                    setTimeout(r, this.RECONNECT_DELAY * 1000),
                );
                try {
                    await this.disconnect();
                } catch {}
                this._client = null;
            }
        }
        logger.info({ event: "imap_idle_stopped" });
    }

    /**
     * One-shot IMAP connection for on-demand inbox queries.
     * Creates a temporary connection, fetches data, and disconnects.
     * Does NOT mark messages as read. Does NOT interfere with IDLE loop.
     */
    async _connectOnce() {
        const client = new ImapFlow({
            host: this._host,
            port: this._port,
            secure: true,
            auth: { user: this._username, pass: this._password },
            logger: false,
            disableAutoIdle: true,
        });
        await client.connect();
        return client;
    }

    /**
     * List recent inbox emails without marking them read.
     * @param {{limit?: number}} opts
     * @returns {Promise<Array<{uid:number, from:string, fromName:string, subject:string, date:string}>>}
     */
    async listInbox({ limit = 50 } = {}) {
        let client = null;
        try {
            client = await this._connectOnce();
            await client.mailboxOpen(this._mailbox);
            const results = [];
            const count = Math.min(limit, 500);
            // Fetch in reverse to get newest first. mailbox.exists is the total
            // message count; compute start UID so we get the last `count` messages.
            const total = client.mailbox.exists || 0;
            const start = total > count ? total - count + 1 : 1;
            for await (const msg of client.fetch(
                { uid: String(start) + ":*" },
                { envelope: true, source: false },
            )) {
                results.push({
                    uid: msg.uid,
                    from: msg.envelope?.from?.[0]?.address || "",
                    fromName: msg.envelope?.from?.[0]?.name || "",
                    subject: msg.envelope?.subject || "",
                    date: msg.envelope?.date?.toISOString() || "",
                });
            }
            // Reverse so newest (highest UID) comes first
            results.reverse();
            // Trim to limit if still over (safety)
            return results.slice(0, count);
        } finally {
            if (client) {
                try {
                    await client.logout();
                } catch {}
            }
        }
    }

    /**
     * Read a single email by UID without marking it read.
     * @param {number} uid
     * @returns {Promise<{uid:number, from:string, fromName:string, subject:string, date:string, text:string, html:string}|null>}
     */
    async readInboxEmail(uid) {
        let client = null;
        try {
            client = await this._connectOnce();
            await client.mailboxOpen(this._mailbox);
            for await (const msg of client.fetch(
                { uid: String(uid) },
                { source: true, envelope: true },
            )) {
                const parsed = msg.source
                    ? await simpleParser(
                          Buffer.isBuffer(msg.source)
                              ? msg.source
                              : Buffer.from(msg.source),
                      )
                    : null;
                const fromAddr = msg.envelope?.from?.[0]?.address || "";
                const fromDisplay = parsed?.from?.text || fromAddr;
                return {
                    uid: msg.uid,
                    from: fromAddr,
                    fromName: msg.envelope?.from?.[0]?.name || "",
                    fromDisplay: fromDisplay,
                    subject: parsed?.subject || "",
                    date: parsed?.date?.toISOString() || "",
                    text: parsed?.text || "",
                    html: parsed?.html || "",
                    attachments: (parsed?.attachments || []).map((att) => ({
                        filename: att.filename || "",
                        contentType: att.contentType || "",
                        size: att.size || 0,
                    })),
                };
            }
            return null;
        } finally {
            if (client) {
                try {
                    await client.logout();
                } catch {}
            }
        }
    }

    /**
     * Fetch email by UID, extract first PDF attachment, decrypt (if password
     * provided), and return the text. All server-side to avoid large base64
     * payloads over MCP.
     * @param {number} uid
     * @param {string} [password]
     * @returns {Promise<{text:string, filename:string}|{error:string}>}
     */
    async extractInboxPdf(uid, password = "") {
        let client = null;
        try {
            client = await this._connectOnce();
            await client.mailboxOpen(this._mailbox);
            for await (const msg of client.fetch(
                { uid: String(uid) },
                { source: true },
            )) {
                const parsed = await simpleParser(
                    Buffer.isBuffer(msg.source)
                        ? msg.source
                        : Buffer.from(msg.source),
                );
                const attachments = parsed?.attachments || [];
                const pdf = attachments.find(
                    (a) => a.contentType === "application/pdf" ||
                           (a.filename || "").toLowerCase().endsWith(".pdf"),
                );
                if (!pdf || !pdf.content) {
                    return { error: "No PDF attachment found in this email" };
                }
                const text = await extractPdfFromBuffer(
                    pdf.content,
                    password || null,
                );
                return {
                    filename: pdf.filename || "attachment.pdf",
                    text,
                };
            }
            return { error: "Email with UID " + uid + " not found" };
        } finally {
            if (client) {
                try {
                    await client.logout();
                } catch {}
            }
        }
    }
}
