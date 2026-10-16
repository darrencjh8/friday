/**
 * Mapping between the Chat Completions shape the orchestrator speaks and the
 * Responses API shape the router serves `auto-thinking` on (issue #694).
 */
import OpenAI from "openai";

/** Every route failed for a reason that may clear up on its own (outage, routing, quota). */
export class LLMUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = "LLMUnavailableError";
    }
}

/** An error about this one response (truncated, empty, unmappable): retrying cannot help. */
export function deterministicError(message) {
    const error = new Error(message);
    error.deterministic = true;
    return error;
}

/** True for failures that say the provider could not be reached or refused the call. */
export function isOutageShaped(error) {
    if (!error || error.deterministic) return false;
    return (
        typeof error.status === "number" ||
        (typeof OpenAI.APIConnectionError === "function" &&
            error instanceof OpenAI.APIConnectionError) ||
        error.message === "timeout"
    );
}

export function toResponsesInput(messages) {
    const input = [];
    for (const message of messages) {
        if (message.role === "tool") {
            input.push({
                type: "function_call_output",
                call_id: message.tool_call_id,
                output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
            });
            continue;
        }
        if (message.role === "assistant" && message.tool_calls?.length) {
            if (message.content) input.push({ role: "assistant", content: message.content });
            for (const call of message.tool_calls) {
                input.push({
                    type: "function_call",
                    call_id: call.id,
                    name: call.function.name,
                    arguments: call.function.arguments,
                });
            }
            continue;
        }
        input.push({ role: message.role, content: message.content });
    }
    return input;
}

export function toResponsesTools(tools) {
    return tools.map((tool) => ({
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
}

export function toResponsesToolChoice(toolChoice) {
    if (toolChoice && typeof toolChoice === "object" && toolChoice.function?.name) {
        return { type: "function", name: toolChoice.function.name };
    }
    return toolChoice;
}

/** Convert a Responses result into a chat-completion-shaped response. */
export function fromResponses(response) {
    const output = Array.isArray(response?.output) ? response.output : null;
    if (!output) throw deterministicError("LLM response had no output");
    let content = "";
    const toolCalls = [];
    for (const item of output) {
        if (item.type === "message") {
            for (const part of item.content || []) {
                if (part.type === "output_text") content += part.text;
            }
        } else if (item.type === "function_call") {
            toolCalls.push({
                id: item.call_id,
                type: "function",
                function: { name: item.name, arguments: item.arguments },
            });
        }
    }
    let finishReason = "stop";
    if (response.status === "incomplete") finishReason = "length";
    else if (toolCalls.length) finishReason = "tool_calls";
    const message = { role: "assistant", content: content || null };
    if (toolCalls.length) message.tool_calls = toolCalls;
    return { choices: [{ message, finish_reason: finishReason }] };
}
