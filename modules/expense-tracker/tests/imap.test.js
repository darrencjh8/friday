/**
 * Unit tests for IMAP IDLE handler.
 * Ported from tests/test_imap_notifier.py
 */
import { describe, it, expect, vi } from "vitest";
import { ImapIdleHandler } from "../src/imap.js";

describe("ImapIdleHandler constructor", () => {
  it("stores all connection parameters", () => {
    const handler = new ImapIdleHandler(
      "imap.example.com",
      993,
      "user@example.com",
      "app-pass",
    );
    expect(handler._host).toBe("imap.example.com");
    expect(handler._port).toBe(993);
    expect(handler._username).toBe("user@example.com");
    expect(handler._password).toBe("app-pass");
    expect(handler._mailbox).toBe("INBOX");
    expect(handler._client).toBeNull();
    expect(handler._running).toBe(false);
  });

  it("defaults mailbox to INBOX", () => {
    const handler = new ImapIdleHandler(
      "imap.example.com",
      993,
      "user@example.com",
      "app-pass",
    );
    expect(handler._mailbox).toBe("INBOX");
  });

  it("accepts custom mailbox", () => {
    const handler = new ImapIdleHandler(
      "imap.example.com",
      993,
      "user@example.com",
      "app-pass",
      null,
      "Trades",
    );
    expect(handler._mailbox).toBe("Trades");
  });

  it("accepts mailbox with dedupJournal", () => {
    const dedup = {
        isRecentlyProcessed: () => false,
        isMessageBooked: () => false,
        markMessageBooked: () => {},
        noteMailboxUidValidity: () => false,
    };
    const handler = new ImapIdleHandler(
      "imap.example.com",
      993,
      "user@example.com",
      "app-pass",
      dedup,
      "Archive",
    );
    expect(handler._dedup).toBe(dedup);
    expect(handler._mailbox).toBe("Archive");
  });
});

describe("ImapIdleHandler disconnect", () => {
  it("closes and logs out when client exists", async () => {
    const handler = new ImapIdleHandler(
      "imap.example.com",
      993,
      "user@example.com",
      "pass",
    );
    const mockClient = {
      logout: vi.fn(async () => {}),
    };
    handler._client = mockClient;

    await handler.disconnect();
    expect(mockClient.logout).toHaveBeenCalledOnce();
    expect(handler._client).toBeNull();
  });

  it("handles logout errors gracefully", async () => {
    const handler = new ImapIdleHandler(
      "imap.example.com",
      993,
      "user@example.com",
      "pass",
    );
    const mockClient = {
      logout: vi.fn(async () => {
        throw new Error("connection broken");
      }),
    };
    handler._client = mockClient;

    await handler.disconnect();
    expect(handler._client).toBeNull();
  });

  it("is a no-op when client is already null", async () => {
    const handler = new ImapIdleHandler(
      "imap.example.com",
      993,
      "user@example.com",
      "pass",
    );
    handler._client = null;
    await expect(handler.disconnect()).resolves.toBeUndefined();
    expect(handler._client).toBeNull();
  });
});

