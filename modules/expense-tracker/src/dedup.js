/**
 * Dedup Journal — SHA-256 based duplicate detection using SQLite.
 * Ported 1:1 from src/utils/dedup.py
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { dirname } from "path";

/**
 * Two alerts for one transfer arrive seconds apart, so a reservation is matched
 * against a narrow window. It must stay narrow: a genuine second transfer of the
 * same amount is ordinary (issue #556, four minutes apart), and the journal has
 * no bank reference to tell two events apart. Reprocessing a single email is
 * guarded separately, by message identity.
 */
// Two alerts for one transfer arrive seconds apart, and a genuine repeat is
// minutes apart, so the window sits between the two. Measured on 2026-09-13:
// sibling alerts for one event 1 s, 1 s, and 4 s apart; two distinct real
// transfers 237 s apart. The residual risk is a second email for one event
// arriving later than this with an amount, which would book twice the way it
// did before; UOB's status email did arrive 3 min 29 s after its notification,
// and is refused only because it carries no amount (issue #557).
const TRANSFER_MATCH_WINDOW_MS = 2 * 60 * 1000;

/**
 * How long a processed-but-unresolved email is skipped before it is retried.
 * Held alerts stay unread so they surface again, and this cooldown is the only
 * thing limiting how often the hold reminder repeats (issue #592): 12 hours, so
 * a held transfer reminds at most twice a day instead of hourly.
 */
const RETRY_COOLDOWN_MINUTES = 12 * 60;

/** Exposed for tests: the retry cooldown a held/processed email waits through. */
export { RETRY_COOLDOWN_MINUTES };

