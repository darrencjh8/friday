/**
 * Agent Orchestrator for the portfolio tracker.
 * Ported 1:1 from src/agent/orchestrator.py
 */

import OpenAI from "openai";
import { SYSTEM_PROMPT, FEW_SHOT_EXAMPLES } from "./prompts.js";
import { extractEmailContent } from "./email_handler.js";
import { fromResponses, toResponsesInput, toResponsesTools } from "./llm-responses.js";

const MAX_TOOL_ITERATIONS = 5;

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
        this._reasoningEffort = config.llmReasoningEffort || "low";
        // The router serves auto-thinking on /v1/responses only; the direct
        // DeepSeek API has no Responses endpoint, so it stays on chat (#695).
        this._routes = [
            {
                responses: true,
                model: config.llmModel || "auto-thinking",
                apiKey: config.llmApiKey || config.deepseekApiKey,
                baseURL: config.llmBaseUrl || "http://codex-router:4100/v1",
                // Router per-hop budget is 300s: wait once, don't re-send a
                // slow answer 3x (#697).
                retries: 1,
                timeoutMs: 300000,
            },
            {
                responses: false,
                model: "deepseek-flash",
                apiKey: config.deepseekApiKey,
                baseURL: "https://api.deepseek.com/v1",
                retries: 1,
                timeoutMs: 60000,
            },
        ];
        for (const route of this._routes) {
            route.client = new OpenAI({
                apiKey: route.apiKey || "",
                baseURL: route.baseURL,
            });
        }
    }

    async chat(messages, tools) {
        const retryDelays = [1000, 2000, 4000];
        const failures = [];
        for (const route of this._routes) {
            let kwargs;
            if (route.responses) {
                kwargs = {
                    model: route.model,
                    input: toResponsesInput(messages),
                    reasoning: { effort: this._reasoningEffort },
                };
                if (tools) {
                    kwargs.tools = toResponsesTools(tools);
                    kwargs.tool_choice = "auto";
                }
            } else {
                kwargs = {
                    model: route.model,
                    messages,
                    temperature: 0.1,
                    thinking: { type: "low" },
                };
                if (tools) {
                    kwargs.tools = tools;
                    kwargs.tool_choice = "auto";
                }
            }

            for (let attempt = 0; attempt < route.retries; attempt++) {
                try {
                    const raw = await withAbortTimeout(route.timeoutMs, (signal) =>
                        route.responses
                            ? route.client.responses.create(kwargs, { signal })
                            : route.client.chat.completions.create(kwargs, { signal }),
                    );
                    return route.responses ? fromResponses(raw) : raw;
                } catch (e) {
                    if (attempt < route.retries - 1)
                        await new Promise((r) => setTimeout(r, retryDelays[attempt]));
                    else failures.push(`${route.model}: ${e.message}`);
                }
            }
        }
        throw new Error(`All LLM routes failed: ${failures.join("; ")}`);
    }
}

export class AgentOrchestrator {
    constructor(config, tools) {
        this._config = config;
        this._llm = new LLMClient(config);
        this._tools = tools;
    }

    get tools() {
        return this._tools;
    }

    async processEmail(msgId, rawEmail, imapHandler) {
        // Set event context so tools can access the raw email bytes
        const rawBytes = Buffer.isBuffer(rawEmail)
            ? rawEmail
            : Buffer.from(rawEmail || "");
        this._tools.setEventContext(null, rawBytes);

        // Extract clean text from the MIME email (handles HTML, PDF attachments, etc.)
        let emailText;
        try {
            emailText = await extractEmailContent(rawBytes);
        } catch (e) {
            console.error(
                JSON.stringify({
                    event: "email_extraction_error",
                    error: e.message,
                    msg_id: msgId,
                }),
            );
            emailText = rawBytes.toString("utf8");
        }

        console.log(
            JSON.stringify({
                event: "orchestrator_starting",
                msg_id: msgId,
                extracted_length: emailText.length,
            }),
        );

        const messages = this._buildMessages(emailText);
        const toolSchemas = this._tools.getToolSchemas();

        try {
            for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
                const response = await this._llm.chat(messages, toolSchemas);
                const choice = (response.choices || [{}])[0];
                const message = choice.message || {};
                const finishReason = choice.finish_reason || "";

                if (message.content)
                    messages.push({
                        role: "assistant",
                        content: message.content,
                    });

                const toolCalls = message.tool_calls;
                if (!toolCalls) {
                    console.log(
                        JSON.stringify({
                            event: "orchestrator_completed",
                            iteration: i,
                            finish_reason: finishReason,
                            content_snippet: (message.content || "").slice(
                                0,
                                300,
                            ),
                        }),
                    );
                    return {
                        action: "completed",
                        details: message.content || "",
                    };
                }

                console.log(
                    JSON.stringify({
                        event: "orchestrator_tool_calls",
                        iteration: i,
                        finish_reason: finishReason,
                        tool_count: toolCalls.length,
                        tools: toolCalls.map(
                            (tc) => tc.function?.name || "unknown",
                        ),
                    }),
                );

                const amsg = {
                    role: "assistant",
                    content: message.content,
                    tool_calls: toolCalls,
                };
                if (!amsg.content) delete amsg.content;
                messages.push(amsg);

                for (const tc of toolCalls) {
                    const func = tc.function || {};
                    let args = {};
                    try {
                        args = JSON.parse(func.arguments || "{}");
                    } catch {}
                    const result = await this._tools.executeTool(
                        func.name || "",
                        args,
                    );
                    messages.push({
                        role: "tool",
                        tool_call_id: tc.id || "",
                        content:
                            typeof result === "string"
                                ? result
                                : JSON.stringify(result),
                    });
                }
            }
            return { action: "error", details: "Max tool iterations exceeded" };
        } catch (e) {
            console.error(
                JSON.stringify({
                    event: "orchestrator_error",
                    error: e.message,
                    msg_id: msgId,
                }),
            );
            return { action: "error", details: e.message };
        }
    }

    _buildMessages(emailContent) {
        const messages = [{ role: "system", content: SYSTEM_PROMPT }];
        for (const example of FEW_SHOT_EXAMPLES) messages.push(...example);
        messages.push({
            role: "user",
            content: `Process this:\n\n${emailContent}`,
        });
        return messages;
    }
}