describe("ImapIdleHandler fetchUnread", () => {
  it("returns empty array when no client", async () => {
    const handler = new ImapIdleHandler(
      "imap.example.com",
      993,
      "user@example.com",
      "pass",
    );
    handler._client = null;
    const result = await handler.fetchUnread();
    expect(result).toEqual([]);
  });

  it("returns structured messages when emails exist", async () => {
    const handler = new ImapIdleHandler(
      "imap.example.com",
      993,
      "user@example.com",
      "pass",
    );

    // Create a mock async iterable
    const mockMessages = [
      {
        seq: 1,
        uid: 100,
        source: Buffer.from(
          "From: test@test.com\r\nSubject: Test Alert\r\nDate: Thu, 04 Jun 2026\r\n\r\nBody content",
        ),
        envelope: {},
      },
      {
        seq: 2,
        uid: 101,
        source: Buffer.from(
          "From: alerts@example.com\r\nSubject: S$12.80 spent\r\nDate: Thu, 04 Jun 2026\r\n\r\nTransaction",
        ),
        envelope: {},
      },
    ];

    const mockClient = {
      fetch: vi.fn(function* () {
        for (const msg of mockMessages) {
          yield msg;
        }
      }),
    };

    // Override fetch to return an async iterable
    mockClient.fetch = vi.fn(() => {
      return {
        [Symbol.asyncIterator]() {
          let idx = 0;
          return {
            async next() {
              if (idx < mockMessages.length) {
                return {
                  value: mockMessages[idx++],
                  done: false,
                };
              }
              return { value: undefined, done: true };
            },
          };
        },
      };
    });

    handler._client = mockClient;

    const result = await handler.fetchUnread();
    expect(result.length).toBe(2);
    expect(result[0].msg_id).toBe("100");
    expect(result[0].from).toBeDefined();
    expect(result[0].subject).toBeDefined();
    expect(result[0].raw_email).toBeDefined();
    expect(result[1].msg_id).toBe("101");
  });

  it("returns empty array when no unseen messages", async () => {
    const handler = new ImapIdleHandler(
      "imap.example.com",
      993,
      "user@example.com",
      "pass",
    );

    const mockClient = {
      fetch: vi.fn(() => {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                return { value: undefined, done: true };
              },
            };
          },
        };
      }),
    };

    handler._client = mockClient;
    const result = await handler.fetchUnread();
    expect(result).toEqual([]);
  });
});

