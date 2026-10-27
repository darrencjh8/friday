/**
 * Agent Orchestrator — 3-phase pipeline.
 *
 * Phase 1: LLM ANALYSIS    reasoning=low, fetch_context tool, 1 retry
 * Phase 2: RESOLUTION       code-driven (payee: memory→resolve_merchant→Misc,
 *                           category: memory→LLM picker→null)
 * Phase 3: EXECUTE          insert / skip / notify, learn_fact × 1
 */

import OpenAI from "openai";
import { getPhase1Prompt, getCategoryPickerPrompt, getMovementExtractorPrompt } from "./prompts.js";
import { extractEmailContent } from "./extractors.js";
import { composeNotes } from "./transaction-notes.js";
import {
    identityMappingsFromFacts,
    looksLikePersonName,
    parseBankMovement,
    resolveMovementAccounts,
    accountMatches,
    cents,
    suffix,
    bankFromText,
    exactReference,
} from "./bank-movement.js";
import {
    accountAliases,
    accountTokens,
    canonicalSuffixFact,
    matchAccountByName,
    parseSuffixFact,
    resolveFactAccount as resolveFactAccountShared,
} from "./suffix-facts.js";
import { factNamesMerchant } from "./memory.js";
import { amazeDescriptor } from "./amaze.js";
import { descriptorOf } from "./learning.js";
import { offerSubject } from "./learning-notify.js";
import {
    bookableAmountCents,
    isBookableAmountCents,
} from "./amounts.js";
import { logger } from "./logging.js";
import {
    LLMUnavailableError,
    deterministicError,
    isOutageShaped,
    toResponsesInput,
    toResponsesTools,
    toResponsesToolChoice,
    fromResponses,
} from "./llm-responses.js";

/** Consecutive LLM-outage retries of one email per process before the 12h cooldown applies (#694). */
const MAX_LLM_OUTAGE_RETRIES = 12;

/** Per-request budget for the direct DeepSeek API. */
const DIRECT_TIMEOUT_MS = 60000;
/** The router's auto-thinking per-hop budget (#697). */
const ROUTER_TIMEOUT_MS = 300000;

/**
 * Run `fn(signal)` and abort the underlying request if it outlives `ms`,
 * so a timed-out call is cancelled rather than left running (#697).
 */
async function withAbortTimeout(ms, fn) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), ms);
    try {
        return await fn(controller.signal);
    } catch (error) {
        if (controller.signal.aborted) throw new Error("timeout");
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

export class LLMClient {
    constructor(config) {
        this._provider = config.llmProvider || "deepseek";
        this._model = config.llmModel || "deepseek-flash";
        this._reasoningEffort = config.llmReasoningEffort || "low";
        this._routes = [{
            provider: this._provider,
            model: this._model,
            apiKey: config.llmApiKey || config.deepseekApiKey,
            baseURL: config.llmBaseUrl || "https://api.deepseek.com/v1",
            // The router has a 300s per-hop budget: wait for it once rather
            // than re-sending a slow answer 3x (#697).
            ...(this._provider !== "deepseek"
                ? { retries: 1, timeoutMs: ROUTER_TIMEOUT_MS }
                : { retries: 3, timeoutMs: DIRECT_TIMEOUT_MS }),
        }];
        this._client = new OpenAI({
            apiKey: this._routes[0].apiKey || "",
            baseURL: this._routes[0].baseURL,
        });
        if (this._provider !== "deepseek" && config.llmFallbackModel) {
            this._routes.push({
                provider: this._provider,
                model: config.llmFallbackModel,
                apiKey: config.llmApiKey || config.deepseekApiKey,
                baseURL: config.llmBaseUrl,
                retries: 1,
                timeoutMs: ROUTER_TIMEOUT_MS,
            });
        }
        if (this._provider !== "deepseek") {
            this._routes.push({
                provider: config.llmFinalFallbackProvider || "deepseek",
                model: config.llmFinalFallbackModel || "deepseek-flash",
                apiKey: config.deepseekApiKey,
                baseURL: "https://api.deepseek.com/v1",
                retries: 1,
                timeoutMs: DIRECT_TIMEOUT_MS,
            });
        }
    }

    _mergeReasoning(data, provider = this._provider) {
        if (provider !== "deepseek") return;
        for (const choice of data.choices || []) {
            const msg = choice.message || {};
            if (!msg.content && msg.reasoning_content) {
                msg.content = msg.reasoning_content;
            }
        }
    }

    /**
     * @param {Array} messages
     * @param {Array} [tools]
     * @param {string} [toolChoice]
     * @param {{reasoning?: 'auto'|'disabled'|'adaptive'|'low'|'medium'|'high'}} [opts]
     */
    async chat(messages, tools, toolChoice, opts = {}) {
        const retryDelays = [1000, 2000, 4000];
        let lastError;
        const failures = [];
        for (const route of this._routes) {
            const client = route === this._routes[0]
                ? this._client
                : new OpenAI({
                    apiKey: route.apiKey || "",
                    baseURL: route.baseURL,
                });
            const useResponses = route.provider !== "deepseek";
            const reasoning = opts.reasoning || "auto";
            // The router serves its pool on /v1/responses only (#694); the
            // direct DeepSeek API has no Responses endpoint, so it stays on chat.
            const kwargs = useResponses
                ? { model: route.model, input: toResponsesInput(messages) }
                : {
                    model: route.model,
                    messages,
                    temperature: opts.temperature ?? 0.1,
                };
            if (tools) {
                kwargs.tools = useResponses ? toResponsesTools(tools) : tools;
                kwargs.tool_choice = useResponses
                    ? toResponsesToolChoice(toolChoice || "auto")
                    : toolChoice || "auto";
            }
            if (route.provider === "deepseek") {
                if (reasoning !== "disabled" && (reasoning === "adaptive" || !toolChoice || toolChoice === "auto")) {
                    // This route rejects any other `thinking.type` with
                    // `400 ... unknown variant`, and the captured production
                    // error names its accepted set as `adaptive`, `enabled`,
                    // `disabled`. The low/medium/high effort scale is not part of
                    // it, so an effort value falls back to the model-decides
                    // mode rather than going on the wire.
                    const thinking = reasoning === "auto" ? this._reasoningEffort : reasoning;
                    kwargs.thinking = {
                        type: ["adaptive", "enabled", "disabled"].includes(thinking)
                            ? thinking
                            : "adaptive",
                    };
                }
            } else if (reasoning !== "disabled") {
                kwargs.reasoning = { effort: this._reasoningEffort };
            }
            for (let attempt = 0; attempt < route.retries; attempt++) {
                try {
                    const raw = await withAbortTimeout(route.timeoutMs ?? DIRECT_TIMEOUT_MS, (signal) =>
                        useResponses
                            ? client.responses.create(kwargs, { signal })
                            : client.chat.completions.create(kwargs, { signal }),
                    );
                    const response = useResponses ? fromResponses(raw) : raw;
                    this._mergeReasoning(response, route.provider);

                    // Detect a truncated/incomplete response (e.g. DeepSeek's
                    // thinking mode cut off before emitting a final
                    // answer, or hit a content filter). Without this check
                    // an empty/partial reasoning trace can be silently
                    // merged into `content` (via _mergeReasoning above) and
                    // treated as a real answer downstream. Mirrors the
                    // finish_reason invariant already enforced in
                    // statement/orchestrator.js. "tool_calls" and "stop" are
                    // the only expected terminations for a healthy response.
                    const choice = (response.choices || [{}])[0];
                    const finishReason = choice.finish_reason;
                    const respMsg = choice.message || {};
                    const hasUsableOutput = !!(
                        respMsg.tool_calls?.length || respMsg.content
                    );
                    if (
                        !hasUsableOutput ||
                        (finishReason &&
                            finishReason !== "stop" &&
                            finishReason !== "tool_calls")
                    ) {
                        throw deterministicError(
                            `LLM response truncated or incomplete (finish_reason: ${finishReason || "none"})`,
                        );
                    }

                    return response;
                } catch (error) {
                    lastError = error;
                    if (attempt < route.retries - 1) {
                        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
                    }
                }
            }
            failures.push({ route, error: lastError });
            logger.warn({
                event: "llm_route_failed",
                provider: route.provider,
                model: route.model,
                status: lastError?.status,
                error: lastError?.message,
            });
        }
        const summary = failures
            .map(({ route, error }) => `${route.model}: ${error?.message}`)
            .join("; ");
        if (failures.some(({ error }) => isOutageShaped(error))) {
            throw new LLMUnavailableError(`All LLM routes failed (${summary})`);
        }
        const error = deterministicError(`All LLM routes failed (${summary})`);
        error.cause = lastError;
        throw error;
    }
}

// Backward compat alias
export const DeepSeekClient = LLMClient;

/**
 * Maps email sender domains to bank name prefixes used in Actual Budget
 * account names.  Used to pre-filter the account list before sending it
 * to the LLM so it can only pick accounts belonging to the correct bank.
 */
export const DOMAIN_BANK_MAP = {
    "ocbc.com": "OCBC",
    "dbs.com": "DBS",
    "posb.com.sg": "DBS",
    "uobgroup.com": "UOB",
    "hsbc.com.hk": "HSBC",
    "trustbank.sg": "Trust",
    "sc.com": "SC",
    "maybank.com": "Maybank",
    "cimb.com": "CIMB",
    "rytbank.my": "Ryt",
};

/**
 * "SGD 12.80 " when the route would book this amount, otherwise "". Every
 * amount printed in a message goes through here: a value the route rejects must
 * never be turned into a plausible-looking money figure (#508).
 */
export function bookableAmountPrefix(value, currency) {
    const cents = bookableAmountCents(value);
    return cents === null ? "" : `${currency || "SGD"} ${Math.abs(cents) / 100} `;
}

/**
 * Extract a bank-name filter string from an email sender address/domain.
 * Returns the matching bank name from DOMAIN_BANK_MAP, or null if unknown.
 */
export function bankFromSender(sender) {
    if (!sender) return null;
    const lower = sender.toLowerCase();
    for (const [domain, bank] of Object.entries(DOMAIN_BANK_MAP)) {
        if (lower.includes(domain)) return bank;
    }
    return null;
}

// ── Suffix-override helpers (LLM-directed retrieval) ────────────────

/** Secret-looking fact texts — redacted before the LLM sees them. */
export const SECRET_RE =
    /\b(?:password|pin|otp|secret|token|nric|passport)\b/i;

/** Word-boundary-aware bank tokens found in account names. */
export const BANK_TOKENS = [
    "american express",
    "standard chartered",
    "citibank",
    "mari bank",
    "maribank",
    "trust bank",
    "youtrip",
    "you trip",
    "revolut",
    "maybank",
    "posb",
    "ocbc",
    "hsbc",
    "amex",
    "grab",
    "gxs",
    "trust",
    "citi",
    "cimb",
    "rhb",
    "ryt",
    "sc",
    "dbs",
    "uob",
];

/** True when the account name contains a known bank token. */
export function hasBankToken(name) {
    if (!name) return false;
    return BANK_TOKENS.some((t) =>
        new RegExp(`\\b${t}\\b`, "i").test(name),
    );
}

/** Brand aliases — POSB is DBS, Citi is Citibank, SC is Standard Chartered,
 *  RYT is RHB. */
export const BANK_ALIASES = {
    dbs: ["dbs", "posb"],
    posb: ["posb", "dbs"],
    citi: ["citi", "citibank"],
    citibank: ["citibank", "citi"],
    sc: ["sc", "standard chartered"],
    "standard chartered": ["standard chartered", "sc"],
    ryt: ["ryt", "rhb"],
    rhb: ["rhb", "ryt"],
};

/**
 * True when the account name carries a known bank token that belongs to
 * the sender bank (or one of its brand aliases). Unknown-bank names return
 * false — never assume.
 */
export function nameMatchesBank(name, bank) {
    if (!name || !bank) return false;
    if (!hasBankToken(name)) return false;
    const aliases = BANK_ALIASES[bank.toLowerCase()] || [bank];
    const lower = name.toLowerCase();
    return aliases.some((t) => new RegExp(`\\b${t}\\b`, "i").test(lower));
}

/**
 * The live category a memory fact names: an exact (case-insensitive) name
 * first, so "Food" never lands on "Fast Food"; then, unless `exact`, the first
 * name containing it, as before.
 */
function matchCategory(categories, name, { exact = false } = {}) {
    const wanted = String(name || "").trim().toLowerCase();
    if (!wanted) return null;
    const named = (categories || []).filter((c) => c?.name);
    return (
        named.find((c) => c.name.trim().toLowerCase() === wanted) ||
        (exact ? null : named.find((c) => c.name.toLowerCase().includes(wanted))) ||
        null
    );
}

/** Normalize a holder name for equality without turning a partial match into one. */
/** The why for an own-name row booked as Misc (owner ruling); "" otherwise. */
function ownNameNote(output) {
    return output?._own_name_misc
        ? " as Misc: a transfer in your own name, and I couldn't tell which of your accounts is the other side"
        : "";
}

function normalizeIdentityName(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/g, " ")
        .toLocaleLowerCase("en");
}

/**
 * True when a person-shaped counterparty is proven to be a REAL, remembered
 * entity, so it books instead of being held. Fail-closed: no name, no facts, an
 * unrecognised grammar or an unreadable fact store all answer false and hold.
 *
 * Only the payee/category mapping grammar qualifies:
 *   `KEY (merchant )?maps to VALUE (payee|category)`
 * It is the only fact shape in this module whose KEY is a counterparty name and
 * whose existence asserts that name is a known non-person entity. A legal-name
 * fact (`Legal name: NAME -> ...`), an `NAME is a TYPE account` fact and a
 * `... ending NNNN belongs to NAME` fact all name an account or the holder, so
 * none of them can release a person hold.
 *
 * The key is compared WHOLE after normalisation. A substring or token-overlap
 * match is forbidden: `Legal name: <holder> -> <MNEMONIC> (statement password)`
 * shares tokens with the counterparty, and an overlap rule would release a real
 * person transfer.
 *
 * @param {string} name the alert's counterparty name
 * @param {Array<{text?: string}|string>} facts the full deterministic fact list
 * @returns {boolean}
 */
export function counterpartyIsRememberedEntity(name, facts) {
    const key = normalizeIdentityName(name);
    if (!key) return false;
    return (facts || []).some((fact) => {
        const text = typeof fact === "string" ? fact : fact?.text || "";
        // Lazy match so the KEY cannot swallow the trailing "maps to VALUE".
        const match = text.match(
            /^(.+?)(?:\s+merchant)?\s+maps\s+to\s+(.+?)\s+(?:payee|category)\b/i,
        );
        if (!match) return false;
        return normalizeIdentityName(match[1]) === key;
    });
}

/**
 * The owner's rule for an incoming credit of exactly this amount from this
 * sender, from the wiki people page's "Incoming amount" column:
 *   `Incoming SGD 900.00 from NAME maps to PAYEE (payee|category)`
 * The sender is compared whole after normalisation, and the currency and cents
 * exactly, so the same sender sending any other amount gets no rule. A plain
 * `NAME maps to …` fact never yields one.
 *
 * @param {Array<{text?: string}|string>} facts the full fact list
 * @param {{name: string, currency: string, amountCents: number}} credit
 * @returns {{payee: string, category: string|null}|null}
 */
export function incomingRule(facts, { name, currency, amountCents }) {
    const who = normalizeIdentityName(name);
    const cur = String(currency || "").trim().toUpperCase();
    const cents = Math.abs(Number(amountCents));
    if (!who || !cur || !Number.isFinite(cents) || cents === 0) return null;
    let payee = null;
    let category = null;
    for (const fact of facts || []) {
        const text = typeof fact === "string" ? fact : fact?.text || "";
        const m = text.match(
            /^Incoming\s+([A-Za-z]{3})\s+(\d+(?:\.\d{1,2})?)\s+from\s+(.+?)\s+maps\s+to\s+(.+?)\s+(payee|category)\s*$/i,
        );
        if (!m || m[1].toUpperCase() !== cur || normalizeIdentityName(m[3]) !== who) continue;
        if (Math.round(Number(m[2]) * 100) !== cents) continue;
        if (m[5].toLowerCase() === "payee") payee ??= m[4].trim();
        else category ??= m[4].trim();
    }
    return payee ? { payee, category } : null;
}

/**
 * How memory answers an incoming credit from a named person, after
 * `incomingRule` found no rule for this exact amount:
 * - `amountOnly`: the sender has some amount rule, so only an exact amount
 *   counts and their plain name fact does not apply to this credit;
 * - `payee`: otherwise, the payee of a plain `NAME maps to PAYEE payee` fact
 *   naming the whole sender, or null.
 *
 * @param {Array<{text?: string}|string>} facts the full fact list
 * @param {string} name the sender
 * @returns {{amountOnly: boolean, payee: string|null}}
 */
export function incomingPersonMemory(facts, name) {
    const who = normalizeIdentityName(name);
    let amountOnly = false;
    let payee = null;
    if (!who) return { amountOnly, payee };
    for (const fact of facts || []) {
        const text = typeof fact === "string" ? fact : fact?.text || "";
        const ruled = text.match(/^Incoming\s+[A-Za-z]{3}\s+[\d.]+\s+from\s+(.+?)\s+maps\s+to\s/i);
        if (ruled) {
            if (normalizeIdentityName(ruled[1]) === who) amountOnly = true;
            continue;
        }
        const plain = text.match(/^(.+?)\s+maps\s+to\s+(.+?)\s+payee\s*$/i);
        if (plain && !payee && normalizeIdentityName(plain[1]) === who) payee = plain[2].trim();
    }
    return { amountOnly, payee: amountOnly ? null : payee };
}

/**
 * True when the destination a transfer names cannot be pinned to exactly one
 * open account.
 *
 * A bank NAME alone is a weak signal: "OverseaChinese Banking Corporation Ltd"
 * matches both OCBC 360 and OCBC 90N, so the name alone is ambiguous. The alert
 * body does carry a stronger signal in `A/C ending 6600`, and a row resolved
 * from such evidence comes back marked `_structured_movement`, which makes the
 * caller skip this ambiguity check. So the rows that reach this gate are the
 * unresolved ones, and for those the bank name is the best signal available —
 * so the rule stays as it is.
 *
 * Two properties of that flag are easy to get wrong when changing either side:
 *
 * - It is NOT proof that an internal resolution happened. It is set on three
 *   resolution outcomes in `_resolveMovementToOutput` — the internal transfer,
 *   the deterministic external payment, and the one-sided incoming deposit —
 *   and only the first of those is `resolved.internal`, so a row can arrive
 *   marked without both legs having resolved to the holder's own accounts.
 *   Pinned by tests/ocbc-trust-transfer-hold.test.js (#623).
 * - It is set by whichever extractor produced the movement, because the flag
 *   lives in `_resolveMovementToOutput`. When the LLM-extractor path resolves a
 *   movement it returns that output directly from `_runPhase1`, so it never
 *   passes the Phase-1 sanitizer that strips an LLM-*injected* value of the
 *   flag; an LLM-extractor row that resolved internally therefore arrives
 *   marked and skips this check too (#623). The full Phase-1 LLM path does pass
 *   that sanitizer, so its rows arrive unmarked — a row reaching this gate has
 *   not necessarily come from a deterministic parser. Unmarked is necessary but
 *   not sufficient to reach it: the gate sits inside a
 *   `payee_name && payee_name !== "Misc"` block, so a row must also clear that
 *   guard and have a transfer payee for the matched account. (In particular the
 *   deterministic parser's three `_hold_unresolved_transfer` branches are NOT
 *   counterexamples: they set `payee_name: "Misc"`, so they are excluded by that
 *   guard before the gate is reached.)
 *
 * Skipping this ambiguity check is the flag's only effect HERE, and the caller's
 * other four refusals — no matching account, a closed account, a self target,
 * and a credit-card account — still apply regardless. The flag is not globally
 * inert: elsewhere it is also REQUIRED to ENABLE the Phase-3 schedule-collision
 * check (`scheduleCheckable` requires `_structured_movement === true`), so it
 * has the opposite polarity there and a forged value only adds holds. Both
 * effects are why the Phase-1 sanitizer strips a forged value (#623).
 */
