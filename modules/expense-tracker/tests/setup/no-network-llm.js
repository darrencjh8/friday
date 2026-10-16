/**
 * Unit tests never reach a real LLM. Tests that build an orchestrator from a
 * config with a dummy key used to send real requests to the provider: in CI
 * that came back as a quick 401, and without network it waited out
 * connection retries and timed the test out. Every OpenAI client now fails
 * the same way CI saw, immediately and offline. A test that mocks "openai"
 * itself still gets its own mock.
 */
import { vi } from "vitest";

vi.mock("openai", async (importOriginal) => {
    const actual = await importOriginal();
    const OpenAI = actual.default;
    const unauthorized = () =>
        Promise.reject(
            new OpenAI.AuthenticationError(
                401,
                { message: "offline test client" },
                "401 offline test client",
                new Headers(),
            ),
        );
    class OfflineOpenAI extends OpenAI {
        constructor(options = {}) {
            super({ ...options, apiKey: options.apiKey || "test" });
            this.chat = { completions: { create: unauthorized } };
            this.responses = { create: unauthorized };
            this.embeddings = { create: unauthorized };
        }
    }
    return { ...actual, default: OfflineOpenAI, OpenAI: OfflineOpenAI };
});
