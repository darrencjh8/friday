/**
 * IMAP IDLE handler for monitoring a specific IMAP folder.
 * Adapted from expense-tracker's imap.js — uses configurable folder
 * instead of hardcoded "INBOX", and adds simpleParser for email metadata.
 *
 * Uses imapflow for async IMAP with IDLE support.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export class ImapIdleHandler {
    IDLE_TIMEOUT = 300;
    RECONNECT_DELAY = 5;

    /**
     * @param {string} host
     * @param {number} port
     * @param {string} username
     * @param {string} password
     * @param {string} [folder="INBOX"]
     */
    constructor(host, port, username, password, folder = "INBOX") {
        this._host = host;
        this._port = port;
        this._username = username;
        this._password = password;
        this._folder = folder;
        this._client = null;
        this._running = false;
    }

    async connect() {
        this._client = new ImapFlow({
            host: this._host,
            port: this._port,
            secure: true,
            auth: { user: this._username, pass: this._password },
            logger: false,
        });
        await this._client.connect();
        await this._client.mailboxOpen(this._folder);
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
        const messages = [];
        const seen = new Set();
        for await (const msg of this._client.fetch(
            { unseen: true },
            { source: true, envelope: true },
        )) {
            if (seen.has(msg.seq)) continue;
            seen.add(msg.seq);
            try {
                const parsed = await simpleParser(msg.source);
                messages.push({
                    msg_id: String(msg.seq),
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
            await this._client.messageFlagsAdd({ seq: msgId }, ["\\Seen"]);
        } catch {
            /* ignore */
        }
    }

    async idleLoop(callback) {
        this._running = true;
        console.log(
            JSON.stringify({
                event: "imap_idle_starting",
                host: this._host,
                port: this._port,
                folder: this._folder,
            }),
        );
        while (this._running) {
            try {
                if (!this._client) {
                    console.log(
                        JSON.stringify({
                            event: "imap_connecting",
                            host: this._host,
                            port: this._port,
                            folder: this._folder,
                        }),
                    );
                    await this.connect();
                    console.log(JSON.stringify({ event: "imap_connected" }));
                }
                const unread = await this.fetchUnread();
                if (unread.length > 0) {
                    console.log(
                        JSON.stringify({
                            event: "imap_unread_found",
                            count: unread.length,
                            folder: this._folder,
                        }),
                    );
                }
                for (const msg of unread) {
                    try {
                        console.log(
                            JSON.stringify({
                                event: "imap_processing",
                                subject: msg.subject,
                                from: msg.from,
                            }),
                        );
                        await callback(msg);
                    } catch (e) {
                        console.error(
                            JSON.stringify({
                                event: "imap_callback_error",
                                error: e.message,
                            }),
                        );
                    }
                }
                // Wait for new mail via IDLE
                await this._client.idle();
            } catch (e) {
                console.warn(
                    JSON.stringify({
                        event: "imap_error",
                        error: e.message,
                        retry_in_s: this.RECONNECT_DELAY,
                    }),
                );
                await new Promise((r) =>
                    setTimeout(r, this.RECONNECT_DELAY * 1000),
                );
                try {
                    await this.disconnect();
                } catch {}
                this._client = null;
            }
        }
        console.log(JSON.stringify({ event: "imap_idle_stopped" }));
    }
}
