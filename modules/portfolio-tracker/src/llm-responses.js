/**
 * Mapping between the Chat Completions shape the orchestrator speaks and the
 * Responses API shape the router serves `auto-thinking` on (issue #695).
 * Copied from expense-tracker (#694): each module builds from its own Docker
 * context, so it cannot import across modules.
 */

export function toResponsesInput(messages) {
    const input = [];
    for (const message of messages) {
        if (message.role === "tool") {
            input.push({
                type: "function_call_output",
                call_id: message.tool_call_id,
                output:
                    typeof message.content === "string"
                        ? message.content
                        : JSON.stringify(message.content ?? ""),
            });
            continue;
        }
        if (message.role === "assistant" && message.tool_calls?.length) {
            if (message.content)
                input.push({ role: "assistant", content: message.content });
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

/** Convert a Responses result into a chat-completion-shaped response. */
export function fromResponses(response) {
    const output = Array.isArray(response?.output) ? response.output : null;
    if (!output) throw new Error("LLM response had no output");
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
    if (response.status === "incomplete")
        throw new Error("LLM response truncated (incomplete)");
    if (!content && !toolCalls.length) throw new Error("LLM response was empty");
    const message = { role: "assistant", content: content || null };
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
        choices: [
            {
                message,
                finish_reason: toolCalls.length ? "tool_calls" : "stop",
            },
        ],
    };
}
