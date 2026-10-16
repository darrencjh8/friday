/**
 * Portfolio tracker email dispatch tests.
 * Unlike the expense tracker (which uses LLM classification), the portfolio
 * tracker uses a deterministic keyword-based classifier and always routes
 * to the orchestrator for trade-related emails.
 */
import { describe, it, expect, vi } from "vitest";
import { dispatchEmail } from "../src/classify.js";

describe("dispatchEmail", () => {
    it("extracts email content and passes to orchestrator.processEmail", async () => {
        const mockOrchestrator = {
            processEmail: vi.fn().mockResolvedValue({ action: "completed" }),
        };
        const mockImapHandler = {
            markRead: vi.fn().mockResolvedValue(undefined),
        };

        const msg = {
            msg_id: "msg-1",
            raw_email: Buffer.from("From: ibkr@test.com\r\nSubject: Flex Query\r\n\r\n<FlexQueryResponse>..."),
            subject: "Flex Query",
            from: "ibkr@test.com",
        };

        await dispatchEmail(msg, mockOrchestrator, mockImapHandler);

        expect(mockOrchestrator.processEmail).toHaveBeenCalledWith(
            "msg-1",
            msg.raw_email,
            mockImapHandler,
        );
    });

    it("marks email as read after processing", async () => {
        const mockOrchestrator = {
            processEmail: vi.fn().mockResolvedValue({ action: "completed" }),
        };
        const mockImapHandler = {
            markRead: vi.fn().mockResolvedValue(undefined),
        };

        const msg = {
            msg_id: "msg-2",
            raw_email: Buffer.from("test"),
            subject: "Trade Confirmation",
        };

        await dispatchEmail(msg, mockOrchestrator, mockImapHandler);

        expect(mockImapHandler.markRead).toHaveBeenCalledWith("msg-2");
    });

    it("marks email read even when processing fails", async () => {
        const mockOrchestrator = {
            processEmail: vi.fn().mockRejectedValue(new Error("LLM error")),
        };
        const mockImapHandler = {
            markRead: vi.fn().mockResolvedValue(undefined),
        };

        const msg = {
            msg_id: "msg-3",
            raw_email: Buffer.from("test"),
            subject: "Bad email",
        };

        await dispatchEmail(msg, mockOrchestrator, mockImapHandler);

        // Should still mark as read
        expect(mockImapHandler.markRead).toHaveBeenCalledWith("msg-3");
    });

    it("handles missing imapHandler gracefully", async () => {
        const mockOrchestrator = {
            processEmail: vi.fn().mockResolvedValue({ action: "completed" }),
        };

        const msg = {
            msg_id: "msg-4",
            raw_email: Buffer.from("test"),
            subject: "Test",
        };

        // Should not throw
        await dispatchEmail(msg, mockOrchestrator, null);
        expect(mockOrchestrator.processEmail).toHaveBeenCalledWith(
            "msg-4",
            msg.raw_email,
            null,
        );
    });
});