describe("ImapIdleHandler markRead", () => {
  it("sets Seen flag by UID (string converted to number)", async () => {
    const handler = new ImapIdleHandler(
      "imap.example.com",
      993,
      "user@example.com",
      "pass",
    );

    const mockClient = {
      messageFlagsAdd: vi.fn(async () => {}),
    };
    handler._client = mockClient;

    await handler.markRead("42");
    expect(mockClient.messageFlagsAdd).toHaveBeenCalledWith(42, ["\\Seen"], {
      uid: true,
    });
  });

  it("sets Seen flag by UID (number passed through)", async () => {
    const handler = new ImapIdleHandler(
      "imap.example.com",
      993,
      "user@example.com",
      "pass",
    );

    const mockClient = {
      messageFlagsAdd: vi.fn(async () => {}),
    };
    handler._client = mockClient;

    await handler.markRead(42);
    expect(mockClient.messageFlagsAdd).toHaveBeenCalledWith(42, ["\\Seen"], {
      uid: true,
    });
  });

  it("returns early without API call when msgId is non-numeric", async () => {
    const handler = new ImapIdleHandler(
      "imap.example.com",
      993,
      "user@example.com",
      "pass",
    );

    const mockClient = {
      messageFlagsAdd: vi.fn(async () => {}),
    };
    handler._client = mockClient;

    await handler.markRead("not-a-number");
    expect(mockClient.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it("handles errors gracefully (no client)", async () => {
    const handler = new ImapIdleHandler(
      "imap.example.com",
      993,
      "user@example.com",
      "pass",
    );
    handler._client = null;
    await expect(handler.markRead("1")).resolves.toBeUndefined();
  });

  it("handles client errors gracefully", async () => {
    const handler = new ImapIdleHandler(
      "imap.example.com",
      993,
      "user@example.com",
      "pass",
    );
    const mockClient = {
      messageFlagsAdd: vi.fn(async () => {
        throw new Error("IMAP error");
      }),
    };
    handler._client = mockClient;

    await expect(handler.markRead("1")).resolves.toBeUndefined();
  });
});

describe("ImapIdleHandler idleLoop UID pre-check", () => {
  const emailSource = Buffer.from(
    "From: test@test.com\r\nSubject: Test\r\n\r\nBody",
  );

  function makeMsg(uid) {
    return { uid, seq: uid, source: emailSource, envelope: {} };
  }

  function makeIter(messages) {
    return {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next() {
            if (i < messages.length)
              return { value: messages[i++], done: false };
            return { done: true };
          },
        };
      },
    };
  }

  it("skips recently processed UIDs without calling callback", async () => {
    const dedup = {
      isRecentlyProcessed: vi.fn().mockReturnValue(true),
      recordProcessed: vi.fn(),
      isMessageBooked: () => false,
      markMessageBooked: vi.fn(),
      noteMailboxUidValidity: vi.fn().mockReturnValue(false),
    };
    const handler = new ImapIdleHandler("h", 993, "u", "p", dedup);
    const callback = vi.fn();

    handler.connect = vi.fn(async () => {
      handler._client = {
        fetch: vi.fn(() => makeIter([makeMsg(200)])),
        idle: vi.fn(async () => {
          handler._running = false;
        }),
        logout: vi.fn(async () => {}),
      };
    });

    await handler.idleLoop(callback);
    expect(dedup.isRecentlyProcessed).toHaveBeenCalledWith("200");
    expect(callback).not.toHaveBeenCalled();
    expect(dedup.recordProcessed).not.toHaveBeenCalled();
  });

  it("tells the journal which mailbox epoch it is reading (#558)", async () => {
    const dedup = {
      isRecentlyProcessed: vi.fn().mockReturnValue(false),
      recordProcessed: vi.fn(),
      isMessageBooked: () => false,
      markMessageBooked: vi.fn(),
      noteMailboxUidValidity: vi.fn().mockReturnValue(false),
    };
    const handler = new ImapIdleHandler("h", 993, "u", "p", dedup);
    handler._client = {
      mailbox: { uidValidity: 222 },
      fetch: vi.fn(() => makeIter([])),
    };

    await handler.fetchUnread();

    expect(dedup.noteMailboxUidValidity).toHaveBeenCalledWith(222);
  });

  it("processes new UIDs and records after success", async () => {
    const dedup = {
      isRecentlyProcessed: vi.fn().mockReturnValue(false),
      recordProcessed: vi.fn(),
      isMessageBooked: () => false,
      markMessageBooked: vi.fn(),
      noteMailboxUidValidity: vi.fn().mockReturnValue(false),
    };
    const handler = new ImapIdleHandler("h", 993, "u", "p", dedup);
    const callback = vi.fn(async () => {});

    handler.connect = vi.fn(async () => {
      handler._client = {
        fetch: vi.fn(() => makeIter([makeMsg(300)])),
        idle: vi.fn(async () => {
          handler._running = false;
        }),
        logout: vi.fn(async () => {}),
      };
    });

    await handler.idleLoop(callback);
    expect(dedup.isRecentlyProcessed).toHaveBeenCalledWith("300");
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0][0].msg_id).toBe("300");
    expect(dedup.recordProcessed).toHaveBeenCalledWith("300");
  });

  it("does not record UID when callback throws", async () => {
    const dedup = {
      isRecentlyProcessed: vi.fn().mockReturnValue(false),
      recordProcessed: vi.fn(),
      isMessageBooked: () => false,
      markMessageBooked: vi.fn(),
      noteMailboxUidValidity: vi.fn().mockReturnValue(false),
    };
    const handler = new ImapIdleHandler("h", 993, "u", "p", dedup);
    const callback = vi.fn(async () => {
      throw new Error("processing failed");
    });

    handler.connect = vi.fn(async () => {
      handler._client = {
        fetch: vi.fn(() => makeIter([makeMsg(400)])),
        idle: vi.fn(async () => {
          handler._running = false;
        }),
        logout: vi.fn(async () => {}),
      };
    });

    await handler.idleLoop(callback);
    expect(callback).toHaveBeenCalledOnce();
    expect(dedup.recordProcessed).not.toHaveBeenCalled();
  });

  it("handles multiple messages mixing new and recent", async () => {
    const calls = [];
    const dedup = {
      isRecentlyProcessed: vi.fn((uid) => uid === "101"),
      recordProcessed: vi.fn((uid) => calls.push(`record:${uid}`)),
      isMessageBooked: () => false,
      markMessageBooked: vi.fn(),
      noteMailboxUidValidity: vi.fn().mockReturnValue(false),
    };
    const handler = new ImapIdleHandler("h", 993, "u", "p", dedup);
    const callback = vi.fn(async (msg) => calls.push(`callback:${msg.msg_id}`));

    handler.connect = vi.fn(async () => {
      handler._client = {
        fetch: vi.fn(() =>
          makeIter([makeMsg(100), makeMsg(101), makeMsg(102)]),
        ),
        idle: vi.fn(async () => {
          handler._running = false;
        }),
        logout: vi.fn(async () => {}),
      };
    });

    await handler.idleLoop(callback);
    expect(dedup.isRecentlyProcessed).toHaveBeenCalledTimes(3);
    // 101 was recent → skipped; 100 and 102 → processed
    expect(callback).toHaveBeenCalledTimes(2);
    expect(dedup.recordProcessed).toHaveBeenCalledTimes(2);
    expect(dedup.recordProcessed).toHaveBeenCalledWith("100");
    expect(dedup.recordProcessed).toHaveBeenCalledWith("102");
  });
});
// ── One-shot IMAP query (read-only, no IDLE, no mark-read) ─────────

