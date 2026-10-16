/**
 * Prompts tests — SYSTEM_PROMPT structure, FEW_SHOT_EXAMPLES count,
 * _loadLearnedContext, extra prompt injection.
 * Mocks fs.readFileSync for mappings path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";

describe("SYSTEM_PROMPT", () => {
    let SYSTEM_PROMPT;

    // We need to test the module, but it loads at import time.
    // Let's test via dynamic import after mocking.
    beforeEach(() => {
        vi.resetModules();
        // Default: no mappings file
        vi.spyOn(fs, "existsSync").mockReturnValue(false);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("contains the user name placeholder", async () => {
        const mod = await import("../src/prompts.js");
        expect(mod.SYSTEM_PROMPT).toContain("there");
    });

    it("contains RULES section", async () => {
        const mod = await import("../src/prompts.js");
        expect(mod.SYSTEM_PROMPT).toContain("RULES:");
        expect(mod.SYSTEM_PROMPT).toContain("NEVER insert a transaction");
    });

    it("contains SECURITY MATCHING section", async () => {
        const mod = await import("../src/prompts.js");
        expect(mod.SYSTEM_PROMPT).toContain("SECURITY MATCHING:");
        expect(mod.SYSTEM_PROMPT).toContain("Match securities by ISIN first");
    });

    it("contains ACCOUNT MATCHING section", async () => {
        const mod = await import("../src/prompts.js");
        expect(mod.SYSTEM_PROMPT).toContain("ACCOUNT MATCHING:");
        expect(mod.SYSTEM_PROMPT).toContain("IBKR flex queries");
    });

    it("contains CURRENCY HANDLING section", async () => {
        const mod = await import("../src/prompts.js");
        expect(mod.SYSTEM_PROMPT).toContain("CURRENCY HANDLING:");
        expect(mod.SYSTEM_PROMPT).toContain("Detect currency from document");
    });

    it("contains MEMORY section", async () => {
        const mod = await import("../src/prompts.js");
        expect(mod.SYSTEM_PROMPT).toContain("MEMORY:");
        expect(mod.SYSTEM_PROMPT).toContain("learn_mapping()");
    });

    it("contains WORKFLOW section", async () => {
        const mod = await import("../src/prompts.js");
        expect(mod.SYSTEM_PROMPT).toContain("WORKFLOW — DAILY SYNC");
        expect(mod.SYSTEM_PROMPT).toContain("WORKFLOW — MANUAL TRADE");
        expect(mod.SYSTEM_PROMPT).toContain("Classify intent");
    });

    it("contains BALANCE SYNC WORKFLOW section", async () => {
        const mod = await import("../src/prompts.js");
        expect(mod.SYSTEM_PROMPT).toContain("BALANCE SYNC WORKFLOW:");
        expect(mod.SYSTEM_PROMPT).toContain("pp-sync-all()");
    });

    it("contains TAXONOMY EXPORT WORKFLOW section", async () => {
        const mod = await import("../src/prompts.js");
        expect(mod.SYSTEM_PROMPT).toContain("TAXONOMY EXPORT WORKFLOW:");
        expect(mod.SYSTEM_PROMPT).toContain("query_pp_taxonomies");
    });

    it("instructs asking user to forward PDF when trade email has no attachment", async () => {
        const mod = await import("../src/prompts.js");
        expect(mod.SYSTEM_PROMPT).toContain("forward the PDF via Telegram");
        expect(mod.SYSTEM_PROMPT).toContain("no PDF is attached");
    });

    it("does not crash when mappings file is invalid JSON", async () => {
        vi.restoreAllMocks();
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        vi.spyOn(fs, "readFileSync").mockImplementation(() => {
            throw new SyntaxError("Bad JSON");
        });
        vi.resetModules();

        // Should import without error
        const mod = await import("../src/prompts.js");
        expect(mod.SYSTEM_PROMPT).toBeDefined();
        expect(mod.SYSTEM_PROMPT.length).toBeGreaterThan(100);
    });

    it("contains missing-PDF rule (rule 13)", async () => {
        const mod = await import("../src/prompts.js");
        expect(mod.SYSTEM_PROMPT).toContain("extract_email_content()");
        expect(mod.SYSTEM_PROMPT).toContain("no PDF");
        expect(mod.SYSTEM_PROMPT).toContain("forward the PDF via Telegram");
    });

    it("never asks for, looks up or stores a statement password (#783)", async () => {
        const mod = await import("../src/prompts.js");
        expect(mod.SYSTEM_PROMPT).toContain("PASSWORD-PROTECTED PDFs:");
        expect(mod.SYSTEM_PROMPT).toContain("[PDF_ENCRYPTED]");
        expect(mod.SYSTEM_PROMPT).not.toMatch(/password=/);
        expect(mod.SYSTEM_PROMPT).not.toMatch(/statement password is/);
        expect(mod.SYSTEM_PROMPT).not.toMatch(/What's the password/);
        expect(mod.SYSTEM_PROMPT).toContain("Never ask for, search for or store a password");
    });

    it("explicitly avoids mark_email_read (not a PT tool)", async () => {
        const mod = await import("../src/prompts.js");
        // The rules section should NOT instruct the LLM to call mark_email_read
        // (the PT has no such tool; dispatchEmail handles it in finally)
        const rulesSection = mod.SYSTEM_PROMPT.split("WORKFLOW")[0];
        expect(rulesSection).not.toContain("mark_email_read");
    });

    it("has exactly 13 numbered rules", async () => {
        const mod = await import("../src/prompts.js");
        const rulesSection = mod.SYSTEM_PROMPT.split("WORKFLOW")[0];
        // Count numbered rules (digit followed by period and space)
        const ruleMatches = rulesSection.match(/^\s*\d+\.\s/gm);
        expect(ruleMatches).not.toBeNull();
        expect(ruleMatches.length).toBe(13);
    });
});

describe("FEW_SHOT_EXAMPLES", () => {
    let FEW_SHOT_EXAMPLES;

    beforeEach(async () => {
        vi.resetModules();
        vi.restoreAllMocks();
        vi.spyOn(fs, "existsSync").mockReturnValue(false);
        const mod = await import("../src/prompts.js");
        FEW_SHOT_EXAMPLES = mod.FEW_SHOT_EXAMPLES;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("has at least 3 examples", () => {
        expect(FEW_SHOT_EXAMPLES.length).toBeGreaterThanOrEqual(3);
    });

    it("first example is an IBKR flex query scenario", () => {
        const example1 = FEW_SHOT_EXAMPLES[0];
        const userMsg = example1.find((m) => m.role === "user");
        expect(userMsg).toBeDefined();
        expect(userMsg.content).toContain("IBKR");
    });

    it("each example contains user and assistant roles", () => {
        for (const example of FEW_SHOT_EXAMPLES) {
            const roles = example.map((m) => m.role);
            expect(roles).toContain("user");
            expect(roles).toContain("assistant");
        }
    });

    it("each example contains at least one tool call message", () => {
        for (const example of FEW_SHOT_EXAMPLES) {
            const hasToolCalls = example.some((m) => m.tool_calls);
            const hasToolRole = example.some((m) => m.role === "tool");
            // Either tool_calls or tool role should be present
            expect(hasToolCalls || hasToolRole).toBe(true);
        }
    });

    it("examples reference pp-pull as first tool call in IBKR scenario", () => {
        const example1 = FEW_SHOT_EXAMPLES[0];
        const assistantWithCalls = example1.find((m) => m.tool_calls);
        expect(assistantWithCalls).toBeDefined();
        const toolNames = assistantWithCalls.tool_calls.map(
            (tc) => tc.function.name,
        );
        expect(toolNames).toContain("pp-pull");
    });

    it("example 2 covers user approval workflow", () => {
        const example2 = FEW_SHOT_EXAMPLES[1];
        const userMsg = example2.find((m) => m.role === "user");
        expect(userMsg.content.toLowerCase()).toContain("approve");
        // Should contain insert_pp_transaction calls
        const hasInsert = example2.some((m) => {
            if (!m.tool_calls) return false;
            return m.tool_calls.some(
                (tc) => tc.function.name === "insert_pp_transaction",
            );
        });
        expect(hasInsert).toBe(true);
    });

    it("example 3 covers PDF receipt OCR scenario", () => {
        const example3 = FEW_SHOT_EXAMPLES[2];
        const userMsg = example3.find((m) => m.role === "user");
        expect(userMsg.content).toContain("PDF");
        const hasCheckDuplicate = example3.some((m) => {
            if (!m.tool_calls) return false;
            return m.tool_calls.some(
                (tc) => tc.function.name === "check_duplicate",
            );
        });
        expect(hasCheckDuplicate).toBe(true);
    });

    it("tool_call_ids within each example are unique", () => {
        for (const example of FEW_SHOT_EXAMPLES) {
            const ids = [];
            for (const msg of example) {
                if (msg.tool_call_id) ids.push(msg.tool_call_id);
            }
            const uniqueIds = new Set(ids);
            // IDs should be unique WITHIN each example scenario
            expect(uniqueIds.size).toBe(ids.length);
        }
    });
});
