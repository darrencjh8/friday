/**
 * MemoryStore tests — learn, recall, recallAll, forget, persistence.
 * Uses temp JSON file for each test to ensure isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../src/memory.js";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import crypto from "crypto";

function tmpPath() {
  return join(tmpdir(), `test-memory-${crypto.randomUUID()}.json`);
}

describe("MemoryStore", () => {
  let store;
  let path;

  beforeEach(() => {
    path = tmpPath();
    store = new MemoryStore(path);
  });

  afterEach(() => {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // ignore
    }
  });

  describe("learn", () => {
    it("learns a securities mapping", () => {
      store.learn("securities", "AAPL", "sec-aapl");
      expect(store.recall("securities", "AAPL")).toBe("sec-aapl");
    });

    it("learns an account mapping", () => {
      store.learn("accounts", "IBKR", "acct-ibkr-usd");
      expect(store.recall("accounts", "IBKR")).toBe("acct-ibkr-usd");
    });

    it("learns a category mapping", () => {
      store.learn("categories", "Food", "category-food");
      expect(store.recall("categories", "Food")).toBe("category-food");
    });

    it("learns a broker mapping", () => {
      store.learn("brokers", "Interactive Brokers", "broker-ibkr");
      expect(store.recall("brokers", "Interactive Brokers")).toBe("broker-ibkr");
    });

    it("trims whitespace from key and value", () => {
      store.learn("securities", "  AAPL  ", "  sec-aapl  ");
      expect(store.recall("securities", "AAPL")).toBe("sec-aapl");
    });

    it("normalizes key to lowercase", () => {
      store.learn("securities", "AAPL", "sec-aapl");
      expect(store.recall("securities", "aapl")).toBe("sec-aapl");
      expect(store.recall("securities", "AAPL")).toBe("sec-aapl");
      expect(store.recall("securities", "Aapl")).toBe("sec-aapl");
    });

    it("overwrites existing mapping for same key", () => {
      store.learn("securities", "AAPL", "sec-aapl");
      store.learn("securities", "AAPL", "sec-aapl-new");
      expect(store.recall("securities", "AAPL")).toBe("sec-aapl-new");
    });
  });

  describe("recall", () => {
    it("returns null for unknown key", () => {
      expect(store.recall("securities", "nonexistent")).toBeNull();
    });

    it("returns null for unknown mapping type", () => {
      // using a type that's not in the default data structure
      // the code handles it via optional chaining
      expect(store.recall("nonexistent_type", "test")).toBeNull();
    });

    it("returns learned value case-insensitively", () => {
      store.learn("securities", "VWRA", "sec-vwra");
      expect(store.recall("securities", "vwra")).toBe("sec-vwra");
      expect(store.recall("securities", "VWRA")).toBe("sec-vwra");
      expect(store.recall("securities", "Vwra")).toBe("sec-vwra");
    });
  });

  describe("recallAll", () => {
    it("returns empty object for empty mappings", () => {
      const all = store.recallAll("securities");
      expect(all).toEqual({});
    });

    it("returns all learned mappings for a type sorted alphabetically", () => {
      store.learn("securities", "MSFT", "sec-msft");
      store.learn("securities", "AAPL", "sec-aapl");
      store.learn("securities", "GOOG", "sec-goog");
      const all = store.recallAll("securities");
      const keys = Object.keys(all);
      expect(keys).toEqual(["aapl", "goog", "msft"]); // alphabetically sorted
      expect(all["aapl"]).toBe("sec-aapl");
      expect(all["goog"]).toBe("sec-goog");
      expect(all["msft"]).toBe("sec-msft");
    });

    it("returns empty object for unknown mapping type", () => {
      const all = store.recallAll("nonexistent");
      expect(all).toEqual({});
    });

    it("returns multiple mapping types independently", () => {
      store.learn("securities", "AAPL", "sec-aapl");
      store.learn("accounts", "IBKR", "acct-ibkr");
      expect(store.recallAll("securities")).toEqual({ aapl: "sec-aapl" });
      expect(store.recallAll("accounts")).toEqual({ ibkr: "acct-ibkr" });
    });
  });

  describe("forget", () => {
    it("removes a learned mapping", () => {
      store.learn("securities", "AAPL", "sec-aapl");
      expect(store.recall("securities", "AAPL")).toBe("sec-aapl");
      store.forget("securities", "AAPL");
      expect(store.recall("securities", "AAPL")).toBeNull();
    });

    it("removes mapping case-insensitively", () => {
      store.learn("securities", "AAPL", "sec-aapl");
      store.forget("securities", "aapl");
      expect(store.recall("securities", "AAPL")).toBeNull();
    });

    it("does not throw when forgetting nonexistent key", () => {
      expect(() => store.forget("securities", "nonexistent")).not.toThrow();
    });

    it("does not throw when forgetting from nonexistent type", () => {
      expect(() => store.forget("nonexistent", "test")).not.toThrow();
    });
  });

  describe("persistence", () => {
    it("persists mappings to disk and reloads", () => {
      store.learn("securities", "AAPL", "sec-aapl");
      store.learn("accounts", "IBKR", "acct-ibkr");

      // Create a new store pointing to the same file
      const store2 = new MemoryStore(path);
      expect(store2.recall("securities", "AAPL")).toBe("sec-aapl");
      expect(store2.recall("accounts", "IBKR")).toBe("acct-ibkr");
    });

    it("handles corrupted JSON gracefully", () => {
      // Write invalid JSON to disk
      writeFileSync(path, "this is not valid json", "utf8");
      const store2 = new MemoryStore(path);
      // Should fall back to defaults
      expect(store2.recall("securities", "anything")).toBeNull();
      expect(store2.recallAll("securities")).toEqual({});
    });

    it("handles empty file gracefully", () => {
      writeFileSync(path, "", "utf8");
      const store2 = new MemoryStore(path);
      // JSON.parse on empty string throws SyntaxError, caught by try/catch
      expect(store2.recall("securities", "anything")).toBeNull();
    });

    it("handles non-existent file gracefully", () => {
      const nonexistent = join(tmpdir(), `nonexistent-${crypto.randomUUID()}.json`);
      const store2 = new MemoryStore(nonexistent);
      expect(store2.recall("securities", "anything")).toBeNull();
    });
  });
});