export function transferDestinationIsAmbiguous(name, destination, accounts) {
    const direct = matchAccountByName(name, accounts);
    if (direct.matched && direct.id === destination.id) return false;
    const bank = bankFromText(name);
    return bank && accounts.filter((account) =>
        !account.closed && bankFromText(account.name) === bank,
    ).length > 1;
}

/**
 * True when `value` is a mask of one of the user's own account names: it stays
 * literal outside the masked run, and the run matches one or more letters.
 * `T*** U***` masks `Trust Bank`; `A*** B***` masks a two-part holder name.
 * Only account names are considered, so a masked merchant cannot be mistaken
 * for a self identity. Issue #561.
 */
// Marks a debit booked as a possible own transfer whose credit has not arrived.
const SELF_TRANSFER_TAG = "Possible own transfer (awaiting credit)";

function masksOwnAccount(value, accounts, aliases) {
    const candidate = String(value || "").trim();
    if (!/[＊*]{2,}/.test(candidate)) return false;
    const names = [
        ...(accounts || []).map((a) => a?.name),
        ...(aliases ? aliases.values() : []),
    ].filter(Boolean);
    for (const name of names) {
        const target = String(name).trim();
        if (!target) continue;
        const pattern = candidate
            .split(/([＊*]+)/)
            .map((part) =>
                /^[＊*]+$/.test(part)
                    ? "[\\p{L}\\p{N}]+"
                    : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
            )
            .join("");
        if (new RegExp(`^${pattern}$`, "iu").test(target)) return true;
    }
    return false;
}

/** Remove secret-looking facts from a search result list. */
export function sanitizeResults(results) {
    return (results || []).filter((r) => !SECRET_RE.test(r.text || ""));
}

/**
 * True when any cached fact is usable as suffix-override evidence:
 * high-score, suffix-format, suffix present in email, and the account it names
 * resolving to a live account whose bank matches the sender.
 *
 * The fact's account name is resolved through the shared account resolver
 * rather than compared literally. That is the whole point of issue #331: a fact written as
 * "Nova" or "Vista" must still arm the net, and the bank check must run
 * against the resolved account rather than the words the user happened to type.
 * A name that resolves to no account still fails, so this does not loosen the
 * cross-bank guard.
 *
 * @param {Array} facts cached search_memory results
 * @param {string} emailText alert body
 * @param {string} senderBank bank parsed from the sender domain
 * @param {Array} [liveAccounts] live accounts; when absent, only exact names
 *   count (the pre-#331 behaviour).
 */
export function hasUsableSuffixFact(facts, emailText, senderBank, liveAccounts = []) {
    // Built once, not per fact: the map only depends on the list.
    const aliases = accountAliases(facts, liveAccounts);
    return (facts || []).some((f) => {
        if ((f.score ?? 0) < 0.5) return false;
        const parsed = parseSuffixFact(f.text);
        if (!parsed) return false;
        const resolved = resolveFactAccount(
            parsed.accountName,
            liveAccounts,
            aliases,
        );
        if (!resolved || !resolved.matched) return false;
        if (!nameMatchesBank(resolved.name, senderBank)) return false;
        return new RegExp(`\\b${parsed.suffix}\\b`).test(emailText);
    });
}

/**
 * Resolve a fact's written account name to a live account.
 *
 * Without live accounts there is nothing to resolve against, so the fact is
 * treated as unusable. Callers must supply the account list.
 */
export function resolveFactAccount(accountName, liveAccounts = [], aliases) {
    return resolveFactAccountShared(accountName, liveAccounts, aliases);
}

/** Bill-payment layout — override must never pick the destination card. */
export const BILL_PAYMENT_SHAPE_RE =
    /\(A\/C\s+ending\s+\S+\)[\s\S]*\(Ref\s+ending\s+\S+\)/i;

/**
 * Bank-movement-shaped alerts (A/C/Ref ending, parenthesized account, or a
 * movement verb) — bill payments and inter-account/inter-bank transfers.
 * For these, the merchant is expected to name a DIFFERENT tracked account
 * (the destination), so any "merchant name matches a different account"
 * heuristic must not treat that as evidence of a wrong account_id pick.
 */
