/**
 * Google Sheets API client tests.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockGet, mockUpdate, mockAppend } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockUpdate: vi.fn(),
  mockAppend: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: vi.fn().mockImplementation(() => ({})),
    },
    sheets: vi.fn().mockReturnValue({
      spreadsheets: {
        values: {
          get: mockGet,
          update: mockUpdate,
          append: mockAppend,
        },
      },
    }),
  },
}));

import { SheetsClient } from "../src/sheets_client.js";

const validServiceAccountJson = JSON.stringify({
  client_email: "test@example.com",
  private_key: "test-key",
});

describe("SheetsClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("creates client with service account JSON and sheet ID", () => {
      const client = new SheetsClient(validServiceAccountJson, "sheet-123");
      expect(client._sheetId).toBe("sheet-123");
      expect(client._sheets).toBeDefined();
    });

    it("throws SyntaxError on invalid JSON string", () => {
      expect(() => new SheetsClient("not-valid-json", "sheet-123")).toThrow(
        SyntaxError,
      );
    });
  });

  describe("readRange", () => {
    it("returns values from API response", async () => {
      mockGet.mockResolvedValue({ data: { values: [["A1", "B1"]] } });
      const client = new SheetsClient(validServiceAccountJson, "sheet-123");
      const result = await client.readRange("Sheet1!A1:B1");
      expect(mockGet).toHaveBeenCalledWith({
        spreadsheetId: "sheet-123",
        range: "Sheet1!A1:B1",
      });
      expect(result).toEqual([["A1", "B1"]]);
    });

    it("returns empty array when response has no values", async () => {
      mockGet.mockResolvedValue({ data: {} });
      const client = new SheetsClient(validServiceAccountJson, "sheet-123");
      const result = await client.readRange("Sheet1!A1:B1");
      expect(result).toEqual([]);
    });

    it("returns empty array when values is null", async () => {
      mockGet.mockResolvedValue({ data: { values: null } });
      const client = new SheetsClient(validServiceAccountJson, "sheet-123");
      const result = await client.readRange("Sheet1!A1:B1");
      expect(result).toEqual([]);
    });

    it("propagates API errors", async () => {
      mockGet.mockRejectedValue(new Error("Google API error"));
      const client = new SheetsClient(validServiceAccountJson, "sheet-123");
      await expect(client.readRange("Sheet1!A1:B1")).rejects.toThrow(
        "Google API error",
      );
    });
  });

  describe("writeRange", () => {
    it("writes values to the sheet", async () => {
      mockUpdate.mockResolvedValue({});
      const client = new SheetsClient(validServiceAccountJson, "sheet-123");
      await client.writeRange("Sheet1!A1", [["Hello"]]);
      expect(mockUpdate).toHaveBeenCalledWith({
        spreadsheetId: "sheet-123",
        range: "Sheet1!A1",
        valueInputOption: "RAW",
        requestBody: { values: [["Hello"]] },
      });
    });

    it("propagates API errors on write", async () => {
      mockUpdate.mockRejectedValue(new Error("Write denied"));
      const client = new SheetsClient(validServiceAccountJson, "sheet-123");
      await expect(client.writeRange("Sheet1!A1", [["x"]])).rejects.toThrow(
        "Write denied",
      );
    });
  });

  describe("appendRow", () => {
    it("appends a row to the sheet", async () => {
      mockAppend.mockResolvedValue({});
      const client = new SheetsClient(validServiceAccountJson, "sheet-123");
      await client.appendRow("Sheet1!A1:C1", ["a", "b", "c"]);
      expect(mockAppend).toHaveBeenCalledWith({
        spreadsheetId: "sheet-123",
        range: "Sheet1!A1:C1",
        valueInputOption: "RAW",
        requestBody: { values: [["a", "b", "c"]] },
      });
    });

    it("handles empty row array", async () => {
      mockAppend.mockResolvedValue({});
      const client = new SheetsClient(validServiceAccountJson, "sheet-123");
      await client.appendRow("Sheet1!A1", []);
      expect(mockAppend).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: { values: [[]] },
        }),
      );
    });

    it("handles undefined row values gracefully", async () => {
      mockAppend.mockResolvedValue({});
      const client = new SheetsClient(validServiceAccountJson, "sheet-123");
      await client.appendRow("Sheet1!A1", [undefined]);
      expect(mockAppend).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: { values: [[undefined]] },
        }),
      );
    });

    it("propagates API errors on append", async () => {
      mockAppend.mockRejectedValue(new Error("Append failed"));
      const client = new SheetsClient(validServiceAccountJson, "sheet-123");
      await expect(client.appendRow("Sheet1!A1", ["x"])).rejects.toThrow(
        "Append failed",
      );
    });
  });
});
