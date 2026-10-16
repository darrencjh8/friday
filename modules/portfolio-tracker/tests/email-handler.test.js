/**
 * Email handler tests — extraction, classification, multipart handling.
 * Ported from tests/test_email_handler.py
 */
import { describe, it, expect } from "vitest";
import { extractEmailContent } from "../src/email_handler.js";

describe("extractEmailContent — HTML extraction", () => {
  it("strips HTML tags and returns plain text", async () => {
    // Must be proper MIME for mailparser to detect text/html part
    const rawEmail = [
      "From: alerts@example.com",
      "Subject: Receipt",
      "Content-Type: text/html",
      "",
      "<html><body><p>S$12.80 at <b>Toast Box</b></p></body></html>",
    ].join("\r\n");
    const result = await extractEmailContent(rawEmail);
    expect(result).toContain("S$12.80");
    expect(result).toContain("Toast Box");
    expect(result).not.toContain("<b>");
  });

  it("returns plain text email content as-is", async () => {
    const rawEmail =
      "From: alerts@example.com\r\nSubject: Alert\r\n\r\nDBS Alert: S$12.80 at Toast Box";
    const result = await extractEmailContent(rawEmail);
    expect(result).toContain("DBS Alert");
    expect(result).toContain("Toast Box");
  });

  it("handles empty email body", async () => {
    const rawEmail = "From: test@test.com\r\nSubject: Empty\r\n\r\n";
    const result = await extractEmailContent(rawEmail);
    // Should return the headers at minimum
    expect(result).toContain("From:");
    expect(result).toContain("Subject:");
  });

  it("strips email signatures (-- marker)", async () => {
    const rawEmail =
      "From: test@test.com\r\nSubject: Test\r\n\r\nTransaction: S$12.80\n\n-- \nSent from my iPhone";
    const result = await extractEmailContent(rawEmail);
    expect(result).toContain("S$12.80");
    expect(result).not.toContain("Sent from my iPhone");
  });

  it("strips -- without trailing space as signature end", async () => {
    const rawEmail =
      "From: test@test.com\r\nSubject: Test\r\n\r\nBody\n\n--\nSent from Android";
    const result = await extractEmailContent(rawEmail);
    expect(result).toContain("Body");
    expect(result).not.toContain("Sent from Android");
  });
});

describe("extractEmailContent — multipart", () => {
  it("prefers plain text over HTML in multipart emails", async () => {
    const rawEmail = [
      "From: sender@test.com",
      "Subject: Multipart Test",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="boundary123"',
      "",
      "--boundary123",
      "Content-Type: text/plain",
      "",
      "Plain text version: S$12.80",
      "--boundary123",
      "Content-Type: text/html",
      "",
      "<html><p>HTML version</p></html>",
      "--boundary123--",
    ].join("\r\n");

    const result = await extractEmailContent(rawEmail);
    expect(result).toContain("Plain text version");
    expect(result).toContain("S$12.80");
  });

  it("falls back to HTML when no plain text part", async () => {
    const rawEmail = [
      "From: sender@test.com",
      "Subject: HTML Only",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="boundary456"',
      "",
      "--boundary456",
      "Content-Type: text/html",
      "",
      "<html><p>S$12.80 at Toast Box</p></html>",
      "--boundary456--",
    ].join("\r\n");

    const result = await extractEmailContent(rawEmail);
    expect(result).toContain("S$12.80");
    expect(result).toContain("Toast Box");
  });
});

describe("cleanText — edge cases", () => {
  it("truncates very long text", async () => {
    const longBody = "X".repeat(10000);
    const rawEmail = `From: test@test.com\r\nSubject: Long\r\n\r\n${longBody}`;
    const result = await extractEmailContent(rawEmail);
    // Should not contain the full 10k chars (default max 8000)
    expect(result.length).toBeLessThan(10000);
  });
});