describe("ImapIdleHandler.listInbox", () => {
  it("returns empty array when no messages match", async () => {
    const handler = new ImapIdleHandler("h", 993, "u", "p");
    const mockClient = {
      mailbox: { exists: 0 },
      mailboxOpen: vi.fn(async function () { this.mailbox = { exists: 0 }; }),
      fetch: vi.fn(() => ({
        [Symbol.asyncIterator]() { return { async next() { return { done: true }; } }; },
      })),
      logout: vi.fn(async () => {}),
    };
    handler._connectOnce = vi.fn(async () => mockClient);
    const result = await handler.listInbox({ limit: 10 });
    expect(result).toEqual([]);
    expect(mockClient.mailboxOpen).toHaveBeenCalledWith("INBOX");
    expect(mockClient.logout).toHaveBeenCalled();
  });

  it("returns message metadata in newest-first order", async () => {
    const handler = new ImapIdleHandler("h", 993, "u", "p");
    // IMAP returns ascending UID order; listInbox reverses so newest is first
    const mockMessages = [
      { uid: 500, envelope: { date: new Date("2026-06-15T10:00:00Z"), subject: "Hello world", from: [{ address: "sender@test.com", name: "Sender" }] } },
      { uid: 501, envelope: { date: new Date("2026-06-16T12:00:00Z"), subject: "Meeting notes", from: [{ address: "boss@test.com", name: "Boss" }] } },
    ];
    const mockClient = {
      mailbox: { exists: 502 },
      mailboxOpen: vi.fn(async function () { this.mailbox = { exists: 502 }; }),
      fetch: vi.fn(() => ({
        [Symbol.asyncIterator]() {
          let idx = 0;
          return { async next() { if (idx < mockMessages.length) return { value: mockMessages[idx++], done: false }; return { done: true }; } };
        },
      })),
      logout: vi.fn(async () => {}),
    };
    handler._connectOnce = vi.fn(async () => mockClient);
    const result = await handler.listInbox({ limit: 5 });
    expect(result).toHaveLength(2);
    // After reverse(), newest (uid 501) should be first
    expect(result[0]).toEqual({ uid: 501, from: "boss@test.com", fromName: "Boss", subject: "Meeting notes", date: "2026-06-16T12:00:00.000Z" });
    expect(result[1].uid).toBe(500);
    expect(mockClient.messageFlagsAdd).toBeUndefined();
  });

  it("respects limit parameter", async () => {
    const handler = new ImapIdleHandler("h", 993, "u", "p");
    const mockMessages = [
      { uid: 1, envelope: { date: new Date(), subject: "A", from: [{ address: "a@a.com" }] } },
      { uid: 2, envelope: { date: new Date(), subject: "B", from: [{ address: "b@b.com" }] } },
      { uid: 3, envelope: { date: new Date(), subject: "C", from: [{ address: "c@c.com" }] } },
    ];
    const mockClient = {
      mailbox: { exists: 100 },
      mailboxOpen: vi.fn(async function () { this.mailbox = { exists: 100 }; }),
      fetch: vi.fn(() => ({
        [Symbol.asyncIterator]() {
          let idx = 0;
          return { async next() { if (idx < mockMessages.length) return { value: mockMessages[idx++], done: false }; return { done: true }; } };
        },
      })),
      logout: vi.fn(async () => {}),
    };
    handler._connectOnce = vi.fn(async () => mockClient);
    const result = await handler.listInbox({ limit: 2 });
    expect(result).toHaveLength(2);
  });

  it("fetches newest messages using computed uid range", async () => {
    const handler = new ImapIdleHandler("h", 993, "u", "p");
    let fetchCalledWith = null;
    const mockClient = {
      mailbox: { exists: 500 },
      mailboxOpen: vi.fn(async function () { this.mailbox = { exists: 500 }; }),
      fetch: vi.fn((range, opts) => {
        fetchCalledWith = { range, opts };
        return { [Symbol.asyncIterator]() { return { async next() { return { done: true }; } }; } };
      }),
      logout: vi.fn(async () => {}),
    };
    handler._connectOnce = vi.fn(async () => mockClient);
    await handler.listInbox({ limit: 20 });
    // 500 total, limit 20 => should fetch UIDs 481-500
    expect(fetchCalledWith.range).toEqual({ uid: "481:*" });
    expect(fetchCalledWith.opts).toEqual({ envelope: true, source: false });
  });

  it("cleans up client on error", async () => {
    const handler = new ImapIdleHandler("h", 993, "u", "p");
    const mockClient = {
      mailboxOpen: vi.fn(async () => { throw new Error("Mailbox not found"); }),
      logout: vi.fn(async () => {}),
    };
    handler._connectOnce = vi.fn(async () => mockClient);
    await expect(handler.listInbox({ limit: 10 })).rejects.toThrow("Mailbox not found");
    expect(mockClient.logout).toHaveBeenCalled();
  });
});

