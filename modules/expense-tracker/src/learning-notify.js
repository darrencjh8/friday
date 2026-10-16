/**
 * "Remember this mapping?" offers over Hermes's own Telegram bot (issue #723).
 *
 * The model relays notifications and reads email, so it must never hold the
 * call that turns an offer into a fact. This module only SENDS the offer
 * (sendMessage; Hermes owns getUpdates, and Telegram allows one poller per
 * token). The user taps /remember_<id> or /forget_<id>; a Hermes plugin that
 * runs before the model sees the message calls POST /learning/answer with an
 * HMAC the model cannot compute. Failures are logged, never thrown.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { logger } from "./logging.js";

const ID_RE = /^[A-Z0-9]{1,16}$/;
const ACTIONS = ["remember", "forget"];

/** Derived, so the bot token itself never signs and no new secret exists. */
function commandKey(token) {
    return createHmac("sha256", token).update("learning-command").digest("hex");
}

/** Hex HMAC-SHA256 over `${action}:${ID}` (id upper-cased), keyed by commandKey. */
export function signAnswer(action, id, token) {
    return createHmac("sha256", commandKey(token)).update(`${action}:${String(id).toUpperCase()}`).digest("hex");
}

export function verifyAnswer(signature, action, id, token) {
    if (typeof signature !== "string" || !token) return false;
    const want = Buffer.from(signAnswer(action, id, token));
    const have = Buffer.from(signature);
    return want.length === have.length && timingSafeEqual(want, have);
}

export class LearningNotifier {
    constructor({ token, chatId, fetchFn = fetch }) {
        this._token = token;
        this._chatId = String(chatId);
        this._fetch = fetchFn;
    }

    async sendOffer({ offer }) {
        const runnerUp = offer.runnerUp ? ` (runner-up: ${offer.runnerUp})` : "";
        const id = offer.id.toLowerCase();
        const response = await this._fetch(`https://api.telegram.org/bot${this._token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: this._chatId,
                text: `Remember "${offer.descriptor}" as ${offer.payee}?${runnerUp} Tap /remember_${id} or /forget_${id}. Nothing is saved until you choose.`,
            }),
        });
        const json = await response.json();
        if (!json?.ok) throw new Error("telegram sendMessage failed");
    }
}

/** Express handler for POST /learning/answer. Never throws. */
export function createAnswerHandler({ registry, token, chatId }) {
    return async (req, res) => {
        const { id: rawId, action } = req.body || {};
        const id = typeof rawId === "string" ? rawId.toUpperCase() : "";
        const signature = req.get?.("X-Learning-Signature");
        if (
            !token ||
            !chatId ||
            !ACTIONS.includes(action) ||
            !ID_RE.test(id) ||
            !verifyAnswer(signature, action, id, token)
        ) {
            logger.warn({ event: "learning_answer_rejected" });
            return res.status(403).json({ ok: false, reason: "forbidden" });
        }
        try {
            const offer = registry._pendingLearning.get(id);
            if (!offer) return res.status(404).json({ ok: false, reason: "expired" });
            const { descriptor, payee } = offer;
            if (action === "forget") {
                await registry._handle_decline_learning({ id });
                return res.json({ ok: true, result: "forgotten", descriptor, payee });
            }
            const confirmed = await registry._confirmLearning(id);
            if (!confirmed.confirmed) return res.status(500).json({ ok: false, reason: "not_saved" });
            return res.json({ ok: true, result: "remembered", descriptor, payee });
        } catch (error) {
            logger.warn({ event: "learning_answer_failed", error: error.message });
            return res.status(500).json({ ok: false, reason: "error" });
        }
    };
}