export const MOVEMENT_LIKE =
    /(?:A\/C\s+ending|Ref\s+ending|account\s+ending|\(-\d{4,}\)|using\s+your|was paid|has been paid|you'?ve received|you have received|received a transfer|bill payment|scheduled payment|was transferred|made a transfer|transfer to|transfer from)/i;

/**
 * Narrower than MOVEMENT_LIKE: only phrases that unambiguously name a
 * destination/source ACCOUNT (not a merchant) — "A/C ending", "Ref ending",
 * an explicit transfer, or a parenthesized account digit suffix. Used to gate
 * the memory-aware account check specifically, which SUPPRESSES a safety net
 * rather than merely attempting an extra extraction pass. MOVEMENT_LIKE's
 * broader purchase-adjacent phrases ("using your", "was paid", "you've
 * received") also match ordinary card/wallet purchase alerts (e.g. a card alert's
 * "RM200.00 was paid at MERCHANT using your Main Account on ..."), where the
 * merchant is a real merchant, not another tracked account — the memory
 * check must stay active for those.
 */
export const ACCOUNT_TRANSFER_SHAPE_RE =
    /(?:A\/C\s+ending|Ref\s+ending|account\s+ending|\(-\d{4,}\)|received a transfer|bill payment|scheduled payment|was transferred|made a transfer|transfer to|transfer from)/i;

/**
 * A destination the paying bank itself names as a CREDIT CARD, e.g.
 * "CITI CREDIT CARDS", "HSBC CREDIT CARDS", "UOB CREDIT CARDS". Used only as
 * an exemption from the unverified-destination hold: a bill payment into a card
 * is a card repayment, so it must not be held the way a genuinely unresolved
 * own-account transfer is. Nothing is inferred about a counterparty the bank
 * did not describe as a card, and a destination that resolves to one of the
 * holder's own accounts (even a card account, named "Altitude" or "Yuu") is
 * handled by the resolved-transfer path above rather than here.
 */
export const CARD_PRODUCT_RE = /\bcredit\s+cards?\b|\bcredit\s+card\b/i;

export class AgentOrchestrator {
    constructor(config, tools) {
        this._config = config;
        this._llm = new LLMClient(config);
        this._llmOutageTries = new Map();
        this._tools = tools;
    }

    get tools() {
        return this._tools;
    }

    /**
     * Process raw alert text from Telegram — 3-phase pipeline, no IMAP/notify.
     */
    async processText(rawText) {
        try {
            return await this._processTextInternal(rawText);
        } catch (e) {
            logger.error({ event: "process_text_error", error: e.message });
            return {
                action: "error",
                details: `Processing failed: ${e.message}`,
            };
        }
    }

    async _processTextInternal(rawText) {
        const emailText = String(rawText || "");

        // Phase 1: LLM Analysis
        const phase1 = await this._runPhase1(emailText);
        if (!phase1) {
            return {
                action: "notified",
                details: "Couldn't understand this transaction alert.",
            };
        }

        if (phase1.action === "skip") {
            return this._executePhase3Silent(phase1);
        }

        if (!phase1.account_id) {
            logger.warn({
                event: "phase1_no_account",
                merchant: phase1.merchant,
            });
            return {
                action: "notified",
                details: `Couldn't match an account for "${phase1.merchant}". Please review.`,
            };
        }

        // Phase 2: Resolution
        const phase2 = await this._resolvePhase2(phase1);

        // Phase 3: Execute (silent)
        return this._executePhase3Silent(phase2);
    }

    /**
     * Process a transaction email through the 3-phase pipeline.
     */
    async processEmail(msgId, rawEmail, imapHandler, from, subject) {
        try {
            return await this._processEmailInternal(
                msgId,
                rawEmail,
                imapHandler,
                from,
                subject,
            );
        } catch (e) {
            logger.error({ event: "process_email_error", error: e.message });
            this._tools.setEmailContext(msgId, rawEmail, imapHandler);
            const notified = await this._tools.executeTool("notify_user", {
                message: `Error processing email from "${from || "unknown"}" re: "${subject || "unknown"}": ${String(e.message).slice(0, 300)}`,
            });
            if (!notified) {
                logger.error({
                    event: "notify_user_failed",
                    context: "process_email_catch",
                    error: e.message,
                });
            }
            throw e;
        }
    }

    /**
     * LLM call with outage classification at the orchestrator boundary (#694).
     * `LLMClient.chat` already separates outages from deterministic failures; an
     * error that still escapes it untagged is an unclassified provider failure,
     * so it is treated as an outage (capped by MAX_LLM_OUTAGE_RETRIES).
     */
    async _chat(...args) {
        try {
            return await this._llm.chat(...args);
        } catch (error) {
            if (error instanceof LLMUnavailableError || error?.deterministic) throw error;
            throw new LLMUnavailableError(`LLM call failed: ${error?.message}`);
        }
    }

    /**
     * Every LLM route failed for a reason that may clear up (#694). The email is
     * left retryable with a short cooldown; the user hears about it once per
     * email, and after MAX_LLM_OUTAGE_RETRIES the ordinary 12h cooldown applies
     * so a request every route rejects cannot loop forever.
     */
    async _llmUnavailableResult(msgId, from, subject, error) {
        logger.error({ event: "llm_unavailable", error: error.message });
        const tries = (this._llmOutageTries.get(msgId) || 0) + 1;
        this._llmOutageTries.set(msgId, tries);
        if (tries === 1) {
            await this._tools.executeTool("notify_user", {
                message: `LLM unavailable for email from "${from || "unknown"}" re: "${subject || "unknown"}"; it stays unread and will be retried.`,
            });
        }
        if (tries > MAX_LLM_OUTAGE_RETRIES) {
            this._llmOutageTries.delete(msgId);
            return { action: "notified", details: "LLM unavailable; retry cap reached" };
        }
        return { action: "llm_unavailable", details: error.message };
    }

    async _processEmailInternal(msgId, rawEmail, imapHandler, from, subject) {
        this._tools.setEmailContext(msgId, rawEmail, imapHandler);

        // Extract email content
        let emailText = "";
        let usedFallback = false;
        // The email with its own line breaks: evidence for classification and
        // the only reliable end of a `Reference:` field (#720). Empty when the
        // MIME could not be parsed, because the fallback text is raw MIME with
        // headers, which is never sent anywhere.
        let linesText = "";
        try {
            const raw = Buffer.isBuffer(rawEmail)
                ? rawEmail
                : Buffer.from(rawEmail || "");
            emailText = await extractEmailContent(raw);
            linesText = await extractEmailContent(raw, null, { keepLines: true });
        } catch {
            emailText = String(rawEmail || "");
            usedFallback = true;
            linesText = "";
        }

        // Prepend sender + subject as account-matching signals for Phase 1.
        // Skip when extractEmailContent failed — raw MIME already contains headers.
        // Use "Email-Sender:" instead of "From:" to avoid conflicting with
        // "From: [account]" lines in bill payment / transfer email bodies.
        if (!usedFallback) {
            const headerLines = [];
            if (from) headerLines.push(`Email-Sender: ${from}`);
            if (subject) headerLines.push(`Subject: ${subject}`);
            if (headerLines.length)
                emailText = headerLines.join("\n") + "\n\n" + emailText;
        }

        // Phase 1: LLM Analysis
        const senderBank = bankFromSender(from);
        let phase1;
        try {
            phase1 = await this._runPhase1(emailText, {
                senderBank,
                receivedAt: this._emailReceivedAt(rawEmail),
                linesText,
            });
        } catch (error) {
            if (!(error instanceof LLMUnavailableError)) throw error;
            return this._llmUnavailableResult(msgId, from, subject, error);
        }
        if (!phase1) {
            const notified = await this._tools.executeTool("notify_user", {
                message: `Couldn't understand email from "${from || "unknown"}" re: "${subject || "unknown"}".`,
            });
            if (!notified) {
                logger.error({
                    event: "notify_user_failed",
                    context: "phase1_null",
                });
                return {
                    action: "notify_failed",
                    details: "Phase 1 returned no output, notification failed",
                };
            }
            return {
                action: "notified",
                details: "Phase 1 returned no output",
            };
        }

        if (phase1.action === "skip") {
            return this._executePhase3(phase1);
        }

        if (!phase1.account_id) {
            logger.warn({
                event: "phase1_no_account",
                merchant: phase1.merchant,
            });
            const notified = await this._tools.executeTool("notify_user", {
                message:
                    phase1.notify_message ||
                    `Couldn't match an account for "${phase1.merchant}". Please review.`,
            });
            if (!notified) {
                logger.error({
                    event: "notify_user_failed",
                    context: "phase1_no_account",
                    merchant: phase1.merchant,
                });
                return {
                    action: "notify_failed",
                    details: "No account matched, notification failed",
                };
            }
            return {
                action: "notified",
                details: "No account matched after Phase 1",
            };
        }

        // Phase 2: Resolution. The email's uid lets the transfer-leg lookup
        // claim a booked leg for this alert only (issue #578); set after the
        // Phase-1 sanitiser, so LLM output cannot supply it.
        phase1._alert_id = msgId;
        if (linesText) {
            phase1._evidence = { text: linesText, subject: subject || "", sender: from || "" };
        }
        const phase2 = await this._resolvePhase2(phase1);

        // Phase 3: Execute
        return this._executePhase3(phase2);
    }

    // ═══════════════════════════════════════════════════════════════
    // Phase 1: LLM Analysis
    // ═══════════════════════════════════════════════════════════════

    /**
     * Convert a foreign-currency charge to the charged card's currency (#796).
     * The rate comes from the LLM, so the note says it is approximate and keeps
     * the original amount. A conversion that fails or is not a positive number
     * is held through the no-account path; it is never booked in the foreign
     * amount. An LLM outage propagates like any other.
     */
    async _convertForeignCharge(output, fromCurrency) {
        const toCurrency = output.budget_id === this._config.secondaryBudgetFile
            ? this._config.secondaryCurrency
            : this._config.primaryCurrency;
        const cents = Number(output.amount_cents);
        const original = (Math.abs(cents) / 100).toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
        let converted = NaN;
        try {
            const response = await this._chat(
                [{
                    role: "user",
                    content: `Convert ${original} ${fromCurrency} to ${toCurrency} at the typical exchange rate on ${output.date || "today"}. Respond ONLY with JSON: {"amount": <the ${toCurrency} amount as a number>}`,
                }],
                undefined,
                undefined,
                { reasoning: "disabled", temperature: 0 },
            );
            const parsed = this._parseJsonFromContent(
                (response.choices || [{}])[0].message?.content || "",
            );
            converted = typeof parsed?.amount === "number" ? parsed.amount : NaN;
        } catch (error) {
            if (error instanceof LLMUnavailableError) throw error;
            logger.warn({ event: "fx_conversion_failed", error: error.message });
        }
        const convertedCents = Math.round(converted * 100);
        if (!Number.isFinite(converted) || convertedCents <= 0) {
            logger.warn({ event: "fx_conversion_held", fromCurrency, toCurrency });
            return {
                ...output,
                account_id: "",
                notify_message: `Held: a ${fromCurrency} ${original} charge at "${output.merchant || "unknown"}" could not be converted to ${toCurrency}, so it was not booked.`,
            };
        }
        const note = `Original: ${fromCurrency} ${original} (approx. ${toCurrency} conversion by LLM)`;
        return {
            ...output,
            amount_cents: cents < 0 ? -convertedCents : convertedCents,
            currency: toCurrency,
            notes: [output.notes, note].filter(Boolean).join("\n"),
        };
    }

    _emailReceivedAt(rawEmail) {
        const raw = Buffer.isBuffer(rawEmail) ? rawEmail.toString("utf8") : String(rawEmail || "");
        const header = raw.match(/^Date:\s*([^\r\n]+(?:\r?\n[ \t]+[^\r\n]+)*)/im)?.[1]
            ?.replace(/\r?\n[ \t]+/g, " ");
        const parsed = header ? Date.parse(header) : NaN;
        return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
    }

    async _runStructuredMovement(emailText, senderBank, receivedAt, linesText = "") {
        const movement = parseBankMovement(emailText, {
            senderBank,
            receivedAt: receivedAt || new Date().toISOString(),
        });
        if (!movement) return null;
        // The flattened text runs a trailing `Reference:` into the email's
        // boilerplate; the line-preserved text ends it where the sender did.
        if (linesText) {
            movement.reference_number = exactReference(linesText, movement.reference_number);
        }
        return this._resolveMovementToOutput(movement, { allowSuffixLearning: true });
    }

    /**
     * The full fact store, for a decision that must not depend on recall.
     *
     * `search_memory` is a relevance search: a miss is silent, and a miss here
     * would book a real person transfer as spend. `list_facts` is the
     * deterministic read of the whole store. Any failure answers `[]`, which the
     * release predicate treats as "not proven", so the hold stands.
     */
    async _personEntityFacts() {
        try {
            const result = await this._tools.executeTool("list_facts", {});
            return Array.isArray(result?.facts) ? result.facts : [];
        } catch (error) {
            logger.warn({
                event: "person_entity_facts_failed",
                error: error.message,
            });
            return [];
        }
    }

    async _resolveMovementToOutput(movement, { allowSuffixLearning = false } = {}) {
        // A movement whose amount did not parse must not become a booking: the
        // sign flip below turned `null` into -0, and the route accepts 0, so a
        // malformed amount token used to post a fabricated 0-cent row (#508).
        if (!isBookableAmountCents(movement?.amount_cents)) return null;
        const budgetId = movement.currency === this._config.primaryCurrency
            ? this._config.primaryBudgetFile
            : this._config.secondaryBudgetFile;
        const ctx = await this._tools.executeTool("fetch_context", { budget_id: budgetId });
        const accounts = ctx?.accounts || [];
        const facts = [];
        const queries = new Set([
            movement.own_account?.suffix,
            movement.counterparty?.suffix,
            movement.counterparty?.name,
            movement.recipient_bank ? `${movement.recipient_bank} alert recipient` : "",
        ].filter(Boolean));
        for (const query of queries) {
            const result = await this._tools.executeTool("search_memory", { query });
            facts.push(...(result?.results || []));
        }
        // The person/business question is settled from a FULL deterministic read,
        // never from `search_memory`: a recall miss on the queried name would
        // silently book a real person transfer as spend, which is the defect the
        // person hold closes. Read it only for a movement the parser already
        // flagged person-shaped, so an ordinary merchant alert pays nothing.
        // A payee/category mapping whose key is the counterparty is the ONLY
        // thing that proves the name is a real, remembered entity.
        const personCounterpartyReleased =
            movement.person_transfer === true && counterpartyIsRememberedEntity(
                movement.counterparty?.name,
                await this._personEntityFacts(),
            );
        const mappings = identityMappingsFromFacts(facts, accounts);
        const resolved = resolveMovementAccounts(movement, accounts, ctx?.payees || [], mappings);
        const source = resolved.source_account;
        const destination = resolved.destination_account;
        const suffixMappings = allowSuffixLearning
            ? this._collectSuffixMappings(movement, resolved, accounts, mappings)
            : [];
        const date = movement.occurred_at?.slice(0, 10);
        // Trust-style card repayment (issue #576): the alert names neither
        // account, so the destination is the sender bank's ONLY open credit card
        // and the funding side is a booked journal leg, else the bank's only
        // open cash account. Anything less certain is held.
        if (movement.card_repayment === true && movement.direction === "outgoing" && date) {
            return this._resolveCardRepaymentMovement(movement, {
                accounts, budgetId, date, suffixMappings, payees: ctx?.payees || [],
            });
        }
        if (!source || !date) {
            // An outgoing movement whose counterparty resolves to another of the
            // user's own accounts is an internal transfer, not a merchant
            // payment. When the source account cannot be resolved (its suffix
            // has no memory fact yet), the LLM fallback books the counterparty
            // name as a merchant and posts a phantom expense (issue #592: a DBS
            // FAST transfer POSB ...5500 -> SC 2555 was booked as "Household
            // stuffs"). Hold it for the user instead of guessing a purchase.
            if (
                !source &&
                date &&
                movement.direction === "outgoing" &&
                destination &&
                /\bA\/C\s*ending\s*\d{4,}/i.test(movement.counterparty?.name || "")
            ) {
                return {
                    merchant: movement.counterparty?.name || "Transfer",
                    amount_cents: -Math.abs(movement.amount_cents),
                    date,
                    currency: movement.currency,
                    account_id: destination.id,
                    account_name: destination.name,
                    budget_id: budgetId,
                    action: "insert",
                    payee_name: "Misc",
                    category_id: null,
                    raw_description: `Transfer to ${movement.counterparty?.name || destination.name}`,
                    raw_merchant_descriptor: "",
                    notes: movement.reference_number ? `Statement: ${movement.reference_number}` : "",
                    reasoning: "Held: internal transfer source account could not be resolved",
                    notify_message: "",
                    _suffix_mappings: suffixMappings,
                    _hold_unresolved_transfer: true,
                    _hold_cause: "destination_unresolved",
                };
            }
            // F2: an OUTGOING movement whose source account cannot be pinned
            // because the SENDER BANK is ambiguous — the alert names a bank but no
            // account suffix, and two or more live accounts sit at that bank, so
            // there is no evidence to break the tie. Without this the alert is
            // DROPPED at `return null` below, so the user is never told and the
            // money silently vanishes from the pipeline: the uid-1012
            // scheduled-transfer shape ("Your scheduled transfer of … to <person>
            // … was successfully completed", whose parser sets
            // own_account {name:null, bank:"Ryt", suffix:null}).
            //
            // BOTH conditions are load-bearing. `!suffix` is what separates this
            // from an ordinary bill-payment alert whose NAMED source suffix simply
            // failed to resolve (own_account carries a suffix); those must keep
            // falling through to the LLM extractor rather than becoming a hold.
            // The 2+ live-account test is what makes the bank genuinely ambiguous —
            // `resolveAccountByBank` returns null both for zero and for many, and
            // only "many" is an ambiguity the user can resolve.
            //
            // Keyed on `outgoing` on purpose: an incoming movement with an
            // ambiguous sender bank is an ordinary bank credit, and holding every
            // one of those is the opposite trade. This branch sits BEFORE the
            // person-hold site, so a person-shaped counterparty that lands here
            // never reaches that site: it renders the source-ambiguous cause, and
            // never the person-identity one.
            const ownBank = movement.own_account?.bank;
            const ownSuffix = movement.own_account?.suffix;
            const ambiguousSenderBank =
                !ownSuffix &&
                ownBank &&
                accounts.filter(
                    (account) => !account.closed && bankFromText(account.name) === ownBank,
                ).length >= 2;
            if (
                !source &&
                date &&
                movement.direction === "outgoing" &&
                movement.counterparty?.name &&
                ambiguousSenderBank
            ) {
                return {
                    merchant: movement.counterparty.name,
                    amount_cents: -Math.abs(movement.amount_cents),
                    date,
                    currency: movement.currency,
                    account_id: "",
                    account_name: "",
                    budget_id: budgetId,
                    action: "insert",
                    payee_name: "Misc",
                    category_id: null,
                    raw_description: `Transfer to ${movement.counterparty.name}`,
                    raw_merchant_descriptor: "",
                    notes: movement.reference_number ? `Statement: ${movement.reference_number}` : "",
                    reasoning: `Held: source account ambiguous at this bank; the transfer to "${movement.counterparty.name}" was not booked`,
                    notify_message: "",
                    _suffix_mappings: suffixMappings,
                    _hold_unresolved_transfer: true,
                    _hold_cause: "source_account_ambiguous",
                };
            }
            return null;
        }

        // Hold only a known own identity, never a name-shaped guess. Company
        // names and legitimate third parties can be two plain words, so the old
        // structural heuristic silently held real vendor payments. The memory
        // query above returns the existing legal-name fact for an exact holder
        // match without exposing it to the LLM or notification text.
        const counterparty = movement.counterparty?.name;
        const knownOwnIdentity = counterparty && facts.some((fact) => {
            const text = typeof fact === "string" ? fact : fact?.text || "";
            const match = text.match(/\b(?:legal|account\s+holder)\s+name\s*:\s*([^\n.]+)/i);
            if (!match) return false;
            // The live fact carries a statement-password mnemonic after the
            // holder name, e.g. `Legal name: <holder> -> <MNEMONIC> (statement
            // password)`. Everything after an arrow is metadata, not part of the
            // name, so trim it before comparing or the holder never matches.
            // Issue #592.
            const holder = match[1].split(/\s*(?:->|→|=>)\s*/, 1)[0];
            return normalizeIdentityName(holder) === normalizeIdentityName(counterparty);
        });
        // Two person-shaped cases. The own-identity case (the holder's legal name
        // recalled from memory, and the name does not resolve to a tracked
        // account) is booked as Misc below, by owner ruling; it used to be held.
        // The person-transfer case still holds: the
        // PARSER already decided this is a person-to-person movement
        // (bank-movement.js person_transfer, set from `looksLikePersonName`), and
        // an unremembered person name is unverifiable without consulting accounts.
        //
        // The account-match test deliberately does NOT gate the second arm. As a
        // term of the whole condition it suppressed the hold for ANY counterparty
        // that resolves to an account, because `matchAccountByName` matches on
        // TOKEN CONTAINMENT (suffix-facts.js matchWithoutAliases step 2,
        // `query.every(w => target.includes(w))`): a transfer to the person
        // `WEI LING` resolved `matched:true` to an account `Wei Ling Savings`
        // (while `WEI LING TAN` did not), so a transfer to a real person booked
        // as spend on every route. A person name is held because it is an
        // unremembered person, not because it failed an account lookup.
        // Owner ruling (#796): a credit FROM the holder's own legal name is the
        // holder's own transfer, so a correct run finds its other leg instead
        // of holding it. Already booked through the transfer journal: skip,
        // because Actual created this credit with that transfer. Exactly one
        // unlinked `Misc` debit of the amount that day on another own account:
        // book the credit and link the pair. Anything else still holds, since
        // an unlinked credit would read as income (#585).
        let ownCreditDebit = null;
        if (
            movement.direction === "incoming" &&
            knownOwnIdentity &&
            !resolved.internal &&
            destination &&
            date
        ) {
            const counterpart = await this._findOwnTransferCounterpart({
                movement, destination, accounts, budgetId, date,
            });
            if (counterpart?.booked) {
                return {
                    merchant: "Own transfer",
                    amount_cents: Math.abs(movement.amount_cents),
                    date,
                    currency: movement.currency,
                    account_id: destination.id,
                    account_name: destination.name,
                    budget_id: budgetId,
                    action: "skip",
                    payee_name: "",
                    category_id: null,
                    raw_description: "Own transfer",
                    raw_merchant_descriptor: "",
                    notes: "",
                    reasoning: "Own transfer already booked from its outgoing leg",
                    notify_message: "",
                    _structured_movement: true,
                };
            }
            ownCreditDebit = counterpart?.debit || null;
        }
        const personNamed =
            movement.person_transfer === true && !personCounterpartyReleased && !ownCreditDebit;
        const ownNameUnresolved =
            !resolved.internal &&
            knownOwnIdentity &&
            !ownCreditDebit &&
            !matchAccountByName(counterparty, accounts, mappings.aliases).matched;
        // Owner ruling: the holder's own legal name is never a stranger, so an
        // own-name movement whose other side no account identifies is booked as
        // Misc with no category instead of held (it used to be held under #569 /
        // #585 / #592). The purpose varies, so no payee or category is guessed,
        // and the notification says why. A stranger's name still holds below.
        if (ownNameUnresolved) {
            const incoming = movement.direction === "incoming";
            const namedParty = incoming
                ? (movement.own_account?.name || counterparty)
                : counterparty;
            return {
                merchant: namedParty || "Own transfer",
                amount_cents: incoming
                    ? Math.abs(movement.amount_cents)
                    : -Math.abs(movement.amount_cents),
                date,
                currency: movement.currency,
                account_id: source.id,
                account_name: source.name,
                budget_id: budgetId,
                action: "insert",
                payee_name: "Misc",
                category_id: null,
                raw_description: `${incoming ? "Transfer from" : "Transfer to"} own name`,
                raw_merchant_descriptor: "",
                notes: movement.reference_number ? `Statement: ${movement.reference_number}` : "",
                reasoning: "Own-name transfer; the other side is not an identified account, so Misc",
                notify_message: "",
                _suffix_mappings: suffixMappings,
                _structured_movement: true,
                _own_name_misc: true,
                // An own-name credit booked first as Misc waits for this debit;
                // the credit side already looked for a waiting debit (#796).
                ...(incoming
                    ? {}
                    : {
                          _pair_other_accounts: accounts
                              .filter((a) => !a.closed && a.id !== source.id)
                              .map((a) => a.id),
                          _pair_untagged: true,
                      }),
            };
        }
        const unverifiablePersonMovement = !resolved.internal && personNamed;
        if (unverifiablePersonMovement) {
            // Name the OTHER party to the money. On this route `counterparty` is
            // the destination field and `own_account` the source field, and the
            // extractor route fills them unconditionally from `to_account` /
            // `from_account` — so on an INCOMING credit `counterparty` is the
            // holder's OWN account and the counterparty is `own_account.name`.
            // Naming the destination field for an incoming movement told the
            // holder a transfer to their own account was held because the
            // counterparty was unverified.
            const namedParty = movement.direction === "outgoing"
                ? counterparty
                : (movement.own_account?.name || counterparty);
            return {
                merchant: namedParty || "Bank transfer",
                amount_cents: movement.direction === "incoming"
                    ? Math.abs(movement.amount_cents)
                    : -Math.abs(movement.amount_cents),
                date,
                currency: movement.currency,
                account_id: source.id,
                account_name: source.name,
                budget_id: budgetId,
                action: "insert",
                payee_name: "Misc",
                category_id: null,
                raw_description: `${movement.direction === "incoming" ? "Transfer from" : "Transfer to"} ${namedParty || "an unverified counterparty"}`,
                raw_merchant_descriptor: "",
                notes: movement.reference_number ? `Statement: ${movement.reference_number}` : "",
                reasoning: `Held: transfer to "${namedParty || "an unverified counterparty"}" could not be matched to a known payee or account`,
                notify_message: "",
                _suffix_mappings: suffixMappings,
                _hold_unresolved_transfer: true,
                _hold_cause: "person_identity_unverified",
            };
        }

        if (resolved.internal) {
            const incoming = movement.direction === "incoming";
            const bookedAccount = incoming ? destination : source;
            const otherAccount = incoming ? source : destination;
            // The payee naming the OTHER account is what makes this row a
            // transfer; an incoming leg prefers the SENDING account's payee.
            const transferPayeeId = resolved.destination_payee?.id || null;
            return {
                merchant: movement.counterparty?.name || otherAccount.name,
                amount_cents: incoming
                    ? Math.abs(movement.amount_cents)
                    : -Math.abs(movement.amount_cents),
                date,
                currency: movement.currency,
                account_id: bookedAccount.id,
                account_name: bookedAccount.name,
                budget_id: budgetId,
                action: "insert",
                payee_name: otherAccount.name,
                payee_id: transferPayeeId,
                category_id: null,
                raw_description: `Transfer ${incoming ? "from" : "to"} ${movement.counterparty?.name || otherAccount.name}`,
                raw_merchant_descriptor: "",
                notes: movement.reference_number ? `Statement: ${movement.reference_number}` : "",
                reasoning: "Deterministic structured bank transfer",
                notify_message: "",
                _suffix_mappings: suffixMappings,
                // Both legs were resolved against the holder's OWN live
                // accounts: `resolved.internal` requires a source and a
                // destination that are different accounts from
                // `fetch_context`, plus a transfer payee for one of them
                // (src/bank-movement.js). Marking the row structured keeps the
                // Phase-2 ambiguity gate below from re-deciding that settled
                // destination from the counterparty's BANK NAME, which matches
                // every account the holder owns at that bank. "OverseaChinese
                // Banking Corporation Ltd A/C ending 6600" was judged ambiguous
                // purely because two open accounts carry an OCBC token, and a
                // correct transfer pair was flipped to Misc and held (issue
                // #575, production incident 2026-09-27). The other four checks
                // in that gate are unaffected and still refuse.
                _structured_movement: true,
                _is_transfer: true,
                _is_paynow: movement.is_paynow === true,
                _transfer: {
                    budget_id: budgetId,
                    source_account_id: source.id,
                    destination_account_id: destination.id,
                    currency: movement.currency,
                    amount_cents: Math.abs(movement.amount_cents),
                    occurred_at: movement.occurred_at,
                    payee_id: transferPayeeId,
                },
            };
        }

        if (movement.direction === "incoming" && !movement.counterparty) {
            // The reference is the only identity a one-sided deposit has (#720).
            // It becomes the descriptor only when it is a short label; an id or a
            // sentence stays in the notes and in the evidence sent to the
            // resolver. Phase 2 clears the `Misc` placeholder, so memory and Jev
            // get to decide, and `Misc` remains the answer when neither can.
            const reference = String(movement.reference_number || "").trim();
            const descriptor = descriptorOf(reference) || "Unidentified deposit";
            return {
                merchant: descriptor,
                amount_cents: Math.abs(movement.amount_cents),
                date,
                currency: movement.currency,
                account_id: source.id,
                account_name: source.name,
                budget_id: budgetId,
                action: "insert",
                payee_name: "Misc",
                category_id: null,
                raw_description: descriptor,
                raw_merchant_descriptor: "",
                notes: reference ? `Reference: ${reference.slice(0, 120)}` : "",
                reasoning: "Deterministic one-sided bank deposit",
                notify_message: "",
                _suffix_mappings: suffixMappings,
                _structured_movement: true,
                _payee_unresolved: true,
            };
        }

        // An incoming credit into one of the holder's own tracked accounts: a
        // received transfer is its own transfer, not income (issue #680). The
        // DBS/Trust received body names the sender only as a holder name with no
        // bank or suffix, so the far (debited) account is unknowable from this
        // alert alone; `resolveMovementAccounts` sets `source = other || own =
        // own = destination`. So this books the CREDITED leg on the credited
        // account as a plain `Misc` row with NO transfer payee and NO `_transfer`.
        // That is exactly the shape `find_link_candidate` recognises, so the
        // existing #598 pairing machinery links it to the outgoing leg from the
        // outgoing side (`_findExistingFarSide` at :2032). Setting a transfer
        // payee here would make Actual create its own counterpart at insert and
        // the row would then be skipped. Placed AFTER the one-sided deposit
        // branch (:1004) so a `!counterparty` credit keeps booking
        // "Unidentified deposit" (`bank-movement.test.js:1035`), and after the
        // person hold (:913) and the internal arm (:949) so a person/unverified
        // credit keeps its hold and an own-to-own leg keeps its pairing.
        //
        // Scoped to exclude every person-FLAGGED movement (`person_transfer ===
        // true`), not just the unreleased ones. A released person credit (one a
        // `maps to … payee` fact frees) is the #654 boundary the repository
        // deliberately leaves open: `production-incidents.test.js:857` pins that
        // it is still DROPPED, and the comment there says closing it "is its own
        // change with its own reproduction". An arm gated only on `destination`
        // would book it and silently widen a pinned boundary. So a FLAGGED
        // incoming person credit keeps its hold (:913) or its drop (:870).
        //
        // The flag is set by the Ryt parser branches (`bank-movement.js:309`
        // and `:355`) and by the LLM-extractor route (`orchestrator.js:1311`);
        // the DBS/OCBC branches build their movement through `baseMovement`
        // (`bank-movement.js:170`), which never sets it. So this guard covers
        // exactly the pinned #654 boundary and every route that flags a person,
        // and nothing wider. A person-NAMED
        // credit on another rail carries no flag and books as the broad-arm
        // `Misc` below — the deliberate convention this change adopts for every
        // named inbound credit, because gating on the counterparty's identity
        // would leave an external named credit falling to `return null` (:1172)
        // and re-open the endless re-fetch loop #680 exists to close.
        //
        // `_is_paynow` is deliberately NOT propagated (code review round 1, M1).
        // This credit has already been resolved onto a KNOWN own account, so the
        // PayNow identity re-check in Phase 2 (:2167) can only refuse it: it would
        // set `_hold_unresolved_paynow` (:2257), whose branch (:2659) notifies and
        // logs but never calls `mark_email_read`, leaving the alert to be
        // re-fetched unseen forever (`imap.js:86`) — the exact loop this change
        // removes. PayNow is a payment rail, not a reason to distrust an
        // already-resolved credited leg.
        if (
            movement.direction === "incoming" &&
            destination &&
            date &&
            movement.counterparty &&
            (movement.person_transfer !== true || ownCreditDebit)
        ) {
            const namedFrom = movement.counterparty?.name || "an unverified counterparty";
            // Money from a person: memory first, then Jev reading the email
            // alone (a person's name is never web-searched). An owner rule for
            // this sender AND this amount names the payee and category. A sender
            // with any amount rule gets nothing from their plain name fact;
            // otherwise that fact names the payee. With neither, Jev decides and
            // `Misc` is the answer when it cannot. A credit that is the far leg
            // of the holder's own transfer keeps its Misc pairing shape.
            const person = !ownCreditDebit && !knownOwnIdentity && movement.counterparty?.name;
            const personFacts = person ? await this._personEntityFacts() : [];
            const rule = person
                ? incomingRule(personFacts, {
                      name: movement.counterparty.name,
                      currency: movement.currency,
                      amountCents: movement.amount_cents,
                  })
                : null;
            const remembered = person && !rule ? incomingPersonMemory(personFacts, movement.counterparty.name) : null;
            const resolvedPerson = rule
                ? { payee_name: rule.payee, payee_source: "incoming_rule", _incoming_rule_category: rule.category }
                : remembered?.payee
                  ? { payee_name: remembered.payee, payee_source: "memory" }
                  : person
                    ? { _payee_unresolved: true, _no_search: true, _no_memory: true }
                    : {};
            return {
                merchant: namedFrom,
                amount_cents: Math.abs(movement.amount_cents),
                date,
                currency: movement.currency,
                account_id: destination.id,
                account_name: destination.name,
                budget_id: budgetId,
                action: "insert",
                payee_name: "Misc",
                category_id: null,
                raw_description: `Transfer from ${namedFrom}`,
                raw_merchant_descriptor: "",
                notes: movement.reference_number ? `Statement: ${movement.reference_number}` : "",
                reasoning: "Deterministic incoming bank credit",
                notify_message: "",
                _suffix_mappings: suffixMappings,
                _structured_movement: true,
                ...resolvedPerson,
                ...(person ? { _incoming_person: true } : {}),
                // A masked self-transfer debit booked first waits for this credit
                // (see `_resolveMaskedSelfTransfer`).
                _pair_other_accounts: ownCreditDebit
                    ? [ownCreditDebit.account_id]
                    : rule || remembered?.payee
                      ? []
                      : accounts.filter((a) => !a.closed && a.id !== destination.id).map((a) => a.id),
                // The own-name credit's debit was found untagged (#796).
                ...(ownCreditDebit ? { _pair_untagged: true } : {}),
            };
        }

        if (movement.direction === "outgoing" && movement.masked_payee === true && !destination) {
            return this._resolveMaskedSelfTransfer(movement, {
                accounts, source, budgetId, date, suffixMappings,
            });
        }

        if (movement.direction === "outgoing") {
            const named = movement.counterparty?.name;
            // An outgoing movement naming an account by its masked suffix that
            // does NOT resolve to any of the user's own accounts is the other
            // half of the #592 defect: the destination could not be verified as
            // one of the holder's accounts, so booking the name as a merchant
            // invents a payment that may in fact be the holder's own transfer.
            // Held as Misc with no category instead — the payee is never guessed
            // and no expense is recorded. Issue #592, #598.
            //
            // A destination the alert itself calls a CREDIT CARD is the one
            // exception: a bill payment into a card is a card repayment, not a
            // possible own-account transfer, and it must not be held. The three
            // production rows of 2026-10-01 (uid 1025/1026/1027, "Successful
            // bill payment" to CITI/HSBC/UOB CREDIT CARDS) were all held here
            // and notified to the user, because the destination card is a real
            // card the tracker has no account for. The bank's own word for the
            // destination is used, so nothing is inferred about an unnamed
            // counterparty.
            const unverifiedDestination =
                !resolved.destination_account &&
                Boolean(movement.counterparty?.suffix);
            const destinationIsCardProduct = CARD_PRODUCT_RE.test(named || "");
            if (unverifiedDestination && !destinationIsCardProduct) {
                return {
                    merchant: named || "Bank transfer",
                    amount_cents: -Math.abs(movement.amount_cents),
                    date,
                    currency: movement.currency,
                    account_id: source.id,
                    account_name: source.name,
                    budget_id: budgetId,
                    action: "insert",
                    payee_name: "Misc",
                    category_id: null,
                    raw_description: `Transfer to ${named || "an unverified account"}`,
                    raw_merchant_descriptor: "",
                    notes: movement.reference_number ? `Statement: ${movement.reference_number}` : "",
                    reasoning: "Held: destination account could not be verified as one of yours",
                    notify_message: "",
                    _suffix_mappings: suffixMappings,
                    _hold_unresolved_transfer: true,
                    _hold_cause: "destination_unresolved",
                };
            }
            return {
                merchant: movement.merchant_display_name || movement.counterparty?.name || "Bank payment",
                amount_cents: -Math.abs(movement.amount_cents),
                date,
                currency: movement.currency,
                account_id: source.id,
                account_name: source.name,
                budget_id: budgetId,
                action: "insert",
                payee_name: "",
                category_id: null,
                raw_description: movement.merchant_display_name || movement.counterparty?.name || "Bank payment",
                raw_merchant_descriptor: movement.raw_merchant_descriptor || "",
                notes: movement.reference_number ? `Statement: ${movement.reference_number}` : "",
                reasoning: "Deterministic external bank payment",
                notify_message: "",
                _suffix_mappings: suffixMappings,
                // A destination the alert names as a card is a repayment into
                // the holder's own credit line: it must never be categorised as
                // spend on the funding account.
                _card_repayment: destinationIsCardProduct || undefined,
                _structured_movement: true,
                _is_paynow: movement.is_paynow === true,
                _paynow_merchant: movement.is_paynow_merchant === true,
            };
        }
        return null;
    }

    /**
     * An outgoing alert whose payee is masked (Trust shows "ABCXX DEXX") and
     * names no account. The name cannot be told from the holder's own, so the
     * evidence is the other leg: exactly one unlinked, uncleared `Misc` credit
     * of the same amount that day on another own account makes it that
     * account's transfer. With no credit yet, the debit is booked as `Misc`
     * tagged for the credit to find (`_pairWaitingDebit`); several candidates or
     * an unreadable account hold, since a guess would link the wrong rows.
     */
    async _resolveMaskedSelfTransfer(movement, { accounts, source, budgetId, date, suffixMappings }) {
        const amount = Math.abs(movement.amount_cents);
        const name = movement.counterparty?.name || "an unverified account";
        const hold = (reasoning) => ({
            merchant: name,
            amount_cents: -amount,
            date,
            currency: movement.currency,
            account_id: source.id,
            account_name: source.name,
            budget_id: budgetId,
            action: "insert",
            payee_name: "Misc",
            category_id: null,
            raw_description: `Transfer to ${name}`,
            raw_merchant_descriptor: "",
            notes: "",
            reasoning,
            notify_message: "",
            _suffix_mappings: suffixMappings,
            _hold_unresolved_transfer: true,
            _hold_cause: "destination_unresolved",
        });
        const others = accounts.filter((a) => !a.closed && a.id !== source.id);
        const farAccounts = [];
        for (const account of others) {
            const found = await this._tools.executeTool("find_link_candidate", {
                budget_id: budgetId,
                account_id: account.id,
                amount_cents: -amount,
                on_date: date,
            });
            if (found?.matches == null) return hold("Held: could not read every account for the matching credit");
            if (found.candidate && found.candidate.account_id === account.id) farAccounts.push(account);
            else if (Number(found.matches) > 1 || Number(found.unmatched) > 0) {
                return hold("Held: more than one possible credit for this masked transfer");
            }
        }
        if (farAccounts.length > 1) return hold("Held: more than one account has a matching credit");
        if (farAccounts.length === 1) {
            const far = farAccounts[0];
            return this._resolveMovementToOutput({
                ...movement,
                masked_payee: false,
                counterparty: { name: far.name, bank: bankFromText(far.name), suffix: null },
            });
        }
        return {
            merchant: name,
            amount_cents: -amount,
            date,
            currency: movement.currency,
            account_id: source.id,
            account_name: source.name,
            budget_id: budgetId,
            action: "insert",
            payee_name: "Misc",
            category_id: null,
            raw_description: `Transfer to ${name}`,
            raw_merchant_descriptor: "",
            notes: SELF_TRANSFER_TAG,
            reasoning: "Masked payee with no matching credit yet: booked as Misc to be linked when the credit arrives",
            notify_message: "",
            _suffix_mappings: suffixMappings,
            _structured_movement: true,
        };
    }

    /**
     * The other leg of a credit from the holder's own name (#796): `{booked}`
     * when the transfer journal already holds it, `{debit}` when exactly one
     * unlinked `Misc` debit of the amount that day sits on another own account,
     * else null (none, several, or an account that could not be read).
     */
    async _findOwnTransferCounterpart({ movement, destination, accounts, budgetId, date }) {
        const amount = Math.abs(Number(movement.amount_cents));
        const leg = await this._findBookedTransferLeg({
            budget_id: budgetId,
            account_id: destination.id,
            amount_cents: amount,
            currency: movement.currency,
            occurred_at: movement.occurred_at,
        });
        if (leg) return { booked: leg };
        // Booked and linked outside the journal (an older run, or by hand):
        // the credit already sits on this account as one leg of a transfer.
        const days = Math.ceil((Date.now() - new Date(`${date}T00:00:00Z`).getTime()) / 86400000) + 2;
        const rows = await this._tools.executeTool("fetch_recent_transactions", {
            budget_id: budgetId,
            account_id: destination.id,
            days: Math.max(days, 2),
        });
        const linkedCredit = (Array.isArray(rows) ? rows : []).find(
            (row) =>
                row.account === destination.id &&
                row.amount === amount &&
                String(row.date).slice(0, 10) === date &&
                row.transfer_id,
        );
        if (linkedCredit) return { booked: linkedCredit };
        const found = [];
        for (const account of accounts) {
            if (account.closed || account.id === destination.id) continue;
            const result = await this._tools.executeTool("find_link_candidate", {
                budget_id: budgetId,
                account_id: account.id,
                amount_cents: amount,
                on_date: date,
            });
            if (result?.matches == null || result.unmatched) return null;
            if (result.candidate) found.push(result.candidate);
        }
        return found.length === 1 ? { debit: found[0] } : null;
    }

    /**
     * After a transfer leg is booked, link it to the other leg that was booked
     * first and is waiting. For a credit that is a debit tagged as a possible
     * own transfer (`SELF_TRANSFER_TAG`); for an own-name debit (and the #796
     * credit) it is an untagged own-name `Misc` row. Only an unlinked,
     * uncleared `Misc` row of the same amount that day, on exactly one other
     * account, is joined; anything else is left alone.
     */
    async _pairWaitingDebit({ llmOutput, creditRowId: bookedRowId }) {
        if (!bookedRowId || !llmOutput.budget_id || !llmOutput.date) return false;
        try {
            // Signed like the booked leg: find_link_candidate looks for the
            // opposite sign, so a debit finds its waiting credit.
            const outgoing = Number(llmOutput.amount_cents) < 0;
            const amount = (outgoing ? -1 : 1) * Math.abs(Number(llmOutput.amount_cents));
            const found = [];
            for (const accountId of llmOutput._pair_other_accounts || []) {
                const result = await this._tools.executeTool("find_link_candidate", {
                    budget_id: llmOutput.budget_id,
                    account_id: accountId,
                    amount_cents: amount,
                    on_date: llmOutput.date,
                    notes_contains: llmOutput._pair_untagged ? undefined : SELF_TRANSFER_TAG,
                });
                // Several rows on one account is a question for the user.
                if (result?.matches == null || Number(result.matches) > 1) return false;
                if (result.candidate) found.push(result.candidate);
            }
            if (found.length !== 1) return false;
            const linked = await this._tools.executeTool("link_transfer_pair", {
                budget_id: llmOutput.budget_id,
                outgoing_id: outgoing ? bookedRowId : found[0].id,
                incoming_id: outgoing ? found[0].id : bookedRowId,
            });
            if (!linked || linked.error) return false;
            await this._tools.executeTool("log_decision", {
                action: "transfer_pair_linked",
                reasoning: outgoing
                    ? `Joined the debit to the waiting credit ${found[0].id}`
                    : `Joined the credit to the waiting debit ${found[0].id}`,
                timestamp: new Date().toISOString(),
            });
            return true;
        } catch (error) {
            logger.warn({ event: "pair_waiting_debit_failed", error: error.message });
            return false;
        }
    }

    /**
     * Resolve a parser-flagged card repayment that names no account. Returns a
     * transfer booked on the funding account, or a destination_unresolved hold.
     */
    async _resolveCardRepaymentMovement(movement, { accounts, budgetId, date, suffixMappings, payees }) {
        const bank = movement.own_account?.bank;
        const atBank = accounts.filter(
            (account) => !account.closed && bankFromText(account.name) === bank,
        );
        const typed = await Promise.all(
            atBank.map(async (account) => ({
                account,
                isCard: (await this._detectAccountType(account.name)) === "credit card",
            })),
        );
        const cards = typed.filter((t) => t.isCard).map((t) => t.account);
        const cashAccounts = typed.filter((t) => !t.isCard).map((t) => t.account);
        const card = cards.length === 1 ? cards[0] : null;
        const cardPayee = card
            ? payees.find((payee) => payee.transfer_acct === card.id) || null
            : null;
        const amount = Math.abs(movement.amount_cents);
        let funding = null;
        if (card && cardPayee) {
            // (a) a journal leg the other side already booked into the card
            const leg = await this._findBookedTransferLeg({
                budget_id: budgetId,
                account_id: card.id,
                amount_cents: amount,
                currency: movement.currency,
                occurred_at: movement.occurred_at,
            });
            if (leg) {
                // A booked leg is authoritative: an unusable source holds
                // rather than falling back, or the pair is booked twice.
                funding = accounts.find((a) => a.id === leg.source_account_id && !a.closed) || null;
            } else if (cashAccounts.length === 1) {
                // (b) the holder's only open cash account at this bank
                funding = cashAccounts[0];
            }
        }
        if (!card || !cardPayee || !funding || funding.id === card.id) {
            return {
                merchant: movement.counterparty?.name || "Credit card repayment",
                amount_cents: -amount,
                date,
                currency: movement.currency,
                account_id: "",
                account_name: "",
                budget_id: budgetId,
                action: "insert",
                payee_name: "Misc",
                category_id: null,
                raw_description: `Transfer to ${movement.counterparty?.name || "an unverified account"}`,
                raw_merchant_descriptor: "",
                notes: "",
                reasoning: "Held: card repayment could not be matched to exactly one own card and funding account",
                notify_message: "",
                _suffix_mappings: suffixMappings,
                _hold_unresolved_transfer: true,
                _hold_cause: "destination_unresolved",
            };
        }
        return {
            merchant: card.name,
            amount_cents: -amount,
            date,
            currency: movement.currency,
            account_id: funding.id,
            account_name: funding.name,
            budget_id: budgetId,
            action: "insert",
            payee_name: card.name,
            payee_id: cardPayee.id,
            category_id: null,
            raw_description: `Transfer to ${card.name}`,
            raw_merchant_descriptor: "",
            notes: "",
            reasoning: "Deterministic card repayment to the holder's own card",
            notify_message: "",
            _suffix_mappings: suffixMappings,
            _structured_movement: true,
            _is_transfer: true,
            _card_repayment: true,
            _transfer: {
                budget_id: budgetId,
                source_account_id: funding.id,
                destination_account_id: card.id,
                currency: movement.currency,
                amount_cents: amount,
                occurred_at: movement.occurred_at,
                payee_id: cardPayee.id,
            },
        };
    }

    /**
     * Collect (suffix, accountName) pairs confirmed by a name-digit match:
     * the account's own name embeds the suffix digits and matches the bank.
     * These are new ground-truth facts worth persisting — unlike memory-fact
     * resolution, whose mapping is already stored.
     */
    _collectSuffixMappings(movement, resolved, accounts, mappings) {
        const pairs = [];
        const seen = new Set();
        // The identity store is only available on the orchestrator path. Callers
        // that pass just (movement, resolved) keep the original strict
        // name-digit behaviour: no learning without the store to check against.
        const hasStore = mappings?.suffix instanceof Map;
        const accountList = Array.isArray(accounts) ? accounts : [];
        const consider = (account, evidence) => {
            const value = evidence?.suffix;
            if (!account || !value) return;
            if (!/^\d{4,6}$/.test(String(value))) return;
            if (seen.has(value)) return;
            // A suffix that already has a stored mapping is not learned again:
            // that fact IS the evidence, so re-deriving it adds nothing. This
            // also keeps a memory-fact-only resolution from being re-learned
            // from the alias that same fact created, and never overwrites a
            // conflicting mapping from a weaker signal.
            if (hasStore && mappings.suffix.has(value)) return;
            // Strict: the suffix must be one of the account's own name digits.
            // Containment (a suffix that merely tails those digits) is NOT
            // enough — see "does not learn a suffix that only tails
            // account-name digits".
            const accountDigits = [...account.name.matchAll(/\d{4,}/g)].map((match) => match[0]);
            const exact = accountDigits.some((digits) => digits === value);
            // An account whose NAME carries no digits at all but which is
            // reached by a written name resolving to it ("Darren POSB" ->
            // POSB Cashback, issue #598) is not `accountMatches`-provable: that
            // check requires digits in the name. The mapping is exactly what
            // turns the next alert of the same kind into a resolvable transfer,
            // so it is kept when the written name resolves to this single live
            // account. An account whose name DOES carry digits must match them,
            // so no weaker signal can ever overwrite a stronger one.
            const claimedByOther = accountList.some(
                (other) =>
                    other?.id !== account.id &&
                    [...(other?.name || "").matchAll(/\d{4,}/g)].some(
                        (match) => match[0] === value,
                    ),
            );
            const nameExclusive =
                hasStore &&
                accountDigits.length === 0 &&
                !claimedByOther &&
                evidence?.name &&
                matchAccountByName(evidence.name, accountList, mappings.aliases).id === account.id;
            if (!exact && !nameExclusive) return;
            seen.add(value);
            pairs.push({ suffix: value, accountName: account.name });
        };
        // Source/destination are `own`/`other` swapped by direction. Only
        // learn a suffix→account fact when the suffix belongs to the user's
        // own account — never an external counterparty.
        if (movement.direction === "outgoing") {
            // source = own (always safe); destination = counterparty, which is
            // the user's own account only on an internal transfer (confirmed
            // by a transfer payee), never an external merchant.
            consider(resolved.source_account, movement.own_account);
            if (resolved.internal) consider(resolved.destination_account, movement.counterparty);
        } else {
            // incoming: the counterparty is an external sender — never learn
            // its suffix. The own account is the recipient (destination).
            consider(resolved.destination_account, movement.own_account);
        }
        return pairs;
    }

    async _llmExtractMovement(emailText, senderBank, receivedAt) {
        const prompt = getMovementExtractorPrompt();
        try {
            const response = await this._chat(
                [{ role: "user", content: `${prompt}\n\nEMAIL:\n${String(emailText).slice(0, 4000)}` }],
                undefined,
                undefined,
                { reasoning: "disabled", temperature: 0 },
            );
            const content = (response.choices || [{}])[0].message?.content || "";
            const parsed = this._parseJsonFromContent(content);
            // Number() alone would turn null, "", true, [500] and "1e3" into
            // bookable figures, so accept only a real number or a plain
            // decimal string before falling through to the finite check (#508).
            const rawAmount = parsed?.amount;
            const amount =
                typeof rawAmount === "number" ||
                (typeof rawAmount === "string" &&
                    /^-?\d+(\.\d+)?$/.test(rawAmount.trim()))
                    ? Number(rawAmount)
                    : NaN;
            const currency = String(parsed?.currency || "").toUpperCase();
            const direction = parsed?.direction === "incoming" ? "incoming" : "outgoing";
            if (!Number.isFinite(amount) || !["SGD", "MYR"].includes(currency)) return null;
            const occurredAt = parsed?.occurred_at ? new Date(parsed.occurred_at).toISOString() : "";
            const from = String(parsed?.from_account || "").trim();
            const to = String(parsed?.to_account || "").trim();
            if (!occurredAt || (!from && !to)) return null;
            // The person/business flag must exist BEFORE _resolveMovementToOutput
            // reads it, and it must key on the side that is actually the OTHER
            // party to the money. This route assigns `own_account` from
            // `from_account` and `counterparty` from `to_account` UNCONDITIONALLY
            // (below), and the extractor prompt defines `to_account` as the
            // DESTINATION — which on an incoming movement is the holder's OWN
            // account. Keying on `to` for both directions therefore flagged real
            // incoming credits as person transfers (looksLikePersonName accepts
            // "Main Account", "Ryt Credit", "POSB Cashback Account"). So: the
            // destination on an outgoing movement, the source on an incoming one.
            //
            // These two assignments are load-bearing for BOOKING, not just for
            // this flag, and they are NOT the same convention the deterministic
            // parser uses: `resolveMovementAccounts` derives the booked account
            // from `counterparty` on an incoming movement (`source = other || own`)
            // and detects an own-to-own leg from `own !== counterparty`. Assigning
            // them by "holder side / other side" instead swaps both — an incoming
            // credit then books to the account the money LEFT (measured: an
            // incoming Ryt Savings -> Ryt Bank leg booked `ryt-savings` instead of
            // `ryt-bank`) and stops being recognised as internal. So the flag is
            // keyed per direction here rather than the fields being realigned.
            const namedParty = direction === "outgoing" ? to : from;
            const movement = {
                kind: "bank_movement",
                direction,
                amount_cents: cents(currency, amount, direction),
                currency,
                occurred_at: occurredAt,
                own_account: from ? { name: from, bank: senderBank, suffix: suffix(from) } : null,
                counterparty: to ? { name: to, bank: bankFromText(to), suffix: suffix(to) } : null,
                // Keyed on the party that is genuinely the other side for THIS
                // direction. No account-name suppression: `matchAccountByName`
                // matches on token containment, so it silently released genuine
                // person transfers (a person name "WEI LING" resolved to an account
                // "Wei Ling Savings"), and an account list is not in scope here.
                person_transfer: looksLikePersonName(namedParty),
                reference_number: String(parsed?.reference || ""),
                recipient_bank: direction === "incoming" ? senderBank : null,
                merchant_display_name: String(parsed?.merchant || ""),
                raw_merchant_descriptor: String(parsed?.merchant || ""),
            };
            return this._resolveMovementToOutput(movement);
        } catch (error) {
            if (error instanceof LLMUnavailableError) throw error;
            return null;
        }
    }

    async _runLegacyBillPaymentMovement(emailText, senderBank, receivedAt) {
        // Compatibility extractor for DBS-style bill alerts which do not carry
        // enough date/time fields for parseBankMovement(). Account resolution
        // remains centralized in _resolveMovementToOutput().
        const match = String(emailText || "").match(/Amount:\s*(SGD|MYR)\s+([\d,.]+)[\s\S]*?From:\s*(.+?)\s*\(A\/C\s+ending\s+(\S+)\)[\s\S]*?To:\s*(.+?)\s*\(Ref\s+ending\s+(\S+)\)/i);
        if (!match || !senderBank) return null;

        const currency = match[1].toUpperCase() === "MYR" ? "MYR" : "SGD";
        const amountCents = cents(currency, match[2], "outgoing");
        if (amountCents === null) return null;

        return this._resolveMovementToOutput({
            kind: "bank_movement",
            direction: "outgoing",
            amount_cents: amountCents,
            currency,
            occurred_at: receivedAt || new Date().toISOString(),
            own_account: { name: match[3].trim(), bank: senderBank, suffix: match[4] },
            counterparty: { name: match[5].trim(), bank: bankFromText(match[5]), suffix: match[6] },
            reference_number: "",
            merchant_display_name: match[5].trim(),
            raw_merchant_descriptor: "",
        }, { allowSuffixLearning: true });
    }

    /**
     * Null when every account of the sender bank is closed and the movement
     * output would still book on some account: no open account of that bank
     * exists, so the pick is another account. Holds and skips pass unchanged.
     */
    async _guardClosedSenderBank(output, senderBank) {
        if (!output || !senderBank || output.skip || !output.account_id) return output;
        if (output._hold_unresolved_transfer || output._hold_unresolved_paynow) return output;
        let accounts = [];
        try {
            const ctx = await this._tools.executeTool("fetch_context", { budget_id: output.budget_id });
            accounts = ctx?.accounts || [];
        } catch {
            return output;
        }
        const sameBank = accounts.filter((a) => nameMatchesBank(a.name, senderBank));
        if (sameBank.length === 0 || sameBank.some((a) => !a.closed)) return output;
        logger.warn({ event: "cross_bank_account_rejected", senderBank, sameBankOpen: false, sameBankAllClosed: true });
        return null;
    }

    async _runPhase1(emailText, { senderBank, receivedAt, linesText = "" } = {}) {
        try {
            const structured = await this._runStructuredMovement(emailText, senderBank, receivedAt, linesText);
            if (structured) return await this._guardClosedSenderBank(structured, senderBank);
        } catch (error) {
            logger.warn({ event: "structured_movement_failed", error: error.message });
        }

        try {
            const legacy = await this._runLegacyBillPaymentMovement(emailText, senderBank, receivedAt);
            if (legacy) return await this._guardClosedSenderBank(legacy, senderBank);
        } catch (error) {
            logger.warn({ event: "legacy_bill_payment_movement_failed", error: error.message });
        }

        // LLM-extractor fallback: parse fields via LLM, resolve accounts in code.
        // Only for bank-movement-shaped alerts (A/C/Ref ending, parenthesized
        // account, or a movement verb) — card purchase alerts keep going to the
        // full Phase-1 LLM.
        if (MOVEMENT_LIKE.test(emailText)) {
            const extracted = await this._llmExtractMovement(emailText, senderBank, receivedAt);
            if (extracted) return await this._guardClosedSenderBank(extracted, senderBank);
        }

        let prompt = getPhase1Prompt();

        // let (not const) — validation retries (continue) push feedback and
        // must preserve messages; error retries (catch) reset to clean state.
        let messages = [
            { role: "system", content: prompt },
            { role: "user", content: emailText },
        ];

        // 2 (not 1): the retry budget now defends against three independent
        // validation failure classes (amount/date, account_id, merchant)
        // plus thrown errors (timeout, truncated response) that reset the
        // conversation — 1 retry could exhaust on one failure class before
        // ever giving the LLM feedback on another.
        const MAX_RETRIES = 2;
        // Accumulates search_memory results the LLM retrieves via tool calls,
        // for deterministic post-validation (suffix override). Persists across
        // validation-retry attempts (facts do not change between attempts).
        const cachedSearchResults = [];
        let fallbackRan = false;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const tools = this._tools.getPhase1ToolSchemas
                ? this._tools.getPhase1ToolSchemas()
                : [];

            try {
                let response = await this._chat(messages, tools, "auto", {
                    reasoning: "low",
                });
                let choice = (response.choices || [{}])[0];
                let msg = choice.message || {};
                let cachedLiveData = null;

                // ── Bounded multi-round tool use ──
                // The LLM may call fetch_context and search_memory in any
                // order across rounds. Cap rounds and total calls to stop
                // runaway tool loops; on exhaustion demand JSON-only output.
                const TOOL_MAX_ROUNDS = 3;
                const TOOL_MAX_CALLS = 6;
                let toolRounds = 0;
                let toolCallsTotal = 0;

                while (msg.tool_calls && msg.tool_calls.length > 0) {
                    if (
                        toolRounds >= TOOL_MAX_ROUNDS ||
                        toolCallsTotal >= TOOL_MAX_CALLS ||
                        toolCallsTotal + msg.tool_calls.length > TOOL_MAX_CALLS
                    ) {
                        messages.push({
                            role: "user",
                            content:
                                "Tool budget exhausted. Respond ONLY with valid JSON now, no tool calls.",
                        });
                        response = await this._chat(
                            messages,
                            undefined,
                            undefined,
                            { reasoning: "low" },
                        );
                        choice = (response.choices || [{}])[0];
                        msg = choice.message || {};
                        break;
                    }
                    toolRounds++;

                    const assistantMsg = {
                        role: "assistant",
                        content: msg.content || null,
                        tool_calls: msg.tool_calls,
                    };
                    if (!assistantMsg.content) delete assistantMsg.content;
                    messages.push(assistantMsg);

                    for (const tc of msg.tool_calls) {
                        toolCallsTotal++;
                        const func = tc.function || {};
                        const name = func.name || "";
                        let args = {};
                        try {
                            args = JSON.parse(func.arguments || "{}");
                        } catch {}
                        let result = await this._tools.executeTool(
                            name,
                            args,
                        );
                        // search_memory results: redact secret-looking facts
                        // before the LLM sees them, then cache the survivors
                        // for deterministic post-validation (suffix override).
                        if (name === "search_memory") {
                            const safeResults = sanitizeResults(
                                result?.results,
                            );
                            result = { ...result, results: safeResults };
                            cachedSearchResults.push(...safeResults);
                        }
                        // Domain-based account pre-filter: restrict accounts
                        // to the sender's bank so the LLM cannot cross banks.
                        let filteredResult = result;
                        if (
                            name === "fetch_context" &&
                            senderBank &&
                            result?.accounts
                        ) {
                            // Token+alias bank match (POSB=DBS etc.) — no
                            // substring collisions ("SC" vs "Discover").
                            const filtered = result.accounts.filter(
                                (a) =>
                                    a.name &&
                                    nameMatchesBank(a.name, senderBank),
                            );
                            // Only restrict if at least one account matched the bank
                            if (filtered.length > 0) {
                                filteredResult = {
                                    ...result,
                                    accounts: filtered,
                                };
                                logger.info({
                                    event: "domain_account_filter",
                                    senderBank,
                                    total: result.accounts.length,
                                    filtered: filtered.length,
                                });
                            }
                        }
                        messages.push({
                            role: "tool",
                            tool_call_id: tc.id || "",
                            content: JSON.stringify(filteredResult),
                        });
                        if (name === "fetch_context") cachedLiveData = result;
                    }

                    response = await this._chat(messages, tools, "auto", {
                        reasoning: "low",
                    });
                    choice = (response.choices || [{}])[0];
                    msg = choice.message || {};
                }

                const content = msg.content || "";
                const llmOutput = this._parseJsonFromContent(content);

                if (!llmOutput) {
                    if (attempt < MAX_RETRIES) {
                        messages.push({
                            role: "user",
                            content:
                                "Respond ONLY with valid JSON. No markdown, no explanation.",
                        });
                        continue;
                    }
                    return null;
                }

                // Derive budget_id from currency. A foreign currency (#796)
                // names no budget: the charged card's budget does, as the LLM
                // chose it, and the amount is converted before returning.
                const currency = String(
                    llmOutput.currency || this._config.primaryCurrency,
                ).toUpperCase();
                const foreignCurrency =
                    currency !== this._config.primaryCurrency &&
                    currency !== this._config.secondaryCurrency;
                const budgetId = foreignCurrency
                    ? llmOutput.budget_id === this._config.secondaryBudgetFile
                        ? this._config.secondaryBudgetFile
                        : this._config.primaryBudgetFile
                    : currency === this._config.primaryCurrency
                        ? this._config.primaryBudgetFile
                        : this._config.secondaryBudgetFile;

                // Translate skip boolean to action
                const action = llmOutput.skip ? "skip" : "insert";

                const output = {
                    ...llmOutput,
                    budget_id: budgetId,
                    action,
                    payee_name: "",
                    category_id: "",
                    _is_paynow: /\bpaynow\b/i.test(emailText),
                    _paynow_merchant: /\bUnique Entity Number\b/i.test(emailText),
                    // The alert's send time, the tightest clock available for
                    // the transfer-journal lookup below (#574).
                    received_at: receivedAt || "",
                };
                // _suffix_mappings is set only by the deterministic
                // movement / bill-payment parsers. Strip any LLM-injected
                // field so untrusted Phase-1 output cannot persist a
                // fabricated suffix→account fact, and cannot claim a row was
                // structurally resolved when no parser resolved it:
                // `_structured_movement` drives two Phase-2 checks with
                // OPPOSITE polarity: it SKIPS the transfer-destination gate
                // (`!output._structured_movement && transferDestinationIsAmbiguous(...)`),
                // so a forged value books a transfer that gate would have
                // refused; and it is REQUIRED to ENABLE the schedule-collision
                // check, so a forged value only adds holds there. The material
                // risk is the skipped destination gate.
                delete output._suffix_mappings;
                delete output.payee_id;
                delete output._transfer;
                delete output._is_transfer;
                delete output._structured_movement;
                delete output._hold_unresolved_paynow;
                delete output._hold_unresolved_transfer;
                // `_hold_cause` chooses which held-row TEXT the notify branch
                // renders, so a forged value would put words in the user's
                // notification for a row the parser never produced. Stripped here
                // with its `_hold_*` siblings.
                delete output._hold_cause;
                // `_card_repayment` is set only by the deterministic movement
                // parser and read by the Phase-2 destination gate (it marks a
                // repayment into the holder's own credit line). Phase-1 LLM output
                // must not be able to assert it and skip that gate.
                delete output._card_repayment;
                // `_alert_id` keys the transfer-leg claim (issue #578); only the
                // email path sets it, after this sanitiser.
                delete output._alert_id;
                // An Amaze descriptor is fixed text, but the LLM reads it
                // differently run to run ("AMAZE", "ACMESHOP63"), so memory and
                // Jev saw a different merchant each time. Take it from the alert.
                const amaze = amazeDescriptor(emailText);
                if (amaze && !output.skip) {
                    output.merchant = amaze;
                    output.raw_merchant_descriptor = amaze;
                }

                // Date fallback: if the email body contains no recognisable
                // date and the LLM returned a date that differs from the day
                // the email was received, use that day. The received time, not
                // the wall clock: intake may process mail days late (#796).
                // MUST run before validation so the corrected date is checked.
                const receivedClock = receivedAt ? new Date(receivedAt) : new Date();
                const reference = Number.isNaN(receivedClock.getTime()) ? new Date() : receivedClock;
                const today = reference.toISOString().slice(0, 10);
                if (
                    output.date &&
                    output.date !== today &&
                    !this._emailBodyHasDate(emailText)
                ) {
                    logger.info({
                        event: "date_fallback",
                        llmDate: output.date,
                        overrideTo: today,
                    });
                    output.date = today;
                }

                // Validate amount and date
                const invalidFields = [];
                if (
                    llmOutput.amount_cents !== undefined &&
                    llmOutput.amount_cents !== null &&
                    llmOutput.amount_cents !== ""
                ) {
                    // Only the shapes the route books count as an amount; the
                    // rest ("1e3", "0x10", 1.5) are extraction failures and
                    // must be retried, not quietly reinterpreted downstream.
                    if (!isBookableAmountCents(llmOutput.amount_cents)) {
                        invalidFields.push("amount_cents");
                    }
                }
                if (output.date) {
                    const txDate = new Date(output.date);
                    const diffDays = Math.abs(
                        (reference - txDate) / (1000 * 60 * 60 * 24),
                    );
                    if (isNaN(txDate.getTime()) || diffDays > 15) {
                        invalidFields.push("date");
                    }
                }
                // A blank merchant on a real (non-skip) transaction usually
                // means extraction failed silently (e.g. a truncated
                // response) rather than the email genuinely having no
                // payee/beneficiary — force a retry instead of falling
                // through to Phase 2's "Misc" fallback with zero evidence.
                // Skip responses never populate merchant and must not be
                // penalized for it (see prompts.js rule 5).
                if (!output.skip && !String(output.merchant || "").trim()) {
                    invalidFields.push("merchant");
                }

                // Validate account — reuse cached fetch_context result if available
                let liveAccounts = [];
                if (!output.skip) {
                    try {
                        const liveData =
                            cachedLiveData ||
                            (await this._tools.executeTool("fetch_context", {
                                budget_id: budgetId,
                            }));
                        liveAccounts = liveData?.accounts || [];
                        if (output.account_id) {
                            const valid = liveAccounts.find(
                                (a) => a.id === output.account_id && !a.closed,
                            );
                            const sameBank = (a) =>
                                senderBank && nameMatchesBank(a.name, senderBank);
                            const sameBankOpen = liveAccounts.some(
                                (a) => !a.closed && sameBank(a),
                            );
                            // Every account of the sender bank is closed: any
                            // pick is some other account, named or not.
                            const sameBankAllClosed =
                                !sameBankOpen &&
                                liveAccounts.some((a) => a.closed && sameBank(a));
                            if (!valid) {
                                invalidFields.push("account_id");
                            } else if (
                                senderBank &&
                                (sameBankAllClosed ||
                                    (hasBankToken(valid.name) &&
                                        !nameMatchesBank(valid.name, senderBank)))
                            ) {
                                // Another bank's account. domain_account_filter
                                // lets this through when the sender bank has no
                                // named account; then no retry can find one, so
                                // hold instead of booking cross-bank.
                                logger.warn({
                                    event: "cross_bank_account_rejected",
                                    senderBank,
                                    sameBankOpen,
                                    sameBankAllClosed,
                                });
                                if (!sameBankOpen) return null;
                                invalidFields.push("account_id");
                            } else {
                                output.account_name = valid.name;
                            }
                        } else {
                            invalidFields.push("account_id");
                        }
                    } catch {
                        // fetch_context failed — skip account validation
                    }
                }

                // ── Fallback: deterministic suffix lookup when the cache
                // holds no USABLE suffix evidence (LLM searched wrong query,
                // or never searched) ──
                // Skipped without senderBank — bank unknown means a
                // deterministic override could book cross-bank. Skipped for
                // bill-payment layouts — destination suffix must never pick
                // the source account.
                if (
                    senderBank &&
                    !output.skip &&
                    output.account_id &&
                    !invalidFields.includes("account_id") &&
                    !fallbackRan &&
                    !BILL_PAYMENT_SHAPE_RE.test(emailText) &&
                    !hasUsableSuffixFact(
                        cachedSearchResults,
                        emailText,
                        senderBank,
                        liveAccounts,
                    )
                ) {
                    fallbackRan = true;
                    try {
                        const seen = new Set();
                        const FALLBACK_RE =
                            /\b(?:card|account|a\/c)\b[^\d]{0,25}?(\d{4,6})(?!\d)|\bending(?:\s+in)?\b[\s*#]*(\d{4,6})(?!\d)/gi;
                        let m;
                        while ((m = FALLBACK_RE.exec(emailText)) !== null) {
                            const suffix = (m[1] || m[2] || "").trim();
                            if (suffix && !seen.has(suffix)) {
                                seen.add(suffix);
                                const res = await this._tools.executeTool(
                                    "search_memory",
                                    { query: suffix },
                                );
                                cachedSearchResults.push(
                                    ...sanitizeResults(res?.results),
                                );
                            }
                            if (seen.size >= 3) break;
                        }
                    } catch {}
                }

                // ── Post-Phase-1 safety net: suffix-based account override ──
                // Uses search_memory results the LLM itself retrieved via tool
                // calls (or the deterministic fallback above). Overrides only
                // when evidence is UNIQUE, same-bank, high-score, and the
                // email is not a bill-payment layout. Without senderBank
                // (Telegram path) no deterministic override fires — a wrong
                // bank would be worse than no correction.
                if (
                    senderBank &&
                    !output.skip &&
                    output.account_id &&
                    !invalidFields.includes("account_id") &&
                    !BILL_PAYMENT_SHAPE_RE.test(emailText) &&
                    cachedSearchResults.length > 0 &&
                    liveAccounts.length > 0
                ) {
                    const candidates = new Map();
                    // Built once for the list, not per fact.
                    const suffixAliases = accountAliases(
                        cachedSearchResults,
                        liveAccounts,
                    );
                    for (const fact of cachedSearchResults) {
                        if ((fact.score ?? 0) < 0.5) continue;
                        const parsed = parseSuffixFact(fact.text);
                        if (!parsed) continue;
                        const { suffix } = parsed;
                        // Resolve the written name to a live account first, then
                        // apply the bank guard to the RESOLVED account. Keying
                        // the map on the account id (not the name) is what lets
                        // two spellings of one account still override.
                        const resolved = resolveFactAccount(
                            parsed.accountName,
                            liveAccounts,
                            suffixAliases,
                        );
                        if (!resolved || !resolved.matched) {
                            logger.info({
                                event: "suffix_fact_unresolved",
                                suffix,
                                account: parsed.accountName,
                            });
                            continue;
                        }
                        // Unknown-bank or cross-bank facts must never drive
                        // an override (brand aliases count as same-bank).
                        if (!nameMatchesBank(resolved.name, senderBank)) {
                            continue;
                        }
                        // Only facts whose suffix actually appears in this email
                        if (!new RegExp(`\\b${suffix}\\b`).test(emailText)) continue;
                        candidates.set(resolved.id, { suffix, match: resolved });
                    }
                    if (candidates.size === 1) {
                        const { suffix, match } = [...candidates.values()][0];
                        if (match.id !== output.account_id) {
                            logger.info({
                                event: "card_suffix_override",
                                suffix,
                                from: output.account_name,
                                to: match.name,
                            });
                            output.account_id = match.id;
                            output.account_name = match.name;
                        }
                    }
                }

                // Memory-aware account check: if account is valid but memory
                // suggests a different account for this merchant, force retry.
                // Skipped for movement-shaped alerts (bill payments, transfers):
                // the merchant is EXPECTED to name a different tracked account
                // (the destination, per rule 4b) there, so a memory fact naming
                // that account is not evidence of a wrong pick. Retrying would
                // also be unwinnable — domain_account_filter never shows the
                // LLM the destination account's id when it belongs to a
                // different bank than the sender.
                let memoryAccountHints = null;
                if (
                    !output.skip &&
                    output.account_id &&
                    !invalidFields.includes("account_id") &&
                    output.merchant &&
                    liveAccounts.length > 0 &&
                    !ACCOUNT_TRANSFER_SHAPE_RE.test(emailText)
                ) {
                    try {
                        const hints = await this._tools.executeTool(
                            "search_memory",
                            { query: output.merchant },
                        );
                        const relevant = sanitizeResults(
                            hints?.results,
                        ).filter((r) => r.score >= 0.5);
                        if (relevant.length > 0) {
                            const mentionsDifferent = relevant.some((r) => {
                                const text = (r.text || "").toLowerCase();
                                // A payee/category mapping names where the money
                                // goes (a transfer payee such as a loan account),
                                // not the account it left, so it is no evidence
                                // of a wrong source pick.
                                if (/\smaps\s+to\s.+\s(?:payee|category)\b/.test(text)) return false;
                                return liveAccounts.some(
                                    (a) =>
                                        a.id !== output.account_id &&
                                        !a.closed &&
                                        text.includes(a.name.toLowerCase()),
                                );
                            });
                            if (mentionsDifferent) {
                                invalidFields.push("account_id");
                                memoryAccountHints = relevant;
                                logger.info({
                                    event: "memory_account_override",
                                    merchant: output.merchant,
                                    currentAccount: output.account_name,
                                    hints: relevant.map((r) => r.text),
                                });
                            }
                        }
                    } catch {}
                }

                if (invalidFields.length > 0 && attempt < MAX_RETRIES) {
                    const feedback = invalidFields
                        .map((f) => {
                            if (f === "amount_cents")
                                return "amount_cents must be a valid integer";
                            if (f === "date")
                                return "date must be valid and within 15 days of the email's received date";
                            if (f === "merchant")
                                return "merchant is required — extract the payee/beneficiary name from the email body (e.g. a \"To:\" line or transaction description), even if account/date/amount were already correct";
                            if (f === "account_id") {
                                const names = liveAccounts
                                    .filter((a) => !a.closed)
                                    .map((a) => a.name)
                                    .join(", ");
                                if (memoryAccountHints) {
                                    return `Memory suggests a different account for "${output.merchant}". Available: [${names}]`;
                                }
                                return `account_id ${output.account_id || "(missing)"} not found or closed. Pick from: [${names}]`;
                            }
                            return f;
                        })
                        .join("; ");

                    // Account memory hints
                    let hintText = "";
                    if (
                        invalidFields.includes("account_id") &&
                        output.merchant
                    ) {
                        if (memoryAccountHints) {
                            hintText =
                                " Memory hints: " +
                                memoryAccountHints
                                    .map((r) => r.text)
                                    .join("; ");
                        } else {
                            try {
                                const hints = await this._tools.executeTool(
                                    "search_memory",
                                    {
                                        query: output.merchant + " account",
                                    },
                                );
                                const safeHints = sanitizeResults(
                                    hints?.results,
                                );
                                if (safeHints.length > 0) {
                                    hintText =
                                        " Memory hints: " +
                                        safeHints
                                            .map((r) => r.text)
                                            .join("; ");
                                }
                            } catch {}
                        }
                    }

                    messages.push({
                        role: "user",
                        content: `Fix these issues: ${feedback}.${hintText} Respond with valid JSON only.`,
                    });
                    continue;
                }

                // Retry exhausted with invalid fields — stop, don't return bad data
                if (invalidFields.length > 0) {
                    logger.warn({
                        event: "phase1_exhausted",
                        invalidFields,
                        merchant: output.merchant,
                    });
                    return null;
                }

                if (foreignCurrency && !output.skip) {
                    return await this._convertForeignCharge(output, currency);
                }
                return output;
            } catch (e) {
                // A provider outage is not a parse failure: surface it so the
                // email is retried instead of reported as not understood (#694).
                if (e instanceof LLMUnavailableError) throw e;
                logger.error({
                    event: "phase1_error",
                    error: e.message,
                    attempt,
                });
                if (attempt >= MAX_RETRIES) return null;
                // Reset messages — prevent stale tool_calls from failed
                // attempt corrupting the next retry's conversation state.
                messages = [
                    { role: "system", content: prompt },
                    { role: "user", content: emailText },
                ];
            }
        }

        return null;
    }

    // ═══════════════════════════════════════════════════════════════
    // Phase 2: Resolution (code-driven, LLM-assisted)
    // ═══════════════════════════════════════════════════════════════

    async _detectAccountType(accountName) {
        if (!accountName) return "bank";
        // Entity equality, not "first memory hit". search_memory returns every
        // substring hit at score 1.0 in file order, so returning the first
        // matching fact let an unrelated or stale fact line decide the account
        // type — and the type drives the credit-card sign flip, i.e. whether a
        // purchase is booked negative. Only a fact about THIS account counts.
        try {
            const mem = await this._tools.executeTool("search_memory", {
                query: accountName,
            });
            // Compare the fact's entity to this account with the SAME token
            // normaliser the resolver uses. Token overlap was wrong in both
            // directions before: a stored short form ("Epsilon Nova" against
            // "Epsilon Nova Card") was refused, losing the sign flip, while a
            // sibling sharing one generic word ("Zeta Bank" vs "Zeta Card",
            // both reducing to "zeta") could be accepted.
            const wanted = accountTokens(
                String(accountName).replace(/\s+account$/i, ""),
            );
            for (const r of mem?.results || []) {
                // Non-greedy type so an entity containing the word "card"
                // ("Epsilon Nova Card is a credit card") still parses intact; a
                // trailing filler "account" is stripped from the TYPE below.
                const m = (r.text || "").match(
                    /^(.+?)\s+is\s+(?:a|an)\s+(.+?)(?:\s+account)?\s*$/i,
                );
                if (!m) continue;
                const entity = accountTokens(
                    m[1].replace(/\s+account$/i, ""),
                );
                if (!wanted.length || !entity.length) continue;
                const same =
                    entity.join(" ") === wanted.join(" ") ||
                    (entity.length >= 2 &&
                        wanted.length >= 2 &&
                        entity.filter((t) => wanted.includes(t)).length >= 2);
                if (!same) continue;
                return m[2].replace(/\s+account$/i, "").trim().toLowerCase();
            }
        } catch {}
        // Fallback: keyword match on account name
        // Exclude Visa Debit / Mastercard Debit — those are debit cards, not credit
        if (
            /visa|mastercard|credit\s*card|ecard/i.test(accountName) &&
            !/\bdebit\b/i.test(accountName)
        )
            return "credit card";
        return "bank";
    }

    /**
     * The transfer-journal leg for a credit the counterparty bank already
     * booked INTO this account, or null. Anchored on the alert's own event
     * time, then the email's send time: the alert and the booking are seconds
     * apart, and the date in the body can sit on the far side of a timezone
     * boundary (issue #574).
     */
    async _findBookedTransferLeg(output) {
        // The deterministic movement parser keeps its clock on `_transfer`, the
        // generic LLM branch on `received_at`, and a structured row may carry
        // its own `occurred_at`. Take the first real timestamp: a date-only
        // string parses as midnight UTC, which is not the alert's event time,
        // so a window anchored on it would miss the booked leg and re-arm the
        // false hold (issue #574 reviews).
        const at = [
            output.occurred_at,
            output.received_at,
            output._transfer?.occurred_at,
        ].find((value) => value && String(value).includes("T"));
        if (!at) return null;
        try {
            const leg = await this._tools.executeTool("find_inserted_transfer", {
                budget_id: output.budget_id || "",
                // A credit lands on the booked account, so it is the leg's
                // destination (issue #574 review: matching the source side too
                // would let an unrelated outgoing leg swallow a real credit).
                destination_account_id: output.account_id || "",
                alert_id: output._alert_id ?? null,
                amount_cents: output.amount_cents,
                currency: output.currency || this._config.primaryCurrency,
                at,
            });
            // Shape check: a partial row must not be read as proof that a
            // transfer is booked.
            return leg && leg.id && leg.source_account_id && leg.destination_account_id
                ? leg
                : null;
        } catch (error) {
            logger.warn({
                event: "find_inserted_transfer_failed",
                error: error.message,
            });
            return null;
        }
    }

    /**
     * The transfer's other leg, already sitting in Actual as an ordinary
     * uncategorised row, or a reason not to touch anything (#598).
     *
     * The two rows of the production incident were both `Misc` with no
     * category: one per leg, never linked. This is consulted BEFORE the near
     * leg is inserted, because that insert carries the destination's transfer
     * payee and the Actual route runs `runTransfers` unconditionally — which
     * links the new row to a freshly created counterpart. On a far side that
     * already exists, that leaves a duplicate counterpart and orphans the
     * pre-existing row: three rows where the incident had two (proven against
     * a real budget, issue #598 review round 1).
     *
     * Returns `{farRowId}` to join the existing row, `{hold: true}` when the
     * far side is ambiguous or unreadable and nothing may be written, or
     * `{farRowId: null}` when there is genuinely no far side and the normal
     * insert path is correct.
     */
    async _findExistingFarSide({ transfer, bookedAccountId, amountCents, date, budgetId }) {
        const farAccountId = transfer?.source_account_id === bookedAccountId
            ? transfer?.destination_account_id
            : transfer?.source_account_id;
        if (
            !transfer ||
            !budgetId ||
            !farAccountId ||
            farAccountId === bookedAccountId ||
            !date ||
            !isBookableAmountCents(amountCents)
        ) {
            return { farRowId: null };
        }
        try {
            const found = await this._tools.executeTool("find_link_candidate", {
                budget_id: budgetId,
                account_id: farAccountId,
                amount_cents: amountCents,
                on_date: date,
            });
            // The route must name the account the row sits on as well as the
            // row itself: an id alone is not proof the two legs are on
            // different accounts, and linking same-account rows is a data error.
            // A candidate on some other account is exactly that data error, so
            // it holds — degrading to "no far side" would book with the transfer
            // payee and recreate the duplicate counterpart (#598 review round 2).
            if (found?.candidate && found.candidate.account_id !== farAccountId) {
                logger.warn({
                    event: "far_side_candidate_wrong_account",
                    account_id: farAccountId,
                    candidate_account: found.candidate.account_id,
                });
                return { hold: true, reason: "unreadable" };
            }
            const farRowId = found?.candidate?.id || null;
            if (farRowId) return { farRowId, farAccountId };
            // `matches: null` means the read failed: an absent far side and an
            // unreadable one are not the same answer, and only one of them is
            // safe to book against.
            if (found?.matches == null) {
                logger.warn({ event: "far_side_unreadable", account_id: farAccountId });
                return { hold: true, reason: "unreadable" };
            }
            if (Number(found.matches) > 1) {
                logger.warn({
                    event: "far_side_ambiguous",
                    account_id: farAccountId,
                    matches: found.matches,
                });
                return { hold: true, reason: "ambiguous" };
            }
            if (Number(found.unmatched) > 0) {
                // A plausible far row exists but is not the exact shape (#619).
                logger.warn({
                    event: "far_side_unmatched",
                    account_id: farAccountId,
                    unmatched: found.unmatched,
                });
                return { hold: true, reason: "unmatched" };
            }
            return { farRowId: null };
        } catch (error) {
            logger.warn({ event: "find_existing_far_side_failed", error: error.message });
            return { hold: true, reason: "unreadable" };
        }
    }

    /**
     * Join the near leg to the far side that is already booked, through the
     * actual-api link route (#598). Both legs must be unlinked for the route to
     * accept the pair, which is exactly why this runs instead of an insert that
     * creates its own counterpart.
     */
    async _linkExistingFarSide({ transfer, budgetId, farRowId, bookedRowId, amountCents }) {
        if (!budgetId || !farRowId || !bookedRowId || !transfer) return false;
        try {
            // The out leg is the debit whichever side of the transfer the row
            // just booked landed on.
            const outgoingId = Number(amountCents) < 0 ? bookedRowId : farRowId;
            const incomingId = Number(amountCents) < 0 ? farRowId : bookedRowId;
            const linked = await this._tools.executeTool("link_transfer_pair", {
                budget_id: budgetId,
                outgoing_id: outgoingId,
                incoming_id: incomingId,
            });
            if (!linked || linked.error) {
                logger.warn({
                    event: "link_transfer_pair_failed",
                    error: linked?.error || "unknown",
                });
                return false;
            }
            await this._tools.executeTool("log_decision", {
                action: "transfer_pair_linked",
                reasoning: `Joined the existing row ${farRowId} to the booked transfer`,
                timestamp: new Date().toISOString(),
            });
            return true;
        } catch (error) {
            // A failed link must not fail a booked transfer; the rows are still
            // both present and correct, just unpaired.
            logger.warn({ event: "link_existing_far_side_failed", error: error.message });
            return false;
        }
    }

    async _resolvePhase2(phase1Output) {
        const output = {
            ...phase1Output,
            category_id: phase1Output.category_id || null,
        };

        // Sign correction: credit cards always flip to negative
        if (
            output.account_name &&
            isBookableAmountCents(output.amount_cents)
        ) {
            const acctType = await this._detectAccountType(output.account_name);
            if (acctType === "credit card") {
                // Number() here would reinterpret a malformed string ("1e3",
                // "0x10") into a bookable figure, so the guard above only lets
                // a value the route accepts reach this coercion.
                output.amount_cents = -Math.abs(Number(output.amount_cents));
                output._sign_flipped = true;
            }
        }

        // Step 1: Payee resolution
        // Derive search term: prefer merchant, fall back to raw_description
        // (which the LLM populates even when merchant is omitted), then notes.
        const searchTerm = (
            output.merchant ||
            output.raw_description ||
            output.notes ||
            ""
        ).trim();
        let cachedCtx = null;
        // Set when a live account matched, so the payee must survive to the
        // transfer lookup below instead of being replaced by a merchant.
        let paynowAccountMatched = false;
        // Set when the PayNow identity check has already decided the payee, so
        // the merchant tiers below must not override it.
        let paynowSettled = false;
        if (output._is_paynow && searchTerm) {
            // A credit is income unless it is a transfer, so it must never be
            // booked as a merchant or as an uncategorised positive inflow. A
            // debit is an ordinary payment and still has to reach its learned
            // merchant payee and the transfer lookup below. Review round 2 #561.
            const credit = Number(output.amount_cents) > 0;
            // Set when the counterparty is a mask of one of the user's own
            // accounts; it must never be looked up as a merchant. Set when the
            // counterparty is not a known merchant, so a credit from it is held
            // rather than booked. A debit is only saved by an exact learned key.
            let selfMasked = false;
            let unresolved = false;
            try {
                cachedCtx =
                    (await this._tools.executeTool("fetch_context", {
                        budget_id: output.budget_id || "",
                    })) || {};
                const accounts = Array.isArray(cachedCtx.accounts)
                    ? cachedCtx.accounts
                    : [];
                const facts =
                    (await this._tools.executeTool("list_facts", {}))?.facts ||
                    [];
                const aliases = accountAliases(facts, accounts);
                // The mask test runs first: the account matcher compares token
                // sets, so a mask like "T*** B***" can reach a live account
                // through one surviving token and be mistaken for a name.
                if (masksOwnAccount(searchTerm, accounts, aliases)) {
                    selfMasked = true;
                    unresolved = true;
                } else {
                    const account = matchAccountByName(
                        searchTerm,
                        accounts,
                        aliases,
                    );
                    if (account.matched) {
                        output.payee_name = account.name;
                        output.payee_source = "self_identity";
                        paynowAccountMatched = true;
                    } else if (!output._paynow_merchant) {
                        unresolved = true;
                    }
                }
            } catch (error) {
                logger.warn({ event: "paynow_identity_failed", merchant: searchTerm, budget_id: output.budget_id || "", error: error.message });
                unresolved = true;
            }
            // A recognised own account is only a transfer once the transfer
            // lookup below finds its payee; until then a credit from it is still
            // income and is held the same way an unresolved one is.
            if (credit && (unresolved || paynowAccountMatched)) {
                // Structured movement output already carries the resolved pair;
                // its own journal lookup is performed by Phase 3. Generic
                // PayNow output still needs the early duplicate check because
                // it has no deterministic transfer reservation yet.
                if (output._structured_movement && output._is_transfer) {
                    // Structured output is safe from the generic identity hold,
                    // but still checks the journal so an already-booked far leg
                    // is deduplicated before Phase 3.
                    const bookedLeg = await this._findBookedTransferLeg(output);
                    if (bookedLeg) {
                        output._transfer = {
                            ...(output._transfer || {}),
                            budget_id: bookedLeg.budget_id,
                            source_account_id: bookedLeg.source_account_id,
                            destination_account_id: bookedLeg.destination_account_id,
                            currency: bookedLeg.currency,
                            amount_cents: bookedLeg.amount_cents,
                            occurred_at: bookedLeg.occurred_at,
                        };
                    }
                } else {
                    // The counterparty bank's own email may already have booked
                    // this leg: the alert is then a duplicate of money already
                    // recorded, not an unresolved credit. Consult the journal
                    // before the hold is set (issue #574).
                    const bookedLeg = await this._findBookedTransferLeg(output);
                    if (bookedLeg) {
                        output._transfer = {
                            ...(output._transfer || {}),
                            budget_id: bookedLeg.budget_id,
                            source_account_id: bookedLeg.source_account_id,
                            destination_account_id: bookedLeg.destination_account_id,
                            currency: bookedLeg.currency,
                            amount_cents: bookedLeg.amount_cents,
                            occurred_at: bookedLeg.occurred_at,
                        };
                        output._is_transfer = true;
                    } else {
                        output._hold_unresolved_paynow = true;
                    }
                }
            }
            // A PayNow counterparty that is not a UEN merchant is a person: its
            // merchant tiers below still run, but never a web search.
            if (unresolved && !credit && !output._paynow_merchant) output._no_search = true;
            if (selfMasked || (unresolved && credit)) {
                // A masked self identity is a person, not a merchant key, and a
                // held credit must not be booked: both are Misc with no category.
                // An unresolved debit still gets its merchant tiers below.
                output.payee_name = "Misc";
                output.payee_source = "paynow_unresolved";
                paynowSettled = true;
            } else if (paynowAccountMatched) {
                // Keep the account payee for the transfer lookup below.
                paynowSettled = true;
            }
        }
        // A PayNow counterparty the identity check settled keeps that payee; the
        // transfer lookup below is what turns an account match into a transfer.
        // Everything else takes the merchant tiers. Review round 2 on #561.
        // A deterministic placeholder `Misc` is not a decision (#720): clear it so
        // the memory, resolver and Jev tiers below run, and fall back to `Misc`.
        if (output._payee_unresolved && !paynowSettled) output.payee_name = "";
        // A calibration dry run scores every Jev prompt on this alert before
        // memory decides, so alerts memory already knows are measured too.
        if (this._tools.calibrating?.() && searchTerm && output._evidence && !paynowSettled) {
            try {
                await this._tools.executeTool("calibrate_jev", {
                    merchant: searchTerm,
                    budget_id: output.budget_id || "",
                    evidence: output._evidence,
                    direction: Number(output.amount_cents) > 0 ? "incoming" : "outgoing",
                    amount_cents: output.amount_cents,
                    currency: output.currency,
                    as_of: output.date,
                    // A person is never searched, including one whose credit an
                    // amount rule already settled (and so carries no `_no_search`).
                    ...(output._no_search || output._incoming_person ? { no_search: true } : {}),
                });
            } catch (error) {
                logger.warn({ event: "jev_calibration_failed", error: error.message });
            }
        }
        // Memory hits for the merchant itself; the category tier reads them too.
        let memResults = [];
        if (!output.payee_name && searchTerm && !paynowSettled) {
            // An incoming person credit had its memory decided upstream.
            if (!output._no_memory) {
                try {
                    const memResult = await this._tools.executeTool(
                        "search_memory",
                        {
                            query: searchTerm,
                        },
                    );
                    memResults = memResult?.results || [];
                } catch {}
            }

            let payeeMatch = null;
            for (const r of memResults) {
                // Only a hit that actually names the merchant may supply its
                // payee. Without this, a same-shaped neighbour's mapping books
                // the neighbour's payee and then that payee's category. #471.
                if (!factNamesMerchant(r.text, searchTerm)) continue;
                const m = (r.text || "").match(/maps to (.+?) payee/i);
                if (m) {
                    payeeMatch = m[1];
                    break;
                }
            }

            if (payeeMatch) {
                output.payee_name = payeeMatch;
                output.payee_source = "memory";
            } else {
                try {
                    const resolved = await this._tools.executeTool(
                        "resolve_merchant",
                        {
                            merchant: searchTerm,
                            budget_id: output.budget_id || "",
                            ...(output._no_search ? { no_search: true } : {}),
                            ...(output._no_memory ? { no_memory: true } : {}),
                            // The email is untrusted evidence for the Jev tier
                            // only; the tool never learns from it (#720).
                            ...(output._evidence
                                ? {
                                      evidence: output._evidence,
                                      direction: Number(output.amount_cents) > 0 ? "incoming" : "outgoing",
                                      amount_cents: output.amount_cents,
                                      currency: output.currency,
                                  }
                                : {}),
                        },
                    );
                    // The same results are Jev's evidence for the category below.
                    if (resolved?.search) output._merchant_search = resolved.search;
                    // An offer still waiting for an answer carries its category.
                    if (resolved?.pending && resolved.category) output._pending_category = resolved.category;
                    if (resolved?.payee) {
                        output.payee_name = resolved.payee;
                        output.payee_source = resolved.source || "fallback";
                        if (resolved.source === "jev") {
                            output._jev = {
                                descriptor: searchTerm,
                                runnerUp: resolved.runner_up || null,
                                confidence: resolved.confidence ?? null,
                            };
                        }
                    }
                } catch (e) {
                    // resolve_merchant failed — leave payee blank, fall through to Misc
                    logger.warn({
                        event: "resolve_merchant_failed",
                        merchant: searchTerm,
                        error: e.message,
                    });
                }
            }
        }

        // Fallback
        if (!output.payee_name) {
            output.payee_name = "Misc";
            output.payee_source = "fallback";
        }

        // Transfer detection: if payee matches an account, use the transfer
        // payee (the one with transfer_acct set) so Actual Budget creates a
        // transfer instead of a regular expense.
        // Also caches fetch_context so category resolution below reuses it.
        // Structured parser output already has both account IDs and a transfer
        // payee. Do not re-derive its direction from the display name: for an
        // incoming credit the booked account is the destination, while the
        // transfer payee names the source. Re-running the generic gate here
        // misread that deliberate shape as a self-transfer and held it.
        if (
            !(output._structured_movement && output._is_transfer) &&
            output.payee_name &&
            output.payee_name !== "Misc"
        ) {
            try {
                cachedCtx =
                    cachedCtx ||
                    (await this._tools.executeTool("fetch_context", {
                        budget_id: output.budget_id || "",
                    })) || {};
                const liveAccounts = Array.isArray(cachedCtx.accounts)
                    ? cachedCtx.accounts
                    : [];
                const payees = Array.isArray(cachedCtx.payees) ? cachedCtx.payees : [];
                // The destination account, in order of evidence strength:
                //   1. the account the deterministic parser already resolved
                //      (`_transfer.destination_account_id`),
                //   2. the payee name resolved against the live account list.
                //
                // The account-id lookup matters because the alert names a card
                // by PRODUCT ("Altitude", "CITI CREDIT CARDS"), not by the
                // account's own name ("DBS Altitude Card"). The parser resolved
                // both legs from the trailing suffix, but re-deriving the
                // destination from the payee name alone found nothing, and the
                // `!accountMatch` arm below then refused a transfer whose
                // destination the pipeline had already verified — holding
                // both a card repayment and the card-to-card leg of an
                // own-account FAST transfer (uid 1031, uid 1025, 2026-10-01).
                // Reusing the resolved id keeps this gate about the
                // destination the alert establishes, not about how the bank
                // chose to spell it.
                const byId = output._transfer?.destination_account_id
                    ? liveAccounts.find(
                          (a) => a.id === output._transfer.destination_account_id,
                      ) || null
                    : null;
                // An explicit name match IS evidence, and a refusal is not:
                // `matchAccountByName` can refuse for a reason that means the
                // name is owned by a real account (closed, duplicated). Only a
                // genuine match may supply the destination.
                const byName = matchAccountByName(output.payee_name, liveAccounts);
                const accountMatch =
                    byId ||
                    (byName.matched
                        ? liveAccounts.find((a) => a.id === byName.id) || null
                        : null);
                const transferPayee = payees.find((payee) =>
                    payee.transfer_acct && (payee.transfer_acct === accountMatch?.id ||
                        payee.name?.toLowerCase() === output.payee_name.toLowerCase()),
                );
                // A product-named card repayment can use the learned payee
                // alias even when no matching account exists in this budget.
                // It is safe only when the alias actually resolves: the
                // destination wording alone ("... CREDIT CARDS") identifies a
                // card PRODUCT, not one of the holder's own accounts, and the
                // same wording is used for cards that are not the holder's.
                const cardPayee = output._card_repayment === true
                    ? payees.find((payee) =>
                        !payee.transfer_acct &&
                        payee.name?.toLowerCase() === output.payee_name.toLowerCase(),
                    )
                    : null;
                if (output._card_repayment === true) {
                    if (!cardPayee || !output.account_id) {
                        // Either the card cannot be linked to a payee, or the
                        // funding side is unknown. Both mean the money cannot
                        // be moved safely: HOLD. Letting this fall through
                        // books the repayment as spend on the funding card,
                        // which the card rule exists to prevent.
                        output.payee_name = "Misc";
                        output.payee_source = "transfer_destination_refused";
                        output.category_id = null;
                        output._hold_unresolved_transfer = true;
                        output._hold_cause = "destination_unresolved";
                    } else {
                        output.payee_id = cardPayee.id;
                        output._is_transfer = true;
                    }
                } else if (transferPayee && (
                    // A card destination is refused when it could only be
                    // reached by name — but NOT when the deterministic parser
                    // already resolved both legs and reserved the pair. That
                    // case is a repayment into the holder's own card, and
                    // refusing it held the uid 1031/1032 rows ("bill payment"
                    // to "Altitude"/"Yuu") even though source and destination
                    // were both known accounts.
                    !accountMatch ||
                    accountMatch.closed ||
                    accountMatch.id === output.account_id ||
                    (await this._detectAccountType(accountMatch.name) === "credit card" &&
                        !output._transfer?.destination_account_id) ||
                    (!output._structured_movement && transferDestinationIsAmbiguous(searchTerm, accountMatch, liveAccounts))
                )) {
                    // A closed or card account, a self target, or a bank-only
                    // name with several own accounts cannot identify a transfer leg.
                    output.payee_name = "Misc";
                    output.payee_source = "transfer_destination_refused";
                    output.category_id = null;
                    output._hold_unresolved_transfer = true;
                    output._hold_cause = "destination_unresolved";
                } else if (accountMatch) {
                    const matchedTransferPayee = payees.find(
                        (p) => p.transfer_acct === accountMatch.id,
                    );
                    if (matchedTransferPayee) {
                        output.payee_id = matchedTransferPayee.id;
                        output._is_transfer = true;
                        // The reserved transfer always runs source -> destination,
                        // and the booked account is the one this row sits on: it
                        // is the destination when the row is a credit and the
                        // source when it is a debit. The deterministic parser
                        // reads an incoming credit exactly this way, so both
                        // routes agree. Review round 2 on #561.
                        const credited = Number(output.amount_cents) > 0;
                        const bookAccountId = output.account_id || "";
                        const otherAccountId = accountMatch.id;
                        // The hold is for a credit that resolved to no other
                        // account; a reserved transfer is exactly what it was
                        // waiting for.
                        delete output._hold_unresolved_paynow;
                        // Reserve like the deterministic path does, so a second
                        // real transfer of the same amount is not dropped as a
                        // duplicate (issue #557). Without this, an account-name
                        // swap booked outside the journal and leaned on the
                        // amount+account lookback that cannot tell two real
                        // transfers apart.
                        const swapAmount = Number(output.amount_cents);
                        if (Number.isFinite(swapAmount))
                            output._transfer = {
                                budget_id: output.budget_id || "",
                                source_account_id: credited
                                    ? otherAccountId
                                    : bookAccountId,
                                destination_account_id: credited
                                    ? bookAccountId
                                    : otherAccountId,
                                currency:
                                    output.currency ||
                                    this._config.primaryCurrency,
                                amount_cents: Math.abs(swapAmount),
                                occurred_at:
                                    output.occurred_at ||
                                    new Date().toISOString(),
                                payee_id: matchedTransferPayee.id,
                            };
                    } else if (output._hold_unresolved_paynow) {
                        // A credit that resolved to an account but has no
                        // transfer payee cannot be reserved, so it stays held
                        // rather than booking an uncategorised inflow.
                        output._is_transfer = undefined;
                        output.payee_id = undefined;
                    }
                }
            } catch {}
        }

        // A card-product destination that could not be linked to a payee must
        // never be posted as spend. The transfer gate above is skipped entirely
        // when the payee resolved to nothing (payee_name === "Misc"), which is
        // exactly the unlinked case, so this check has to sit outside it.
        // When the gate did link the card, _is_transfer is already set and this
        // is a no-op.
        if (output._card_repayment === true && !output._is_transfer) {
            output.payee_name = "Misc";
            output.payee_source = "transfer_destination_refused";
            output.category_id = null;
            output._hold_unresolved_transfer = true;
            output._hold_cause = "destination_unresolved";
        }

        // Step 2: Category resolution.
        // Never categorize own-account transfers: payee→category memory facts
        // describe card spend ("Epsilon Nova Card maps to Food category"), not a
        // credit-card repayment between the user's own accounts.
        if (!output._is_transfer && !output.category_id && output.payee_source !== "self_identity") {
            let liveCategories = [];
            try {
                if (cachedCtx) {
                    liveCategories = Array.isArray(cachedCtx.categories)
                        ? cachedCtx.categories
                        : [];
                } else {
                    const { categories } =
                        (await this._tools.executeTool("fetch_context", {
                            budget_id: output.budget_id || "",
                        })) || {};
                    liveCategories = Array.isArray(categories)
                        ? categories
                        : [];
                }
            } catch {}

            // Tier 0: the owner's sender-and-amount rule names its category.
            if (output._incoming_rule_category) {
                const ruled = matchCategory(liveCategories, output._incoming_rule_category, { exact: true });
                if (ruled) {
                    output.category_id = ruled.id;
                    output.category_name = ruled.name;
                }
            }

            // Tier 1: Memory lookup (payee_name → category, matches auto-learn key)
            // Query by payee name only (not "payee + ' category'") so substring
            // search can reach facts like "Maxis Fibre maps to Malaysia Utilities
            // category" (the "X category" suffix is not contiguous in the fact).
            // Tier 1a: a category fact keyed on this merchant (a confirmed offer
            // or a wiki "Category override") outranks the payee's category.
            for (const r of output.category_id ? [] : memResults) {
                if (!searchTerm || !factNamesMerchant(r.text, searchTerm)) continue;
                const m = (r.text || "").match(/maps to (.+?) category/i);
                const matched = m ? matchCategory(liveCategories, m[1]) : null;
                if (matched) {
                    output.category_id = matched.id;
                    output.category_name = matched.name;
                    break;
                }
            }

            if (!output.category_id) {
                try {
                    const catMem = await this._tools.executeTool("search_memory", {
                        query: output.payee_name,
                    });
                    // A category fact is keyed by the entity it names, which is the
                    // payee in the auto-learned shape and the merchant in older
                    // facts. Either may name it; a fact naming neither must not
                    // supply the category. Issues #471, #420.
                    const categoryKeys = [output.payee_name, output.merchant].filter(
                        Boolean,
                    );
                    for (const r of catMem?.results || []) {
                        if (
                            !categoryKeys.some((key) =>
                                factNamesMerchant(r.text, key),
                            )
                        )
                            continue;
                        const m = (r.text || "").match(/maps to (.+?) category/i);
                        if (m) {
                            const matched = matchCategory(liveCategories, m[1]);
                            if (matched) {
                                output.category_id = matched.id;
                                output.category_name = matched.name;
                                break;
                            }
                        }
                    }
                } catch {}
            }

            // Tier 1b: Jev, only when memory had no category. It reads the email
            // and the search results that found the payee. Its pick is validated
            // here and never learned. A Misc row is booked without a category
            // (Phase 3), so Jev is not asked for one.
            if (!output.category_id && output._pending_category && !output._is_transfer) {
                const pending = matchCategory(liveCategories, output._pending_category, { exact: true });
                if (pending) {
                    output.category_id = pending.id;
                    output.category_name = pending.name;
                    output.category_source = "jev";
                }
            }
            if (
                !output.category_id &&
                output._evidence?.text &&
                !output._is_transfer &&
                output.payee_name.trim().toLowerCase() !== "misc"
            ) {
                try {
                    const jev = await this._tools.executeTool("classify_category", {
                        merchant: output.merchant || searchTerm || "",
                        payee: output.payee_name,
                        budget_id: output.budget_id || "",
                        evidence: output._evidence,
                        ...(output._merchant_search ? { search: output._merchant_search } : {}),
                        direction: Number(output.amount_cents) > 0 ? "incoming" : "outgoing",
                        amount_cents: output.amount_cents,
                        currency: output.currency,
                    });
                    const valid = jev?.category_id
                        ? liveCategories.find((c) => c.id === jev.category_id)
                        : null;
                    if (valid) {
                        output.category_id = valid.id;
                        output.category_name = valid.name;
                        output.category_source = "jev";
                    }
                } catch {}
            }

            // Tier 2: LLM picker (only if payee carries semantic signal
            // AND this is not a transfer)
            if (
                !output.category_id &&
                output.payee_name !== "Misc" &&
                !output._is_transfer
            ) {
                try {
                    const pickerPrompt = getCategoryPickerPrompt(
                        output.payee_name,
                        liveCategories,
                    );
                    const response = await this._chat(
                        [{ role: "user", content: pickerPrompt }],
                        undefined,
                        undefined,
                        { reasoning: "disabled", temperature: 0 },
                    );
                    const content =
                        (response.choices || [{}])[0].message?.content || "";
                    const parsed = this._parseJsonFromContent(content);
                    const categoryId = parsed?.category_id || null;

                    // Guard: validate picker output against live categories
                    if (categoryId) {
                        const valid = liveCategories.find(
                            (c) => c.id === categoryId,
                        );
                        if (valid) {
                            output.category_id = categoryId;
                            output.category_name = valid.name;
                            // A per-alert LLM category decision is not evidence for a
                            // reusable payee mapping. Persisting it poisoned generic
                            // keys such as "Food" (#588), so keep it local to this row.
                        }
                    }
                } catch {
                    // Picker failed — leave category blank
                }
            }
        }

        return output;
    }

    // ═══════════════════════════════════════════════════════════════
    // Phase 3: Execute
    // ═══════════════════════════════════════════════════════════════

    async _executePhase3(llmOutput) {
        return this._executePhase3Core(llmOutput, { silent: false });
    }

    /**
     * Silent Phase 3 — no notify_user, no mark_email_read.
     * Used by processText for Telegram-initiated transactions.
     */
    async _executePhase3Silent(llmOutput) {
        return this._executePhase3Core(llmOutput, { silent: true });
    }

    async _executePhase3Core(llmOutput, { silent }) {
        const { action } = llmOutput;

        if (action === "skip") {
            if (!silent) await this._tools.executeTool("mark_email_read", {});
            await this._tools.executeTool("log_decision", {
                action: "skipped",
                reasoning: llmOutput.reasoning || "",
                timestamp: new Date().toISOString(),
            });
            return {
                action: "skipped",
                details: `Skipped "${llmOutput.merchant || "unknown"}" — ${llmOutput.reasoning?.slice(0, 100) || "not an expense"}`,
            };
        }

        if (action === "insert") {
            // Issue #561: a PayNow credit whose sender resolves to no own
            // account must never be booked as an uncategorised positive inflow
            // (income). A self-transfer is not income, and the sender account
            // has to be known to reserve the right way round, so hold it and
            // let the user resolve it.
            if (llmOutput._hold_unresolved_paynow) {
                if (!silent) {
                    await this._tools.executeTool("notify_user", {
                        message: `Held: a PayNow credit of ${bookableAmountPrefix(llmOutput.amount_cents, llmOutput.currency)}from "${llmOutput.merchant || "unknown"}" could not be matched to one of your accounts, so it was not booked as income. Transfer it in Actual or tell me which account sent it.`,
                    });
                }
                await this._tools.executeTool("log_decision", {
                    action: "held_unresolved_paynow",
                    reasoning: llmOutput.reasoning || "",
                    timestamp: new Date().toISOString(),
                });
                return { action: "notified", details: "Held an unresolved PayNow credit" };
            }
            if (llmOutput._hold_unresolved_transfer) {
                if (!silent) {
                    // One cause per held row. The three causes are NOT the same
                    // story to the user, and the old text told the wrong one for
                    // two of them: for a person transfer the destination was never
                    // the problem, and for the F2 ambiguity the SOURCE account was.
                    // The cause rides `_hold_cause` because `notify_message` is
                    // ignored here and `reasoning` is LLM-authored on the Phase-2
                    // holds, which made a wrong-text failure untestable.
                    const heldName = llmOutput.merchant || "unknown";
                    const prefix = bookableAmountPrefix(llmOutput.amount_cents, llmOutput.currency);
                    const messages = {
                        person_identity_unverified: `Held: ${prefix}transfer to "${heldName}" was not booked — I could not verify "${heldName}" as a payee or one of your accounts, and booking it would record a stranger as spending or income.`,
                        source_account_ambiguous: `Held: ${prefix}transfer to "${heldName}" was not booked — I could not tell which of your accounts it left, because more than one account at that bank matches the alert. Nothing was recorded.`,
                        destination_unresolved: `Held: transfer destination for ${prefix}"${heldName}" was not safe to resolve, so it was not booked.`,
                    };
                    const message = messages[llmOutput._hold_cause] ||
                        `Held: transfer destination for ${prefix}"${heldName}" was not safe to resolve, so it was not booked.`;
                    await this._tools.executeTool("notify_user", { message });
                }
                await this._tools.executeTool("log_decision", {
                    action: "held_unresolved_transfer",
                    reasoning: llmOutput.reasoning || "",
                    timestamp: new Date().toISOString(),
                });
                // A held email must be marked read. imap.js re-fetches
                // `{ unseen: true }` on every idle poll, so without this a held
                // alert notifies again and again; the hold is already journaled
                // by log_decision above, so nothing is lost by marking it read.
                if (!silent) await this._tools.executeTool("mark_email_read", {});
                return { action: "notified", details: "Held an unresolved transfer" };
            }
            const payeeName = llmOutput.payee_name || "Misc";
            const accountId = llmOutput.account_id || "";
            const categoryId =
                payeeName.trim().toLowerCase() === "misc"
                    ? undefined
                    : llmOutput.category_id || undefined;
            let transferReservation = null;

            // Check duplicate. An absent amount must not be turned into 0 here:
            // a 0-cent lookback can match an unrelated row, mark the email read,
            // and drop the alert. Leave it absent so the insert refuses it.
            // Presence, not integer-ness: the pipeline and the route both
            // tolerate a quoted integer amount, and those must still dedup.
            const hasAmount =
                llmOutput.amount_cents != null && llmOutput.amount_cents !== "";
            // An alert can carry no figure at all: UOB sends a second "FAST Funds
            // Transfer Status" email naming the transfer but no amount, and it
            // booked a 0.00 pair (issue #557). Nothing to record, so skip it,
            // mark it read, and say why.
            if (hasAmount && Number(llmOutput.amount_cents) === 0) {
                if (!silent) {
                    await this._tools.executeTool("mark_email_read", {});
                    await this._tools.executeTool("notify_user", {
                        message: `Skipped: the alert carried no amount (${llmOutput.raw_description || llmOutput.merchant || "unknown"}).`,
                    });
                }
                await this._tools.executeTool("log_decision", {
                    action: "skipped",
                    reasoning: "Alert carried no amount",
                    timestamp: new Date().toISOString(),
                });
                return { action: "skipped" };
            }
            // A structured transfer dedups on its reservation below, never on
            // money: an amount+account lookback cannot tell two real transfers of
            // the same amount apart, so it silently dropped the second one
            // (issue #556, OCBC 360 -> Trust Bank S$1.00 twice on 2026-09-13).
            const isDuplicate =
                !llmOutput._transfer &&
                hasAmount &&
                (await this._tools.executeTool("check_duplicate", {
                    date: llmOutput.date || "",
                    amount_cents: llmOutput.amount_cents,
                    account_id: accountId,
                    payee_name: payeeName,
                    budget_id: llmOutput.budget_id || "",
                }));

            if (isDuplicate) {
                if (!silent)
                    await this._tools.executeTool("mark_email_read", {});
                await this._tools.executeTool("log_decision", {
                    action: "duplicate",
                    reasoning: llmOutput.reasoning || "",
                    timestamp: new Date().toISOString(),
                });
                return {
                    action: "duplicate",
                    details: `${bookableAmountPrefix(llmOutput.amount_cents, llmOutput.currency)}at ${llmOutput.merchant || payeeName}`,
                };
            }

            // A due `posts_transaction` schedule is invisible to check_duplicate:
            // it posts its own rows seconds later, so an alert-derived row of the
            // same amount on the same day produced a real duplicate pair (#586).
            // Only a deterministic INCOMING bank movement is checked: the
            // production collision (#586) was a deposit alert landing beside the
            // schedule's own credit leg. An outgoing payment or merchant
            // purchase cannot be that leg, and holding one would break it.
            // An unreadable schedule list counts as a possible collision.
            const scheduleCheckable =
                hasAmount &&
                !llmOutput._transfer &&
                llmOutput._structured_movement === true &&
                Number(llmOutput.amount_cents) > 0;
            if (scheduleCheckable) {
                let collision = false;
                let readFailed = false;
                try {
                    collision = await this._tools.executeTool(
                        "check_schedule_collision",
                        {
                            budget_id: llmOutput.budget_id || "",
                            amount_cents: llmOutput.amount_cents,
                            date: llmOutput.date || "",
                        },
                    );
                } catch {
                    // Hold anyway (fail-closed), but never claim a match we did
                    // not observe: an actual-api outage would otherwise be
                    // reported as "matches a scheduled transaction".
                    collision = true;
                    readFailed = true;
                }
                if (collision) {
                    const cents = bookableAmountCents(llmOutput.amount_cents);
                    const heldAmount =
                        cents === null
                            ? ""
                            : `${llmOutput.currency === "MYR" ? "RM" : "S$"}${(Math.abs(cents) / 100).toFixed(2)} `;
                    const what = `${heldAmount}${llmOutput.raw_description || llmOutput.merchant || "unknown"}`;
                    if (!silent)
                        await this._tools.executeTool("notify_user", {
                            message: readFailed
                                ? `Held: could not read the schedule list for ${what}, so it was held rather than booked unverified. Check the schedule in Actual.`
                                : `Held: ${what} matches a scheduled transaction due around ${llmOutput.date || "today"}, so it was not booked a second time. Check the schedule in Actual.`,
                        });
                    await this._tools.executeTool("log_decision", {
                        action: readFailed
                            ? "held_schedule_check_failed"
                            : "held_schedule_collision",
                        reasoning: llmOutput.reasoning || "",
                        timestamp: new Date().toISOString(),
                    });
                    return {
                        action: "notified",
                        details: readFailed
                            ? "Held a row because the schedule list could not be read"
                            : "Held a row that collides with a due schedule",
                    };
                }
            }

            // Declared here because the insert below needs the decision.
            let existingFarSide = { farRowId: null };
            if (llmOutput._transfer) {
                // The far side may already be booked as an ordinary row, from an
                // alert that named the deposit (#557 / #598). Decide that BEFORE
                // the transfer reservation: an ambiguous or unreadable far side
                // has to be retryable, and a reservation taken first would mark
                // the transfer `pending` and short-circuit every later pass
                // before this read ever ran (#598 review round 2, R2-M).
                existingFarSide = await this._findExistingFarSide({
                    transfer: llmOutput._transfer,
                    bookedAccountId: accountId,
                    amountCents: llmOutput.amount_cents,
                    date: llmOutput.date || new Date().toISOString().slice(0, 10),
                    budgetId: llmOutput.budget_id || "",
                });
                if (existingFarSide.hold) {
                    // Ambiguous or unreadable: the near leg is NOT booked either,
                    // because booking it would create the duplicate counterpart.
                    // Nothing is reserved, so a later alert retries this read
                    // instead of being stuck behind a pending transfer (#598).
                    const unmatched = existingFarSide.reason === "unmatched";
                    const ambiguous = existingFarSide.reason === "ambiguous";
                    if (!silent) {
                        await this._tools.executeTool("notify_user", {
                            message: unmatched
                                ? `Held: ${bookableAmountPrefix(llmOutput.amount_cents, llmOutput.currency)}transfer ${llmOutput.date || "today"} has a similar row on the far account that does not match exactly (payee, cleared state or date differs), so nothing was booked. Link or fix the rows in Actual.`
                                : ambiguous
                                ? `Held: ${bookableAmountPrefix(llmOutput.amount_cents, llmOutput.currency)}transfer ${llmOutput.date || "today"} has more than one uncleared row on the far account, so the two legs were left unlinked. Resolve the duplicate rows in Actual.`
                                : `Held: could not read the far account for the ${bookableAmountPrefix(llmOutput.amount_cents, llmOutput.currency)}transfer ${llmOutput.date || "today"}, so the destination leg was not booked and the transfer was left unlinked.`,
                        });
                    }
                    await this._tools.executeTool("log_decision", {
                        action: unmatched
                            ? "held_unmatched_far_side"
                            : ambiguous
                            ? "held_ambiguous_far_side"
                            : "held_unreadable_far_side",
                        reasoning: llmOutput.reasoning || "",
                        timestamp: new Date().toISOString(),
                    });
                    return {
                        action: "notified",
                        details: unmatched
                            ? "Held a transfer whose far side row does not match exactly"
                            : ambiguous
                            ? "Held a transfer whose far side has several candidates"
                            : "Held a transfer whose far account could not be read",
                    };
                }

                transferReservation = await this._tools.executeTool(
                    "reserve_transfer",
                    llmOutput._transfer,
                );
                if (transferReservation?.status === "inserted") {
                    if (!silent) await this._tools.executeTool("mark_email_read", {});
                    await this._tools.executeTool("log_decision", {
                        action: "transfer_counterpart_deduplicated",
                        reasoning: llmOutput.reasoning || "",
                        timestamp: new Date().toISOString(),
                    });
                    return { action: "transfer_counterpart_deduplicated", details: "Transfer counterpart matched" };
                }
                if (transferReservation?.status === "pending" || transferReservation?.status === "ambiguous") {
                    // The far-side read above has already run and come back
                    // 'no candidate', so this is a genuine duplicate still
                    // awaiting its counterpart. Surface it: the short-circuit
                    // used to be silent (#598 review round 2, R2-M).
                    if (!silent) {
                        await this._tools.executeTool("notify_user", {
                            message: `Held: ${bookableAmountPrefix(llmOutput.amount_cents, llmOutput.currency)}transfer ${llmOutput.date || "today"} is already partially recorded and is waiting for its other leg. Check the transfer in Actual.`,
                        });
                    }
                    return { action: "notified", details: "Transfer pending reconciliation" };
                }
            }

            // Insert transaction
            try {
                const inserted = await this._tools.executeTool("insert_transaction", {
                    account_id: accountId,
                    date:
                        llmOutput.date || new Date().toISOString().slice(0, 10),
                    amount_cents: llmOutput.amount_cents,
                    imported_description: payeeName,
                    category_id: categoryId,
                    // The far side is already booked, so this row must carry no
                    // transfer payee at all: that is what makes the route create
                    // a counterpart. Suppressed at the wire, because dropping
                    // `payee_id` alone still lets the insert re-derive the same
                    // transfer payee from the imported description (#598 R2-H1).
                    payee_id: existingFarSide.farRowId
                        ? undefined
                        : llmOutput.payee_id || undefined,
                    suppress_transfer_payee: existingFarSide.farRowId
                        ? true
                        : undefined,
                    notes: composeNotes({
                        notes: llmOutput.notes || "",
                        merchantDescriptor: llmOutput.raw_merchant_descriptor || "",
                    }),
                    budget_id: llmOutput.budget_id || "",
                });
                // A tool-level failure is returned, not thrown. Treat it as a
                // failed insert so the reservation is not completed and the
                // user is told. Issue #483 review.
                if (inserted && inserted.error) {
                    // Keep the tool's tag: the notification tells an ambiguous
                    // payee refusal apart from an upstream failure. Issue #551.
                    const refused = new Error(inserted.error);
                    if (inserted.code) refused.code = inserted.code;
                    throw refused;
                }
                // Only a Misc row is a transfer leg waiting for its other leg; a
                // credit memory or Jev named is income (#680 pairing shape).
                if (
                    llmOutput._pair_other_accounts?.length &&
                    inserted?.id &&
                    (payeeName.trim().toLowerCase() === "misc" || llmOutput._pair_untagged)
                ) {
                    const paired = await this._pairWaitingDebit({ llmOutput, creditRowId: inserted.id });
                    if (paired) llmOutput.reasoning = `${llmOutput.reasoning || ""} (linked to the waiting transfer leg)`;
                }
                if (transferReservation?.status === "reserved") {
                    await this._tools.executeTool("complete_transfer", {
                        id: transferReservation.entry.id,
                        actual_transaction_id: inserted?.id || null,
                    });
                    // Join the two existing rows into one pair. A failure here
                    // leaves both rows correct and merely unlinked, so it is
                    // logged and surfaced rather than thrown (#598).
                    if (existingFarSide.farRowId) {
                        const linked = await this._linkExistingFarSide({
                            transfer: llmOutput._transfer,
                            budgetId: llmOutput.budget_id || "",
                            farRowId: existingFarSide.farRowId,
                            bookedRowId: inserted?.id || null,
                            amountCents: llmOutput.amount_cents,
                        });
                        if (!linked && !silent) {
                            await this._tools.executeTool("notify_user", {
                                message: `Transfer ${bookableAmountPrefix(llmOutput.amount_cents, llmOutput.currency)}booked but the two rows could not be linked in Actual. Link them as a transfer in the app.`,
                            });
                        }
                    }
                }
            } catch (e) {
                logger.error({ event: "insert_failed", error: e.message });
                if (!silent) {
                    // Never print a fabricated figure: show the amount only when
                    // the route would accept it, so a malformed shape cannot be
                    // converted into a plausible-looking money value here.
                    const amountText = bookableAmountPrefix(
                        llmOutput.amount_cents,
                        llmOutput.currency,
                    );
                    // "pass payee_id" is an instruction for the model; a human
                    // reading the notification can only merge the duplicates.
                    // The refusal fires for two or more matches, not just two.
                    // The tag is a literal because tools.js already imports this
                    // module, so sharing the constant would close a cycle.
                    const ambiguousHint =
                        e.code === "AMBIGUOUS_PAYEE"
                            ? " More than one payee has that name — merge them in Actual; this email retries."
                            : "";
                    try {
                        await this._tools.executeTool("notify_user", {
                            message: `Failed to insert ${amountText}at ${llmOutput.merchant || payeeName}: ${String(e.message).slice(0, 200)}${ambiguousHint}`,
                        });
                    } catch {} // prevent notify_user failure from triggering top-level catch
                }
                return {
                    action: "error",
                    details: `Insert failed: ${e.message}`,
                };
            }

            if (!silent) {
                // Always build the notification from Phase 2's resolved
                // payee/category — never the Phase-1 LLM's notify_message,
                // which is written BEFORE Phase 2 resolves those fields and
                // so can never reflect what was actually booked (this also
                // applies uniformly to deterministic bank-movement outputs,
                // whose Phase-1 `merchant` is sometimes just a generic
                // placeholder like "Bank payment"/"Unidentified deposit").
                // "Misc" is a catch-all, not a real payee — fall back to the
                // raw merchant text there so the message stays informative.
                const sym = llmOutput.currency === "MYR" ? "RM" : "S$";
                const cents = bookableAmountCents(llmOutput.amount_cents);
                const amountPrefix =
                    cents === null
                        ? ""
                        : `${sym}${(Math.abs(cents) / 100).toFixed(2)} `;
                const acct = llmOutput.account_name || "unknown account";
                const dt = llmOutput.date || "today";
                const displayPayee =
                    payeeName.trim().toLowerCase() === "misc"
                        ? llmOutput.merchant || payeeName
                        : payeeName;
                // Only the category actually booked: a Misc row carries none.
                const cat = categoryId && llmOutput.category_name
                    ? ` → ${llmOutput.category_name}`
                    : "";
                const offer = await this._jevOffer(llmOutput, payeeName);
                const notified = await this._tools.executeTool("notify_user", {
                    message: `${amountPrefix}at ${displayPayee} via ${acct} on ${dt}${cat}, logged${ownNameNote(llmOutput)}${offer.text}`,
                });
                if (!notified) {
                    // An offer the user was never told about must not linger.
                    if (offer.id) {
                        try {
                            await this._tools.executeTool("withdraw_learning", { id: offer.id });
                        } catch {}
                    }
                    logger.error({
                        event: "notify_user_failed",
                        context: "phase3_insert",
                        merchant: llmOutput.merchant || payeeName,
                    });
                } else {
                    await this._tools.executeTool("mark_email_read", {});
                }
            }

            // Learn facts (fire-and-forget, don't block)
            //
            // The account-type fact is written only when the entity has no
            // fact yet. A contradiction is logged, never overwritten: the type
            // derived here comes from whether THIS transaction was sign-flipped,
            // so letting it rewrite an existing fact made the stored type
            // oscillate with the alert stream and silently flip the sign of the
            // next purchase. Correcting a wrong type is a deliberate edit, not a
            // side effect of booking a transaction.
            const learnPromises = [];
            if (llmOutput.account_name) {
                learnPromises.push(
                    (async () => {
                        try {
                            const acctType = llmOutput._sign_flipped
                                ? "credit card"
                                : "bank";
                            const fact = `${llmOutput.account_name} is a ${acctType} account`;
                            const learned = await this._tools.executeTool(
                                "learn_fact",
                                {
                                    fact,
                                    budget_id: llmOutput.budget_id || "",
                                },
                            );
                            if (learned?.reason === "contradiction") {
                                logger.warn({
                                    event: "account_type_conflict",
                                    account: llmOutput.account_name,
                                    proposed: acctType,
                                    existing: learned.existing,
                                });
                            }
                        } catch (e) {
                            logger.warn({
                                event: "learn_failed",
                                error: e.message,
                            });
                        }
                    })(),
                );
            }
            const suffixMappings = Array.isArray(llmOutput._suffix_mappings)
                ? llmOutput._suffix_mappings
                : [];
            for (const mapping of suffixMappings) {
                learnPromises.push(
                    this._learnSuffixFact(mapping, llmOutput.budget_id || ""),
                );
            }
            Promise.allSettled(learnPromises).catch(() => {});

            // Log decision
            await this._tools.executeTool("log_decision", {
                action: "inserted",
                reasoning: llmOutput.reasoning || "",
                timestamp: new Date().toISOString(),
            });

            const summary = `${bookableAmountPrefix(llmOutput.amount_cents, llmOutput.currency)}at ${llmOutput.merchant || payeeName} -> ${payeeName}`;
            return { action: "inserted", details: summary };
        }

        return { action: "error", details: `Unknown action: ${action}` };
    }

    // ═══════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════

    /**
     * The "Remember this mapping?" text for a payee that Jev chose (#720), and
     * the stored offer behind it. A model guess is never learned here: the offer
     * only waits for an explicit confirm_learning call. The offer id is not in
     * the text; it is read with list_pending_learning in the user's own turn.
     */
    async _jevOffer(llmOutput, payeeName) {
        const none = { id: null, text: "" };
        if (llmOutput.payee_source !== "jev" || !llmOutput._jev) return none;
        // A PayNow counterparty is a person, not a merchant; a transfer is
        // between the user's own accounts.
        if (llmOutput._is_paynow || llmOutput._is_transfer) return none;
        const { descriptor, runnerUp, confidence } = llmOutput._jev;
        const placeholder = descriptor === "Unidentified deposit";
        const sure = Number.isFinite(Number(confidence))
            ? `${Math.round(Number(confidence) * 100)}% sure`
            : "matched";
        const matched = ` Payee matched by AI (${sure}${runnerUp ? `, runner-up ${runnerUp}` : ""}).`;
        // The placeholder names nothing to remember.
        if (placeholder) return { id: null, text: matched };
        try {
            // Only a category Jev chose for this alert; one memory found through
            // the payee is not this merchant's own.
            const category = llmOutput.category_source === "jev" ? llmOutput.category_name : "";
            const offered = await this._tools.executeTool("propose_learning", {
                descriptor,
                payee: payeeName,
                // Money from a person is remembered by sender and amount.
                ...(llmOutput._incoming_person
                    ? {
                          incoming: {
                              currency: llmOutput.currency,
                              amount_cents: Math.abs(Number(llmOutput.amount_cents)),
                          },
                      }
                    : {}),
                ...(category ? { category } : {}),
                runner_up: runnerUp || "",
                budget_id: llmOutput.budget_id || "",
            });
            if (!offered?.offered) return { id: null, text: matched };
            const subject = offerSubject({
                descriptor: offered.key || descriptor,
                example: descriptor,
                payee: payeeName,
                category,
            });
            return {
                id: offered.id,
                text: `${matched} Remember ${subject}? Nothing is saved until you confirm.`,
            };
        } catch (error) {
            logger.warn({ event: "jev_offer_failed", error: error.message });
            return { id: null, text: matched };
        }
    }

    /**
     * Build the canonical suffix→account fact. "Card ending X belongs to Y"
     * for card-named accounts, "Account ending X belongs to Y" otherwise.
     * The prefix is cosmetic — the safety net keys on suffix + account name —
     * so the rule lives in memory.js beside the reader that has to parse it,
     * and this delegates rather than duplicating it.
     */
    _suffixFactText({ suffix, accountName }) {
        return canonicalSuffixFact({ suffix, accountName });
    }

    /**
     * Persist a verified suffix→account mapping. Guarded to 4–6 digit
     * suffixes; fire-and-forget with contradiction resolution.
     */
    async _learnSuffixFact({ suffix, accountName }, budget_id = "") {
        if (!suffix || !accountName) return;
        const normalized = String(suffix).trim();
        if (!/^\d{4,6}$/.test(normalized)) return;
        const fact = this._suffixFactText({ suffix: normalized, accountName });
        try {
            const learned = await this._tools.executeTool("learn_fact", {
                fact,
                budget_id,
            });
            if (learned?.reason === "contradiction" && learned?.existing) {
                // Parse the STORED fact with the shared tolerant parser, so an
                // existing fact written as "Card/account …" or with a trailing
                // full stop still yields a clean account name for the bank
                // comparison below.
                const existingParsed = parseSuffixFact(learned.existing);
                const existingAccount = existingParsed
                    ? existingParsed.accountName
                    : "";
                const newBank = bankFromText(accountName);
                const existingBank = bankFromText(existingAccount);
                // Only overwrite on a same-bank rename. A cross-bank collision
                // (same 4-digit suffix, different bank) cannot be represented by
                // a single suffix->account key, so retain the existing fact
                // rather than silently flip-flop the mapping on each alert.
                if (newBank && existingBank && newBank === existingBank) {
                    await this._tools.executeTool("update_fact", {
                        old_text: learned.existing,
                        new_text: fact,
                        budget_id,
                    });
                } else {
                    logger.warn({
                        event: "suffix_learn_conflict",
                        suffix: normalized,
                        existing: learned.existing,
                        incoming: fact,
                    });
                }
            }
        } catch (e) {
            logger.warn({ event: "suffix_learn_failed", error: e.message });
        }
    }

    /**
     * Returns true if the email body contains a recognisable date string.
     * Matches YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, DD Mon YYYY, and
     * "Month DD" / "DD Month" patterns.  Skips the prepended From/Subject
     * header block (everything before the first blank line).
     */
    _emailBodyHasDate(emailText) {
        // Strip the prepended From/Subject headers (before first blank line)
        const bodyStart = emailText.indexOf("\n\n");
        const body = bodyStart >= 0 ? emailText.slice(bodyStart) : emailText;

        // YYYY-MM-DD
        if (/\b\d{4}-\d{2}-\d{2}\b/.test(body)) return true;
        // DD/MM/YYYY or DD-MM-YYYY
        if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/.test(body)) return true;
        // DD Mon YYYY or Mon DD, YYYY  (e.g., "18 Jun 2026", "Jun 18, 2026")
        if (
            /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4}\b/i.test(
                body,
            )
        )
            return true;
        if (
            /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s+\d{4}\b/i.test(
                body,
            )
        )
            return true;

        return false;
    }

    _parseJsonFromContent(content) {
        let json = (content || "").trim();

        // Strip markdown code fences
        const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) json = fenceMatch[1].trim();

        try {
            return JSON.parse(json);
        } catch {
            // Try to find JSON object in the text
            const objMatch = json.match(/\{[\s\S]*\}/);
            if (objMatch) {
                try {
                    return JSON.parse(objMatch[0]);
                } catch {}
            }
            return null;
        }
    }
}
