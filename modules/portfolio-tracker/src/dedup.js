/**
 * SQLite-based dedup journal for transaction duplicate detection.
 * Ported 1:1 from src/utils/dedup.py
 */

import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Compute a deterministic hash for a transaction.
 */
export function computeHash(date, amountCents, accountId, securityId = '', txnType = '') {
  const payload = `${date}|${amountCents}|${accountId}|${securityId || ''}|${txnType}`;
  return createHash('sha256').update(payload).digest('hex');
}

export class DedupJournal {
  constructor(dbPath) {
    this._dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._createTable();
  }

  _createTable() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS dedup_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT UNIQUE NOT NULL,
        correlation_id TEXT NOT NULL,
        date TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        security_id TEXT DEFAULT '',
        type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  /**
   * Check if a transaction already exists.
   * @returns {boolean}
   */
  check(date, amountCents, accountId, securityId = '', txnType = '') {
    const hash = computeHash(date, amountCents, accountId, securityId, txnType);
    const row = this._db.prepare('SELECT 1 FROM dedup_journal WHERE hash = ?').get(hash);
    return row !== undefined;
  }

  /**
   * Record a transaction in the dedup journal.
   */
  record(date, amountCents, accountId, correlationId, securityId = '', txnType = '') {
    const hash = computeHash(date, amountCents, accountId, securityId, txnType);
    this._db.prepare(`
      INSERT OR IGNORE INTO dedup_journal
        (hash, correlation_id, date, amount_cents, account_id, security_id, type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(hash, correlationId, date, amountCents, accountId, securityId || '', txnType);
  }

  /**
   * Bulk-seed multiple records in a single transaction.
   * @param {Array<[string, number, string, string, string, string]>} records
   * @returns {number} Count of new inserts
   */
  bulkSeed(records) {
    let count = 0;
    const insert = this._db.prepare(`
      INSERT OR IGNORE INTO dedup_journal
        (hash, correlation_id, date, amount_cents, account_id, security_id, type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const transaction = this._db.transaction((recs) => {
      for (const [date, amountCents, accountId, correlationId, securityId, txnType] of recs) {
        const hash = computeHash(date, amountCents, accountId, securityId, txnType);
        const result = insert.run(hash, correlationId, date, amountCents, accountId, securityId || '', txnType);
        if (result.changes > 0) count++;
      }
    });
    transaction(records);
    return count;
  }
}
