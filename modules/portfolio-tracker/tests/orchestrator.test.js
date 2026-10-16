/**
 * Orchestrator tests — LLMClient, AgentOrchestrator.
 * Mocks OpenAI client to test the orchestration loop without real API calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We need to mock OpenAI before importing orchestrator
vi.mock("openai", () => {
    return {
        default: vi.fn().mockImplementation((config) => ({
            chat: {
                completions: {
                    create: vi.fn(),
                },
            },
        })),
    };
});

// Now import the modules
import { LLMClient, AgentOrchestrator } from "../src/orchestrator.js";

// We need to mock the prompts module too
vi.mock("../src/prompts.js", () => ({
    SYSTEM_PROMPT: "You are a helpful portfolio tracking agent.",
    FEW_SHOT_EXAMPLES: [
        [
            { role: "user", content: "Example query" },
            { role: "assistant", content: "Example response", tool_calls: [] },
        ],
    ],
}));

// Mock extractEmailContent to return clean text
vi.mock("../src/email_handler.js", () => ({
    extractEmailContent: vi.fn(),
}));

import { extractEmailContent } from "../src/email_handler.js";

describe("LLMClient DeepSeek route", () => {
    let client;
    let deepseek;

    beforeEach(() => {
        // Isolate the direct DeepSeek route (the router route is covered by
        // llm-responses-695.test.js).
        client = new LLMClient({ deepseekApiKey: "sk-test" });
        client._routes = [client._routes[1]];
        deepseek = client._routes[0].client;
    });

    it("constructs the router route first and DeepSeek last", () => {
        const full = new LLMClient({ deepseekApiKey: "sk-test" });
        expect(full._routes.map((r) => r.model)).toEqual([
            "auto-thinking",
            "deepseek-flash",
        ]);
    });

    it("calls chat completions with messages and tools", async () => {
        const mockResponse = {
            choices: [{ message: { role: "assistant", content: "Hello" } }],
        };
        deepseek.chat.completions.create = vi.fn().mockResolvedValue(mockResponse);
        const tools = [{ type: "function", function: { name: "t" } }];

        const response = await client.chat([{ role: "user", content: "hi" }], tools);

        expect(response).toBe(mockResponse);
        expect(deepseek.chat.completions.create).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "deepseek-flash",
                tools,
                tool_choice: "auto",
            }),
            { signal: expect.any(AbortSignal) },
        );
    });

    it("throws after the route is exhausted, naming the error", async () => {
        deepseek.chat.completions.create = vi
            .fn()
            .mockRejectedValue(new Error("Persistent error"));

        await expect(
            client.chat([{ role: "user", content: "test" }], undefined),
        ).rejects.toThrow(/deepseek-flash: Persistent error/);
    });
});

describe("AgentOrchestrator", () => {
    let orchestrator;
    let mockTools;

    beforeEach(() => {
        vi.clearAllMocks();

        mockTools = {
            getToolSchemas: vi
                .fn()
                .mockReturnValue([
                    { type: "function", function: { name: "test-tool" } },
                ]),
            executeTool: vi.fn().mockResolvedValue({ result: "ok" }),
            setEventContext: vi.fn(),
        };

        extractEmailContent.mockResolvedValue("Clean extracted email text");

        const config = {
            deepseekApiKey: "sk-test",
        };

        orchestrator = new AgentOrchestrator(config, mockTools);
    });

    it("exposes tools getter", () => {
        expect(orchestrator.tools).toBe(mockTools);
    });

    it("calls setEventContext and extractEmailContent before LLM", async () => {
        const mockLlm = {
            chat: vi.fn().mockResolvedValue({
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: "Processed successfully",
                        },
                    },
                ],
            }),
        };

        orchestrator._llm = mockLlm;
        extractEmailContent.mockResolvedValue("Clean extracted email text");

        const rawEmail = Buffer.from(
            "From: test@test.com\r\nSubject: Test\r\n\r\nHello",
        );
        const result = await orchestrator.processEmail("msg-1", rawEmail, null);

        expect(result.action).toBe("completed");

        // Must call setEventContext with (null, rawEmail bytes)
        expect(mockTools.setEventContext).toHaveBeenCalledWith(null, rawEmail);

        // Must call extractEmailContent with raw email
        expect(extractEmailContent).toHaveBeenCalledWith(rawEmail);

        // LLM must receive the extracted text (last user message, not few-shot examples)
        const chatMessages = mockLlm.chat.mock.calls[0][0];
        const userMessages = chatMessages.filter((m) => m.role === "user");
        const lastUserMessage = userMessages[userMessages.length - 1];
        expect(lastUserMessage.content).toContain("Clean extracted email text");
    });

    it("builds messages with system prompt, few-shot examples, and user email", async () => {
        const mockLlm = {
            chat: vi.fn().mockResolvedValue({
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: "Processed successfully",
                        },
                    },
                ],
            }),
        };

        orchestrator._llm = mockLlm;
        extractEmailContent.mockResolvedValue("Extracted: Hello from IBKR");

        const result = await orchestrator.processEmail(
            "msg-1",
            Buffer.from("raw email"),
            null,
        );

        expect(result.action).toBe("completed");
        expect(result.details).toBe("Processed successfully");

        // Verify messages were built correctly - system first, user email last
        const chatMessages = mockLlm.chat.mock.calls[0][0];
        expect(chatMessages[0].role).toBe("system");
        expect(
            chatMessages.some(
                (m) =>
                    m.role === "user" &&
                    typeof m.content === "string" &&
                    m.content.includes("Extracted: Hello from IBKR"),
            ),
        ).toBe(true);
    });

    it("handles tool calls and iterates", async () => {
        // First call: LLM returns tool_calls
        // Second call: LLM returns final response (no tool_calls)
        const mockLlm = {
            chat: vi
                .fn()
                .mockResolvedValueOnce({
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "Let me check",
                                tool_calls: [
                                    {
                                        id: "call_1",
                                        type: "function",
                                        function: {
                                            name: "test-tool",
                                            arguments: JSON.stringify({
                                                key: "value",
                                            }),
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "All done",
                            },
                        },
                    ],
                }),
        };

        orchestrator._llm = mockLlm;

        const result = await orchestrator.processEmail(
            "msg-2",
            Buffer.from("Test email"),
            null,
        );

        expect(result.action).toBe("completed");
        expect(result.details).toBe("All done");
        expect(mockLlm.chat).toHaveBeenCalledTimes(2);
        expect(mockTools.executeTool).toHaveBeenCalledWith("test-tool", {
            key: "value",
        });
    });

    it("handles multiple tool calls in one response", async () => {
        const mockLlm = {
            chat: vi
                .fn()
                .mockResolvedValueOnce({
                    choices: [
                        {
                            message: {
                                tool_calls: [
                                    {
                                        id: "call_a",
                                        type: "function",
                                        function: {
                                            name: "tool-a",
                                            arguments: JSON.stringify({ a: 1 }),
                                        },
                                    },
                                    {
                                        id: "call_b",
                                        type: "function",
                                        function: {
                                            name: "tool-b",
                                            arguments: JSON.stringify({ b: 2 }),
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    choices: [
                        {
                            message: { content: "Done after tools" },
                        },
                    ],
                }),
        };

        orchestrator._llm = mockLlm;

        await orchestrator.processEmail("msg-3", Buffer.from("Test"), null);

        expect(mockTools.executeTool).toHaveBeenCalledWith("tool-a", { a: 1 });
        expect(mockTools.executeTool).toHaveBeenCalledWith("tool-b", { b: 2 });
    });

    it("returns error after max iterations exceeded", async () => {
        // Always return tool_calls to trigger max iteration error
        const mockLlm = {
            chat: vi.fn().mockResolvedValue({
                choices: [
                    {
                        message: {
                            tool_calls: [
                                {
                                    id: "call_x",
                                    type: "function",
                                    function: {
                                        name: "tool-x",
                                        arguments: "{}",
                                    },
                                },
                            ],
                        },
                    },
                ],
            }),
        };

        orchestrator._llm = mockLlm;

        const result = await orchestrator.processEmail(
            "msg-4",
            Buffer.from("Test"),
            null,
        );

        expect(result.action).toBe("error");
        expect(result.details).toBe("Max tool iterations exceeded");
        // MAX_TOOL_ITERATIONS = 5
        expect(mockLlm.chat).toHaveBeenCalledTimes(5);
    });

    it("handles string tool results by passing as-is", async () => {
        mockTools.executeTool = vi.fn().mockResolvedValue("string result");

        const mockLlm = {
            chat: vi
                .fn()
                .mockResolvedValueOnce({
                    choices: [
                        {
                            message: {
                                tool_calls: [
                                    {
                                        id: "call_s",
                                        type: "function",
                                        function: {
                                            name: "test-tool",
                                            arguments: "{}",
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    choices: [
                        {
                            message: { content: "Got string result" },
                        },
                    ],
                }),
        };

        orchestrator._llm = mockLlm;

        const result = await orchestrator.processEmail(
            "msg-5",
            Buffer.from("Test"),
            null,
        );

        expect(result.action).toBe("completed");
        // Tool result should be added as string
        const toolMessages = mockLlm.chat.mock.calls[1][0];
        const toolMsg = toolMessages.find((m) => m.role === "tool");
        expect(toolMsg.content).toBe("string result");
    });

    it("handles object tool results by JSON.stringify", async () => {
        mockTools.executeTool = vi.fn().mockResolvedValue({ key: "value" });

        const mockLlm = {
            chat: vi
                .fn()
                .mockResolvedValueOnce({
                    choices: [
                        {
                            message: {
                                tool_calls: [
                                    {
                                        id: "call_o",
                                        type: "function",
                                        function: {
                                            name: "test-tool",
                                            arguments: "{}",
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    choices: [
                        {
                            message: { content: "Done" },
                        },
                    ],
                }),
        };

        orchestrator._llm = mockLlm;

        await orchestrator.processEmail("msg-6", Buffer.from("Test"), null);

        const toolMessages = mockLlm.chat.mock.calls[1][0];
        const toolMsg = toolMessages.find((m) => m.role === "tool");
        expect(toolMsg.content).toBe('{"key":"value"}');
    });
});
