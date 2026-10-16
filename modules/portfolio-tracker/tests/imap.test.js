/**
 * IMAP handler tests — ImapIdleHandler construction, fetchUnread, markRead, idle loop.
 * Mocks imapflow to test without real IMAP connection.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Must mock imapflow before importing the handler
vi.mock("imapflow", () => ({
    ImapFlow: vi.fn(),
}));

import { ImapFlow } from "imapflow";
import { ImapIdleHandler } from "../src/imap.js";

describe("ImapIdleHandler", () => {
    let handler;
    let mockClient;

    beforeEach(() => {
        vi.clearAllMocks();

        mockClient = {
            connect: vi.fn().mockResolvedValue(undefined),
            logout: vi.fn().mockResolvedValue(undefined),
            mailboxOpen: vi.fn().mockResolvedValue(undefined),
            fetch: vi.fn(),
            messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
            idle: vi.fn().mockResolvedValue(undefined),
        };

        ImapFlow.mockImplementation(() => mockClient);

        handler = new ImapIdleHandler(
            "imap.example.com",
            993,
            "user@test.com",
            "password",
            "Trades",
        );
    });

    it("constructs with host, port, credentials, and folder", () => {
        expect(handler._host).toBe("imap.example.com");
        expect(handler._port).toBe(993);
        expect(handler._username).toBe("user@test.com");
        expect(handler._password).toBe("password");
        expect(handler._folder).toBe("Trades");
        expect(handler._running).toBe(false);
    });

    it("defaults folder to INBOX when not provided", () => {
        const h = new ImapIdleHandler("host", 993, "u", "p");
        expect(h._folder).toBe("INBOX");
    });

    it("connects with secure TLS and opens configured folder", async () => {
        await handler.connect();

        expect(ImapFlow).toHaveBeenCalledWith({
            host: "imap.example.com",
            port: 993,
            secure: true,
            auth: { user: "user@test.com", pass: "password" },
            logger: false,
        });
        expect(mockClient.connect).toHaveBeenCalled();
        expect(mockClient.mailboxOpen).toHaveBeenCalledWith("Trades");
    });

    it("fetches unread messages", async () => {
        // Set up connected client
        await handler.connect();

        // Mock fetch to yield one message
        const mockSource = Buffer.from("raw email source");
        mockClient.fetch.mockImplementation(async function* (
            { unseen },
            { source, envelope },
        ) {
            yield { seq: 42, source: mockSource };
        });

        const messages = await handler.fetchUnread();
        expect(messages).toHaveLength(1);
        expect(messages[0].msg_id).toBe("42");
        expect(messages[0].raw_email).toBe(mockSource);
    });

    it("returns empty array when no client connected", async () => {
        const messages = await handler.fetchUnread();
        expect(messages).toEqual([]);
    });

    it("marks message as read", async () => {
        await handler.connect();
        await handler.markRead("42");

        expect(mockClient.messageFlagsAdd).toHaveBeenCalledWith({ seq: "42" }, [
            "\\Seen",
        ]);
    });

    it("silently ignores markRead when not connected", async () => {
        await handler.markRead("42");
        // Should not throw
        expect(mockClient.messageFlagsAdd).not.toHaveBeenCalled();
    });

    it("disconnects and logs out", async () => {
        await handler.connect();
        await handler.disconnect();

        expect(mockClient.logout).toHaveBeenCalled();
        expect(handler._client).toBeNull();
    });

    it("handles disconnect errors gracefully", async () => {
        await handler.connect();
        mockClient.logout.mockRejectedValueOnce(new Error("connection lost"));

        await handler.disconnect();
        // Should not throw
        expect(handler._client).toBeNull();
    });

    it("exits idle loop when _running becomes false", async () => {
        // idleLoop always sets _running = true at start.
        // To test that the loop exits when _running becomes false,
        // we make idling set _running = false. The loop calls:
        // connect -> fetchUnread -> idle -> while check -> exit.

        // fetch must return a valid async iterable (empty)
        mockClient.fetch.mockImplementation(async function* () {
            // yield nothing — no unread messages
        });

        // idle sets _running = false, causing while loop to exit
        mockClient.idle.mockImplementation(async () => {
            handler._running = false;
        });

        await handler.idleLoop(vi.fn());

        // Should have connected and logged imap_idle_stopped (no throw = pass)
        expect(mockClient.connect).toHaveBeenCalled();
    }, 10000);

    it("processes unread messages via callback in idle loop", async () => {
        const callback = vi.fn().mockResolvedValue(undefined);

        // Set up: connect succeeds, fetch returns one message, then idle hangs
        // We'll make idle throw after first cycle to stop the loop
        mockClient.idle
            .mockResolvedValueOnce(undefined) // first idle succeeds
            .mockRejectedValueOnce(new Error("stop loop")); // second iteration stops

        // Simulate: fetch returns one unread message on first call
        let fetchCallCount = 0;
        mockClient.fetch.mockImplementation(async function* () {
            fetchCallCount++;
            if (fetchCallCount === 1) {
                yield { seq: 1, source: Buffer.from("test email") };
            }
        });

        handler._running = true;
        // Manually stop after first callback is called
        callback.mockImplementation(() => {
            handler._running = false;
        });

        await handler.idleLoop(callback);

        expect(callback).toHaveBeenCalledTimes(1);
        const msg = callback.mock.calls[0][0];
        expect(msg.msg_id).toBe("1");
        expect(msg.raw_email).toBeInstanceOf(Buffer);
        expect(mockClient.mailboxOpen).toHaveBeenCalled();
    });
});
