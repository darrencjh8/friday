/**
 * JSON-based persistent mapping store for learned associations.
 * Ported 1:1 from src/utils/memory.py
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

export class MemoryStore {
  constructor(mappingsPath = 'data/mappings.json') {
    this._path = mappingsPath;
    this._data = {
      securities: {},
      accounts: {},
      categories: {},
      brokers: {},
    };
    this._load();
  }

  _load() {
    if (!existsSync(this._path)) return;
    try {
      const loaded = JSON.parse(readFileSync(this._path, 'utf8'));
      for (const key of Object.keys(this._data)) {
        if (loaded[key]) {
          this._data[key] = loaded[key];
        }
      }
    } catch {
      // Ignore parse errors, keep defaults
    }
  }

  _save() {
    mkdirSync(dirname(this._path), { recursive: true });
    writeFileSync(this._path, JSON.stringify(this._data, null, 2), 'utf8');
  }

  /**
   * Persistently learn an association.
   */
  learn(mappingType, key, value) {
    const keyLower = key.trim().toLowerCase();
    if (this._data[mappingType]) {
      this._data[mappingType][keyLower] = value.trim();
      this._save();
    }
  }

  /**
   * Recall a learned association.
   * @returns {string|null}
   */
  recall(mappingType, key) {
    const keyLower = key.trim().toLowerCase();
    return this._data[mappingType]?.[keyLower] ?? null;
  }

  /**
   * Recall all mappings of a type.
   * @returns {object}
   */
  recallAll(mappingType) {
    const entries = Object.entries(this._data[mappingType] || {});
    entries.sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  }

  /**
   * Forget a learned association.
   */
  forget(mappingType, key) {
    const keyLower = key.trim().toLowerCase();
    if (this._data[mappingType] && keyLower in this._data[mappingType]) {
      delete this._data[mappingType][keyLower];
      this._save();
    }
  }
}
