/**
 * Pending "Remember this mapping?" offers (issue #720).
 *
 * A Jev classification is a model guess, so the pipeline never writes it to
 * memory. It stores an offer here instead; only an explicit confirm call turns
 * an offer into a fact. Offers are small JSON on the data volume so they
 * survive a restart between the notification and the user's answer. The file
 * lives on a volume only the tracker mounts (#723): the model's container must
 * not be able to write an offer, or it could mint one for the buttons to confirm.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import { randomInt } from "crypto";

const DAY_MS = 24 * 60 * 60 * 1000;
/** No 0, 1, I, L, O: the id is typed back by a person. */
const ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * The text of a learnable descriptor, or null. Deliberately narrow: the value is
 * written into a `<descriptor> maps to <payee> payee` fact that three regex
 * readers parse, and it is shown to the user and relayed through the model, so
 * it must be a short label, never a sentence, an id, or memory grammar.
 */
export function descriptorOf(value) {
    const text = String(value ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 &'./*#-]{2,39}$/.test(text)) return null;
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    const digits = (text.match(/\d/g) || []).length;
    const significant = text.replace(/\s/g, "").length;
    if (letters < 3 || digits > significant / 2) return null;
    if (/\b(?:maps to|payee|category|belongs to|alert recipient|is an?)\b/i.test(text)) return null;
    return text;
}

export class PendingLearning {
    constructor(path, { ttlMs = 7 * DAY_MS, cap = 50, now = Date.now } = {}) {
        this._path = path;
        this._ttlMs = ttlMs;
        this._cap = cap;
        this._now = now;
    }

    _read() {
        try {
            const parsed = JSON.parse(readFileSync(this._path, "utf8"));
            return Array.isArray(parsed?.offers) ? parsed.offers : [];
        } catch {
            return [];
        }
    }

    _write(offers) {
        mkdirSync(dirname(this._path), { recursive: true });
        const tmp = `${this._path}.tmp`;
        writeFileSync(tmp, JSON.stringify({ offers }), { mode: 0o600 });
        renameSync(tmp, this._path);
    }

    _live() {
        const now = this._now();
        return this._read().filter((offer) => offer.expiresAt > now);
    }

    offer({ descriptor, payee, runnerUp = null, budgetId = "" }) {
        const offers = this._live();
        const existing = offers.find(
            (offer) =>
                offer.descriptor === descriptor &&
                offer.payee === payee &&
                offer.budgetId === budgetId,
        );
        if (existing) return existing.id;
        let id = "";
        for (let i = 0; i < 8; i += 1) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
        offers.push({
            id,
            descriptor,
            payee,
            runnerUp,
            budgetId,
            expiresAt: this._now() + this._ttlMs,
        });
        this._write(offers.slice(-this._cap));
        return id;
    }

    list() {
        return this._live();
    }

    get(id) {
        const wanted = String(id ?? "").trim().toUpperCase();
        return this._live().find((offer) => offer.id === wanted) || null;
    }

    discard(id) {
        const wanted = String(id ?? "").trim().toUpperCase();
        const offers = this._live();
        const kept = offers.filter((offer) => offer.id !== wanted);
        if (kept.length === offers.length) return false;
        this._write(kept);
        return true;
    }
}

/**
 * One-time move of the offer file from the shared data volume (#723). Copy then
 * delete, because the two paths are on different mounts. Never overwrites.
 * With `discard` (the learning bot is on) the old file is only deleted: content
 * from a volume other containers can reach must not become a live offer.
 */
export function migratePendingLearning(oldPath, newPath, { discard = false } = {}) {
    if (discard) {
        if (existsSync(oldPath)) unlinkSync(oldPath);
        return false;
    }
    if (!existsSync(oldPath) || existsSync(newPath)) return false;
    mkdirSync(dirname(newPath), { recursive: true });
    copyFileSync(oldPath, newPath);
    unlinkSync(oldPath);
    return true;
}