export class DedupJournal {
    /** @param {string} dbPath - Path to dedup.db */
    constructor(dbPath = "data/dedup.db") {
        mkdirSync(dirname(dbPath), { recursive: true });
        this._db = new Database(dbPath);
        // Test-only fast mode. better-sqlite3 fsyncs on every commit, and on
        // this container's overlay filesystem a single fsync costs ~300ms, so
        // opening a fresh file-backed journal costs ~0.9s (vs 3ms in-memory).
        // Tests open a throwaway DB per test case and never assert
        // crash-durability, so the fsync buys them nothing. Production must
        // never set this flag: the dedup journal is the durable store that
        // stops a crash from re-booking an already-booked transaction, and
        // synchronous=OFF would let a crash lose the reservation.
        if (process.env.EXPENSE_DEDUP_TEST_FAST === "1") {
            this._db.pragma("synchronous = OFF");
        }
        // Schema setup is 11 separate statements, and better-sqlite3 runs each
        // `exec` in its own implicit transaction, so every one of them is a
        // separate durable commit (fsync) against the journal. Measured on this
        // host: opening a fresh journal took 0.8-2.8s, which is what made the
        // DB-backed cases in orchestrator.test.js exceed the 5s default
        // testTimeout under parallel load. One explicit transaction collapses
        // them into a single fsync (measured 3.9s -> 1.3s here). This is a
        // production win too, not just a test fix: both production call sites
        // (src/index.js, src/tools.js) construct once at startup and were
        // paying ~11 fsyncs to create the schema.
        this._db.exec("BEGIN");
        this._db.exec(`
      CREATE TABLE IF NOT EXISTS dedup (
        hash TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        payee_name TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
        this._stmtCheck = this._db.prepare(
            "SELECT 1 FROM dedup WHERE hash = ?",
        );
        this._stmtInsert = this._db.prepare(
            "INSERT OR IGNORE INTO dedup (hash, date, amount_cents, account_id, payee_name) VALUES (?, ?, ?, ?, ?)",
        );
        this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_dedup_lookup ON dedup(date, amount_cents, account_id)
    `);
        this._db.exec(`
      CREATE TABLE IF NOT EXISTS processed_uids (
        uid TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      )
    `);
        // Message identity that outlives the retry cooldown: once an email has
        // produced a booking, reprocessing it must book nothing (issue #557).
        // processed_uids keeps its short life so genuine failures still retry.
        // Last UIDVALIDITY read from the mailbox: it decides when the uid-keyed
        // tables above stop meaning anything (issue #558).
        this._db.exec(`
      CREATE TABLE IF NOT EXISTS mailbox_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
        this._db.exec(`
      CREATE TABLE IF NOT EXISTS booked_messages (
        uid TEXT PRIMARY KEY,
        booked_at TEXT NOT NULL
      )
    `);
        this._db.exec(`
      CREATE TABLE IF NOT EXISTS transfer_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        budget_id TEXT NOT NULL,
        source_account_id TEXT NOT NULL,
        destination_account_id TEXT NOT NULL,
        currency TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'inserted', 'failed')),
        actual_transaction_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
        // Added after the table first shipped: CREATE TABLE IF NOT EXISTS leaves
        // an existing journal without it (issue #578).
        if (
            !this._db
                .prepare("PRAGMA table_info(transfer_journal)")
                .all()
                .some((c) => c.name === "counterpart_alert_id")
        ) {
            this._db.exec(
                "ALTER TABLE transfer_journal ADD COLUMN counterpart_alert_id TEXT",
            );
        }
        this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_transfer_match
      ON transfer_journal (
        budget_id, source_account_id, destination_account_id,
        currency, amount_cents, occurred_at
      )
    `);
        this._stmtCheckRecent = this._db.prepare(
            "SELECT 1 FROM processed_uids WHERE uid = ? AND processed_at > ?",
        );
        this._stmtInsertUid = this._db.prepare(
            "INSERT OR REPLACE INTO processed_uids (uid, processed_at) VALUES (?, ?)",
        );
        this._db.exec("COMMIT");
    }

    _makeHash(date, amountCents, accountId, payeeName) {
        const key = `${date}|${amountCents}|${accountId}|${payeeName}`;
        return createHash("sha256").update(key).digest("hex");
    }

    checkDuplicate(date, amountCents, accountId, payeeName) {
        const hash = this._makeHash(date, amountCents, accountId, payeeName);
        return !!this._stmtCheck.get(hash);
    }

    /** Check by date±1d + amount + account match (ignoring payee).
     *  Tolerates ±1 day to handle bank posting lag. */
    checkExact(date, amountCents, accountId) {
        const d = new Date(date + "T00:00:00Z");
        const before = new Date(d);
        before.setUTCDate(before.getUTCDate() - 1);
        const after = new Date(d);
        after.setUTCDate(after.getUTCDate() + 1);
        const since = before.toISOString().slice(0, 10);
        const until = after.toISOString().slice(0, 10);

        const row = this._db
            .prepare(
                "SELECT 1 FROM dedup WHERE date >= ? AND date <= ? AND amount_cents = ? AND account_id = ? LIMIT 1",
            )
            .get(since, until, amountCents, accountId);
        return !!row;
    }

    record(date, amountCents, accountId, payeeName) {
        const hash = this._makeHash(date, amountCents, accountId, payeeName);
        this._stmtInsert.run(hash, date, amountCents, accountId, payeeName);
    }

    reserveTransfer({
        budget_id,
        source_account_id,
        destination_account_id,
        currency,
        amount_cents,
        occurred_at,
    }) {
        const occurredAt = new Date(occurred_at).toISOString();
        const start = new Date(
            new Date(occurredAt).getTime() - TRANSFER_MATCH_WINDOW_MS,
        ).toISOString();
        const end = new Date(
            new Date(occurredAt).getTime() + TRANSFER_MATCH_WINDOW_MS,
        ).toISOString();
        const reserve = this._db.transaction(() => {
            const rows = this._db.prepare(`
              SELECT * FROM transfer_journal
              WHERE budget_id = ? AND source_account_id = ? AND destination_account_id = ?
                AND currency = ? AND amount_cents = ?
                AND occurred_at >= ? AND occurred_at <= ?
                AND status IN ('pending', 'inserted')
              ORDER BY occurred_at
            `).all(
                budget_id,
                source_account_id,
                destination_account_id,
                currency,
                Math.abs(amount_cents),
                start,
                end,
            );
            if (rows.length === 1) {
                return { status: rows[0].status, entry: rows[0] };
            }
            if (rows.length > 1) return { status: "ambiguous", entry: null };
            const result = this._db.prepare(`
              INSERT INTO transfer_journal (
                budget_id, source_account_id, destination_account_id,
                currency, amount_cents, occurred_at, status
              ) VALUES (?, ?, ?, ?, ?, ?, 'pending')
            `).run(
                budget_id,
                source_account_id,
                destination_account_id,
                currency,
                Math.abs(amount_cents),
                occurredAt,
            );
            const entry = this._db.prepare(
                "SELECT * FROM transfer_journal WHERE id = ?",
            ).get(Number(result.lastInsertRowid));
            return { status: "reserved", entry };
        });
        return reserve();
    }

    /**
     * An already-booked transfer leg INTO this account, or null.
     *
     * A credit alert names the account the money lands on, which is the
     * transfer's destination. The source side is deliberately not consulted: an
     * unrelated outgoing leg of the same amount inside the window would
     * otherwise swallow a real incoming credit. Only `inserted` legs qualify —
     * a `pending` row is this pipeline's own reservation, not proof of a
     * booking. `at` is the alert's event time; the default window is the same
     * one the journal uses to tell a sibling alert from a real repeat transfer.
     *
     * A leg is the counterpart of ONE credit alert: the first `alert_id` to
     * match claims it, and a later alert with a different id gets null. The
     * claiming alert asking again (an email reprocessed after a crash) still
     * gets the leg. Without an `alert_id` the match is read-only, as before.
     * A mailbox epoch change clears claims, since uids are reused.
     *
     * ponytail: amount+account+window is all the journal can correlate on —
     * bank alerts share no reference number, so a genuinely separate transfer
     * of the same amount into the same account inside the window is
     * indistinguishable and reads as the booked one. If that separate credit
     * arrives BEFORE the genuine counterpart it claims the leg, and the genuine
     * counterpart is then held and notified: a false hold, the safe direction,
     * instead of a silent loss. Same window, same accepted trade-off the debit
     * side already makes in `reserveTransfer` (issue #556, real repeats 237 s
     * apart). Upgrade path: a bank-reference column on `transfer_journal`.
     * Tracked in issue #578.
     */
    findInsertedTransferInto({
        budget_id,
        destination_account_id,
        amount_cents,
        currency,
        at,
        alert_id,
        windowMs = TRANSFER_MATCH_WINDOW_MS,
    }) {
        const ts = at ? new Date(at).getTime() : NaN;
        if (
            !budget_id ||
            !destination_account_id ||
            !currency ||
            amount_cents == null ||
            amount_cents === "" ||
            !Number.isFinite(ts)
        ) {
            return null;
        }
        const iso = (ms) => new Date(ms).toISOString();
        const claimant = alert_id == null ? "" : String(alert_id);
        const params = [
            budget_id,
            destination_account_id,
            currency,
            Math.abs(amount_cents),
            iso(ts - windowMs),
            iso(ts + windowMs),
        ];
        const select = (extra) =>
            `SELECT * FROM transfer_journal
              WHERE budget_id = ? AND destination_account_id = ?
                AND currency = ? AND amount_cents = ?
                AND status = 'inserted'
                AND occurred_at >= ? AND occurred_at <= ?
                ${extra}
              ORDER BY occurred_at
              LIMIT 1`;
        if (!claimant) {
            return this._db.prepare(select("")).get(...params) || null;
        }
        return this._db.transaction(() => {
            const leg = this._db
                .prepare(
                    select("AND (counterpart_alert_id IS NULL OR counterpart_alert_id = ?)"),
                )
                .get(...params, claimant);
            if (!leg) return null;
            if (leg.counterpart_alert_id == null) {
                this._db
                    .prepare(
                        "UPDATE transfer_journal SET counterpart_alert_id = ? WHERE id = ? AND counterpart_alert_id IS NULL",
                    )
                    .run(claimant, leg.id);
                leg.counterpart_alert_id = claimant;
            }
            return leg;
        })();
    }

    getTransfer(id) {
        return this._db.prepare("SELECT * FROM transfer_journal WHERE id = ?").get(id) || null;
    }

    markTransferInserted(id, actualTransactionId = null) {
        this._db.prepare(`
          UPDATE transfer_journal
          SET status = 'inserted', actual_transaction_id = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(actualTransactionId, id);
    }

    markTransferFailed(id) {
        this._db.prepare(`
          UPDATE transfer_journal
          SET status = 'failed', updated_at = datetime('now')
          WHERE id = ?
        `).run(id);
    }

    close() {
        this._db.close();
    }

    /**
     * True when this UID was processed within the retry cooldown. The window is
     * 12 hours, not the old 60 minutes: a held alert stays unread on purpose and
     * is re-scanned every IDLE pass, so the cooldown is what throttles the
     * repeated hold reminders. One hour nagged about the same held transfer many
     * times a day (issue #592); twelve hours reminds at most twice a day while
     * still retrying genuine parse failures long before they go stale.
     */
    isRecentlyProcessed(uid, cooldownMinutes = RETRY_COOLDOWN_MINUTES) {
        const cutoff = new Date(
            Date.now() - cooldownMinutes * 60 * 1000,
        ).toISOString();
        return !!this._stmtCheckRecent.get(uid, cutoff);
    }

    /**
     * @param {string} uid
     * @param {number} [retryAfterMinutes] - back-date the row so the normal
     *   cooldown ends after this many minutes instead of the full window; used
     *   when the email could not be processed for a transient reason (#694).
     */
    recordProcessed(uid, retryAfterMinutes) {
        const shorten =
            retryAfterMinutes === undefined
                ? 0
                : Math.max(0, RETRY_COOLDOWN_MINUTES - retryAfterMinutes);
        this._stmtInsertUid.run(
            uid,
            new Date(Date.now() - shorten * 60 * 1000).toISOString(),
        );
    }

    /** True once this message has produced a booking; deleted by cleanup()
     *  once older than 180 days, and dropped when the mailbox epoch changes
     *  (#558). Part of the interface imap.js requires. */
    isMessageBooked(uid) {
        return !!this._db
            .prepare("SELECT 1 FROM booked_messages WHERE uid = ?")
            .get(uid);
    }

    markMessageBooked(uid) {
        this._db
            .prepare(
                "INSERT OR REPLACE INTO booked_messages (uid, booked_at) VALUES (?, ?)",
            )
            .run(uid, new Date().toISOString());
    }

    /**
     * Record the mailbox's UIDVALIDITY and drop the UID-keyed state when it
     * changes. A UID identifies a message only inside one epoch, so after a
     * change every stored uid can point at a different message and keeping them
     * would silently skip genuinely new mail (issue #558). The dedup table is
     * untouched: it is keyed on the message content, not on a uid.
     * Returns true when state was cleared.
     */
    noteMailboxUidValidity(uidValidity) {
        if (uidValidity === undefined || uidValidity === null) return false;
        const key = String(uidValidity);
        const row = this._db
            .prepare("SELECT value FROM mailbox_state WHERE key = ?")
            .get("uidvalidity");
        if (row && row.value === key) return false;
        // On first sight there is no recorded epoch, so a stored uid is
        // unproven: it may have been written under a different one. Dropping it
        // can re-book an email that is still unread, but keeping it can skip a
        // genuinely new one in silence, which is the worse failure (issue #558).
        const stored =
            this._db.prepare("SELECT 1 FROM booked_messages LIMIT 1").get() ||
            this._db.prepare("SELECT 1 FROM processed_uids LIMIT 1").get();
        // One transaction: a crash between the epoch write and the deletes would
        // otherwise leave the epoch recorded and the stale uids live forever.
        return this._db.transaction(() => {
            this._db
                .prepare(
                    "INSERT OR REPLACE INTO mailbox_state (key, value) VALUES (?, ?)",
                )
                .run("uidvalidity", key);
            if (row || stored) {
                this._db.prepare("DELETE FROM booked_messages").run();
                this._db.prepare("DELETE FROM processed_uids").run();
                // Claims are keyed by uid too (issue #578).
                this._db
                    .prepare("UPDATE transfer_journal SET counterpart_alert_id = NULL")
                    .run();
                return true;
            }
            return false;
        })();
    }

    /** Delete processed_uids entries older than the retry cooldown.
     *  Retention must be at least RETRY_COOLDOWN_MINUTES: the periodic
     *  `cleanup()` runs faster than the cooldown, so a shorter retention
     *  would purge a held email's row while the message is still unread and
     *  eligible for reprocessing — re-alerting the user long before the
     *  cooldown elapsed (issue #592). */
    cleanupProcessedUids() {
        const cutoff = new Date(
            Date.now() - RETRY_COOLDOWN_MINUTES * 60 * 1000,
        ).toISOString();
        this._db
            .prepare("DELETE FROM processed_uids WHERE processed_at < ?")
            .run(cutoff);
    }

    /** Delete dedup entries older than `retentionDays` (default 90).
     *  Returns the number of deleted rows. */
    cleanupOldEntries(retentionDays = 90) {
        const cutoff = new Date(
            Date.now() - retentionDays * 24 * 60 * 60 * 1000,
        ).toISOString();
        const result = this._db
            .prepare("DELETE FROM dedup WHERE created_at < ?")
            .run(cutoff);
        return result.changes;
    }

    /** Run full cleanup: processed_uids (retry cooldown) + old dedup entries (90d)
     *  + booked messages (180d). */
    cleanup() {
        this.cleanupProcessedUids();
        this.cleanupOldEntries();
        // Message identity must outlive the retry cooldown and any
        // realistic reprocessing, not forever.
        this._db
            .prepare("DELETE FROM booked_messages WHERE booked_at < ?")
            .run(
                new Date(
                    Date.now() - 180 * 24 * 60 * 60 * 1000,
                ).toISOString(),
            );
    }
}
