import { describe, expect, it, vi } from "vitest";

const on = vi.fn();
const connect = vi.fn(async () => {});
const mailboxOpen = vi.fn(async () => {});

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn(() => ({ on, connect, mailboxOpen })),
}));

const { ImapIdleHandler } = await import("../src/imap.js");

describe("ImapIdleHandler socket errors", () => {
  it("handles client errors without becoming an uncaught exception", async () => {
    const handler = new ImapIdleHandler(
      "imap.example.com",
      993,
      "user@example.com",
      "app-pass",
    );

    await handler.connect();

    expect(on).toHaveBeenCalledWith("error", expect.any(Function));
    const errorHandler = on.mock.calls.find(([event]) => event === "error")[1];

    expect(() => errorHandler(new Error("Socket timeout"))).not.toThrow();
    expect(handler._client).toBeNull();
  });
});
