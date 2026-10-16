/**
 * Email classification module — lightweight LLM pre-filter before orchestrator.
 * Ported 1:1 from Python's _classify_email and dispatch_email in src/main.py
 */

import OpenAI from "openai";
import { extractEmailContent } from "./extractors.js";
import { logger } from "./logging.js";
import { fromResponses, toResponsesInput } from "./llm-responses.js";

export const CLASSIFICATION_PROMPT = `\
Classify this email as "statement", "transaction", or "skip". Respond with ONLY one word.

"statement" = monthly bank/credit card statement with multiple transactions, PDF attached, or eStatement.
Keywords: statement, eStatement, e-Statement, monthly, billing cycle, attached PDF.

"transaction" = single purchase, receipt, instant alert, promo, notification, sign-in alert.

"skip" = trade confirmations, IBKR Activity Flex statements, portfolio reports, investment summaries,
securities transaction notices. Keywords: IBKR, Activity Flex, Flex Query, trade confirmation,
portfolio, dividend, ISIN, ticker, shares, securities, equity, options, futures, forex.

DO NOT explain. Only respond with "statement", "transaction", or "skip".`;

// These exact notification subjects do not represent completed transactions.
// Handle them before the LLM so they are marked read instead of retried as parse failures.
const NON_TRANSACTION_SUBJECT_RE = /^(?:reminder:\s*upcoming scheduled transfer|digibank alert\s*-\s*unsuccessful bill payment|your edocument\(s\) are ready for viewing)$/i;

/**
 * Classify an email as "statement" | "transaction" | "skip" using the
 * configured LLM provider.
 * Falls back to "transaction" on any error so the orchestrator can still attempt processing.
 *
 * @param {string|Buffer} rawEmail - raw email source
 * @param {string} subject - email subject
 * @param {string} sender - email sender
 * @param {object} config - Config instance with llmApiKey, llmBaseUrl, llmModel
 * @returns {Promise<"statement"|"transaction"|"skip">}
 */
export async function classifyEmail(rawEmail, subject, sender, config) {
    if (NON_TRANSACTION_SUBJECT_RE.test(String(subject || "").trim())) {
        return "skip";
    }

    try {
        const raw = Buffer.isBuffer(rawEmail)
            ? rawEmail
            : Buffer.from(rawEmail || "");
        let body;
        try {
            body = await extractEmailContent(raw);
        } catch {
            body = String(rawEmail || "");
        }
        const text = [
            `Subject: ${subject}`,
            `From: ${sender}`,
            "",
            body.slice(0, 2000),
        ].join("\n");

        const provider = config.llmProvider || "deepseek";
        const routes = [{
            provider,
            model: config.llmModel || "deepseek-flash",
            apiKey: config.llmApiKey || config.deepseekApiKey || "",
            baseURL: config.llmBaseUrl || "https://api.deepseek.com/v1",
        }];
        if (provider !== "deepseek" && config.llmFallbackModel) {
            routes.push({ ...routes[0], model: config.llmFallbackModel });
        }
        if (provider !== "deepseek") {
            routes.push({
                provider: config.llmFinalFallbackProvider || "deepseek",
                model: config.llmFinalFallbackModel || "deepseek-flash",
                apiKey: config.deepseekApiKey || "",
                baseURL: "https://api.deepseek.com/v1",
            });
        }

        let response;
        let lastError;
        for (const route of routes) {
            try {
                const client = new OpenAI({ apiKey: route.apiKey, baseURL: route.baseURL });
                const messages = [
                    { role: "system", content: CLASSIFICATION_PROMPT },
                    { role: "user", content: text },
                ];
                // The router serves its pool on Responses only (#694); the
                // direct DeepSeek API stays on Chat Completions.
                const call =
                    route.provider === "deepseek"
                        ? client.chat.completions.create({
                            model: route.model,
                            messages,
                            temperature: 0,
                            max_tokens: 5,
                        })
                        : client.responses
                            .create({
                                model: route.model,
                                input: toResponsesInput(messages),
                                // Reasoning tokens count against the cap, so a
                                // tiny cap returns `incomplete` with no answer.
                                reasoning: { effort: "low" },
                                max_output_tokens: 128,
                            })
                            .then((raw) => {
                                const answer = fromResponses(raw);
                                const choice = answer.choices[0];
                                // An unfinished or empty answer is a failed route,
                                // not "transaction": try the next route.
                                if (choice.finish_reason === "length" || !choice.message.content) {
                                    throw new Error("classification response incomplete");
                                }
                                return answer;
                            });
                response = await Promise.race([
                    call,
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("timeout")), 10000),
                    ),
                ]);
                break;
            } catch (error) {
                lastError = error;
            }
        }
        if (!response) throw lastError;

        const result = (response.choices[0].message.content || "")
            .trim()
            .toLowerCase();
        if (result === "statement") return "statement";
        if (result === "skip") return "skip";
        return "transaction";
    } catch {
        // Default to "transaction" on any error so the orchestrator
        // can still attempt to extract and process.
        return "transaction";
    }
}

/**
 * Dispatch an email to the correct pipeline based on classification.
 *
 * @param {object} msg - email message object
 * @param {string} msg.msg_id - IMAP message ID
 * @param {string|Buffer} msg.raw_email - raw email source
 * @param {string} msg.subject - email subject
 * @param {string} msg.from - email sender
 * @param {Function} classifyFn - async (rawEmail, subject, sender) => string
 * @param {object} orchestrator - has processEmail(msgId, rawEmail, imapHandler, from, subject)
 * @param {object} imapHandler - has markRead(msgId)
 * @param {object} [statementProcessor] - optional, has processStatement(msgId, rawEmail, imapHandler)
 * @returns {Promise<void>}
 */
export async function dispatchEmail(
    msg,
    classifyFn,
    orchestrator,
    imapHandler,
    statementProcessor,
) {
    const classification = await classifyFn(
        msg.raw_email || "",
        msg.subject || "",
        msg.from || "",
    );

    if (classification === "skip") {
        logger.info({
            event: "skipping_non_expense_email",
            data: {
                subject: msg.subject || "",
                from: msg.from || "",
                msg_id: msg.msg_id || "",
            },
        });
        if (imapHandler?.markRead) {
            await imapHandler.markRead(msg.msg_id);
        }
        return;
    }

    if (classification === "statement" && statementProcessor) {
        await statementProcessor.processStatement(
            msg.msg_id,
            msg.raw_email,
            imapHandler,
        );
        return;
    }

    // "transaction" emails (and "statement" when no statementProcessor)
    // route through the transaction orchestrator.
    return await orchestrator.processEmail(
        msg.msg_id,
        msg.raw_email,
        imapHandler,
        msg.from,
        msg.subject,
    );
}