describe("ImapIdleHandler.readInboxEmail", () => {
  it("fetches full email by UID without marking read", async () => {
    const handler = new ImapIdleHandler("h", 993, "u", "p");
    const raw = "From: test@test.com\r\nSubject: Test Email\r\nDate: Mon, 16 Jun 2026 10:00:00 +0000\r\n\r\nEmail body here.";
    const emailSource = Buffer.from(raw);
    let fetchCalledWith = null;
    const mockClient = {
      mailboxOpen: vi.fn(async () => {}),
      fetch: vi.fn((range, opts) => {
        fetchCalledWith = { range, opts };
        return {
          [Symbol.asyncIterator]() {
            let yielded = false;
            return { async next() { if (!yielded) { yielded = true; return { value: { uid: 42, source: emailSource, envelope: { from: [{ address: "test@test.com", name: "Tester" }] } }, done: false }; } return { done: true }; } };
          },
        };
      }),
      logout: vi.fn(async () => {}),
    };
    handler._connectOnce = vi.fn(async () => mockClient);
    const result = await handler.readInboxEmail(42);
    expect(result).toBeDefined();
    expect(result.uid).toBe(42);
    expect(result.subject).toBe("Test Email");
    expect(result.from).toBe("test@test.com");
    expect(result.fromDisplay).toBe("test@test.com");
    expect(result.text).toContain("Email body here");
    expect(fetchCalledWith.range).toEqual({ uid: "42" });
    expect(fetchCalledWith.opts).toEqual({ source: true, envelope: true });
    expect(mockClient.messageFlagsAdd).toBeUndefined();
  });

  it("returns null when email not found", async () => {
    const handler = new ImapIdleHandler("h", 993, "u", "p");
    const mockClient = {
      mailboxOpen: vi.fn(async () => {}),
      fetch: vi.fn(() => ({ [Symbol.asyncIterator]() { return { async next() { return { done: true }; } }; } })),
      logout: vi.fn(async () => {}),
    };
    handler._connectOnce = vi.fn(async () => mockClient);
    const result = await handler.readInboxEmail(99999);
    expect(result).toBeNull();
  });

  it("cleans up client on error", async () => {
    const handler = new ImapIdleHandler("h", 993, "u", "p");
    const mockClient = {
      mailboxOpen: vi.fn(async () => {}),
      fetch: vi.fn(() => { throw new Error("Connection lost"); }),
      logout: vi.fn(async () => {}),
    };
    handler._connectOnce = vi.fn(async () => mockClient);
    await expect(handler.readInboxEmail(42)).rejects.toThrow("Connection lost");
    expect(mockClient.logout).toHaveBeenCalled();
  });
});
