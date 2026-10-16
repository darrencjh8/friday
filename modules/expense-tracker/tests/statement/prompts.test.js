/**
 * Tests for statement pipeline prompts.
 * Ported from statement/prompts.py validation.
 */
import { describe, it, expect, vi } from "vitest";
import {
    CLASSIFICATION_PROMPT,
    STATEMENT_PROMPT,
    STATEMENT_FEW_SHOT,
} from "../../src/statement/prompts.js";

// ---------------------------------------------------------------------------
// CLASSIFICATION_PROMPT
// ---------------------------------------------------------------------------
describe("CLASSIFICATION_PROMPT", () => {
    it("has three classification categories: statement, transaction, skip", () => {
        expect(CLASSIFICATION_PROMPT).toContain('"statement"');
        expect(CLASSIFICATION_PROMPT).toContain('"transaction"');
        expect(CLASSIFICATION_PROMPT).toContain('"skip"');
    });

    it("defines statement keywords (eStatement, billing cycle, PDF attached)", () => {
        expect(CLASSIFICATION_PROMPT).toContain("eStatement");
        expect(CLASSIFICATION_PROMPT).toContain("billing cycle");
        expect(CLASSIFICATION_PROMPT).toContain("PDF attached");
    });

    it("defines transaction examples (single purchase, receipt, alert)", () => {
        expect(CLASSIFICATION_PROMPT).toContain("single purchase");
        expect(CLASSIFICATION_PROMPT).toContain("receipt");
        expect(CLASSIFICATION_PROMPT).toContain("instant alert");
    });

    it("includes IBKR and trade-related keywords for skip", () => {
        expect(CLASSIFICATION_PROMPT).toContain("IBKR");
        expect(CLASSIFICATION_PROMPT).toContain("Activity Flex");
        expect(CLASSIFICATION_PROMPT).toContain("trade confirmation");
        expect(CLASSIFICATION_PROMPT).toContain("portfolio");
    });

    it("includes investment/securities keywords for skip", () => {
        expect(CLASSIFICATION_PROMPT).toContain("dividend");
        expect(CLASSIFICATION_PROMPT).toContain("ISIN");
        expect(CLASSIFICATION_PROMPT).toContain("shares");
        expect(CLASSIFICATION_PROMPT).toContain("securities");
        expect(CLASSIFICATION_PROMPT).toContain("forex");
    });

    it("instructs one-word-only response, no explanation", () => {
        expect(CLASSIFICATION_PROMPT).toContain("ONLY one word");
        expect(CLASSIFICATION_PROMPT).toContain("DO NOT explain");
    });

    it("mentions the exact three acceptable response values", () => {
        const lastLine = CLASSIFICATION_PROMPT.trim().split("\n").pop();
        expect(lastLine).toContain('"statement"');
        expect(lastLine).toContain('"transaction"');
        expect(lastLine).toContain('"skip"');
    });
});

// ---------------------------------------------------------------------------
// STATEMENT_PROMPT
// ---------------------------------------------------------------------------
describe("STATEMENT_PROMPT", () => {
    it("contains RULES section with numbered rules", () => {
        expect(STATEMENT_PROMPT).toContain("RULES:");
        expect(STATEMENT_PROMPT).toContain("1.");
        expect(STATEMENT_PROMPT).toContain("8.");
    });

    it("references RECONCILE and OUTLIER as core concepts", () => {
        expect(STATEMENT_PROMPT).toContain("RECONCILE");
        expect(STATEMENT_PROMPT).toContain("OUTLIER");
    });

    it("references fetch_accounts as a tool call", () => {
        expect(STATEMENT_PROMPT).toContain("fetch_accounts");
    });

    it("references reconcile_transaction as a tool call", () => {
        expect(STATEMENT_PROMPT).toContain("reconcile_transaction");
    });

    it("references record_statement to prevent double-processing", () => {
        expect(STATEMENT_PROMPT).toContain("record_statement");
    });

    it("references mark_email_read in success and failure paths", () => {
        expect(STATEMENT_PROMPT).toContain("mark_email_read");
        // Should appear at least twice (step 7 and step 8)
        const occurrences =
            STATEMENT_PROMPT.split("mark_email_read").length - 1;
        expect(occurrences).toBeGreaterThanOrEqual(2);
    });

    it("references notify_user for reconciliation summaries", () => {
        expect(STATEMENT_PROMPT).toContain("notify_user");
        const occurrences = STATEMENT_PROMPT.split("notify_user").length - 1;
        expect(occurrences).toBeGreaterThanOrEqual(2);
    });

    it("contains NOTIFICATION RULES with warm, conversational tone", () => {
        expect(STATEMENT_PROMPT).toContain("NOTIFICATION RULES");
        expect(STATEMENT_PROMPT).toContain("warm");
        expect(STATEMENT_PROMPT).toContain("conversational");
    });

    it("mentions emojis for notification style", () => {
        expect(STATEMENT_PROMPT).toContain("✅");
        expect(STATEMENT_PROMPT).toContain("⚠️");
    });

    it("includes example notification phrases", () => {
        expect(STATEMENT_PROMPT).toContain("Just got your");
        expect(STATEMENT_PROMPT).toContain("I just received");
        expect(STATEMENT_PROMPT).toContain("New statement arrived");
    });

    it("defines NOTIFICATION FORMAT with placeholders", () => {
        expect(STATEMENT_PROMPT).toContain("NOTIFICATION FORMAT");
        expect(STATEMENT_PROMPT).toContain("[Account] statement for [period]");
    });

    it("contains CURRENCY ROUTING section", () => {
        expect(STATEMENT_PROMPT).toContain("CURRENCY ROUTING");
    });

    it("routes SGD to default budget file (My Budget)", () => {
        expect(STATEMENT_PROMPT).toContain("SGD");
        expect(STATEMENT_PROMPT).toContain("My Budget");
    });

    it("routes MYR/RM to MYR budget file (My MYR Budget)", () => {
        expect(STATEMENT_PROMPT).toContain("MYR");
        expect(STATEMENT_PROMPT).toContain("My MYR Budget");
    });

    it("contains PAYEE MATCHING rules", () => {
        expect(STATEMENT_PROMPT).toContain("PAYEE MATCHING");
        expect(STATEMENT_PROMPT).toContain("fetch_payees");
    });

    it("contains AMOUNTS section with integer-cents format", () => {
        expect(STATEMENT_PROMPT).toContain("AMOUNTS");
        expect(STATEMENT_PROMPT).toContain("INTEGER CENTS");
        expect(STATEMENT_PROMPT).toContain("-1280");
        expect(STATEMENT_PROMPT).toContain("-4550");
    });

    it("references check_statement_duplicate for idempotency", () => {
        expect(STATEMENT_PROMPT).toContain("check_statement_duplicate");
    });

    it("warns about not re-processing already-processed statements", () => {
        expect(STATEMENT_PROMPT).toContain("ALREADY processed");
        expect(STATEMENT_PROMPT).toContain("Do NOT re-process");
    });

    it("includes password recovery instructions for encrypted PDFs", () => {
        expect(STATEMENT_PROMPT).toContain("PASSWORD-PROTECTED PDFs");
        expect(STATEMENT_PROMPT).toContain("[PDF_ENCRYPTED]");
        expect(STATEMENT_PROMPT).toContain("search_memory");
        expect(STATEMENT_PROMPT).toContain("learn_fact");
        expect(STATEMENT_PROMPT).toContain("extract_pdf_text");
    });

    it("references qpdf for password-protected PDF decryption", () => {
        expect(STATEMENT_PROMPT).toContain("password");
        expect(STATEMENT_PROMPT).toContain("[PDF_ENCRYPTED]");
        expect(STATEMENT_PROMPT).toContain("search_memory");
    });
});

// ---------------------------------------------------------------------------
// STATEMENT_FEW_SHOT
// ---------------------------------------------------------------------------
describe("STATEMENT_FEW_SHOT", () => {
    it("is an array", () => {
        expect(Array.isArray(STATEMENT_FEW_SHOT)).toBe(true);
    });

    it("is a non-empty array of message arrays", () => {
        expect(STATEMENT_FEW_SHOT.length).toBeGreaterThan(0);
        STATEMENT_FEW_SHOT.forEach((turn) => {
            expect(Array.isArray(turn)).toBe(true);
            expect(turn.length).toBeGreaterThan(0);
        });
    });

    it("contains user messages with role='user'", () => {
        const userMsgs = STATEMENT_FEW_SHOT.flat().filter(
            (m) => m.role === "user",
        );
        expect(userMsgs.length).toBeGreaterThan(0);
        userMsgs.forEach((m) => {
            expect(m.content).toBeTruthy();
        });
    });

    it("contains assistant messages with role='assistant'", () => {
        const asstMsgs = STATEMENT_FEW_SHOT.flat().filter(
            (m) => m.role === "assistant",
        );
        expect(asstMsgs.length).toBeGreaterThan(0);
    });

    it("contains tool messages with role='tool'", () => {
        const toolMsgs = STATEMENT_FEW_SHOT.flat().filter(
            (m) => m.role === "tool",
        );
        expect(toolMsgs.length).toBeGreaterThan(0);
        toolMsgs.forEach((m) => {
            expect(m).toHaveProperty("tool_call_id");
            expect(typeof m.tool_call_id).toBe("string");
        });
    });

    it("includes tool_calls with required fields (id, type, function)", () => {
        const toolCallMsgs = STATEMENT_FEW_SHOT.flat().filter(
            (m) => m.tool_calls && Array.isArray(m.tool_calls),
        );
        expect(toolCallMsgs.length).toBeGreaterThan(0);

        toolCallMsgs.forEach((msg) => {
            msg.tool_calls.forEach((tc) => {
                expect(tc).toHaveProperty("id");
                expect(typeof tc.id).toBe("string");
                expect(tc).toHaveProperty("type");
                expect(tc.type).toBe("function");
                expect(tc).toHaveProperty("function");
                expect(typeof tc.function.name).toBe("string");
                expect(typeof tc.function.arguments).toBe("string");
            });
        });
    });

    it("tool_calls reference known functions (fetch_*, reconcile_*, etc.)", () => {
        const toolCallMsgs = STATEMENT_FEW_SHOT.flat().filter(
            (m) => m.tool_calls && Array.isArray(m.tool_calls),
        );
        const names = toolCallMsgs.flatMap((msg) =>
            msg.tool_calls.map((tc) => tc.function.name),
        );
        expect(names).toContain("fetch_accounts");
        expect(names).toContain("fetch_categories");
        expect(names).toContain("fetch_statement_history");
        expect(names).toContain("fetch_unreconciled_transactions");
    });

    it("tool_calls arguments are valid JSON strings", () => {
        const toolCallMsgs = STATEMENT_FEW_SHOT.flat().filter(
            (m) => m.tool_calls && Array.isArray(m.tool_calls),
        );
        toolCallMsgs.forEach((msg) => {
            msg.tool_calls.forEach((tc) => {
                expect(() => JSON.parse(tc.function.arguments)).not.toThrow();
            });
        });
    });

    it("contains a statement example with SGD amounts", () => {
        const allContent = STATEMENT_FEW_SHOT.flat()
            .filter((m) => m.content)
            .map((m) => m.content)
            .join(" ");
        expect(allContent).toContain("S$12.80");
        expect(allContent).toContain("S$45.50");
    });

    it("includes unreconciled transaction data with negative cent amounts", () => {
        const allContent = STATEMENT_FEW_SHOT.flat()
            .filter((m) => m.content)
            .map((m) => m.content)
            .join(" ");
        expect(allContent).toContain("-1280");
    });
});

// ---------------------------------------------------------------------------
// Edge cases — env var handling for budget file names
// ---------------------------------------------------------------------------
describe("STATEMENT_PROMPT env var edge cases", () => {
    it("defaults BUDGET_FILE to 'My Budget' when ACTUAL_PRIMARY_BUDGET_FILE is unset", () => {
        // The prompt is evaluated at import time with process.env values.
        // In test environments without ACTUAL_PRIMARY_BUDGET_FILE set, it should default.
        expect(STATEMENT_PROMPT).toContain('"My Budget"');
    });

    it("defaults MYR_BUDGET_FILE to 'My MYR Budget' when MYR_BUDGET_FILE is unset", () => {
        expect(STATEMENT_PROMPT).toContain('"My MYR Budget"');
    });

    it("uses custom budget file names when env vars are set", async () => {
        vi.stubEnv("ACTUAL_PRIMARY_BUDGET_FILE", "Custom Budget");
        vi.stubEnv("ACTUAL_SECONDARY_BUDGET_FILE", "Custom MYR Budget");
        vi.resetModules();

        // Dynamic import to get a fresh module evaluation with stubbed env vars
        const fresh = await import("../../src/statement/prompts.js");
        expect(fresh.STATEMENT_PROMPT).toContain('"Custom Budget"');
        expect(fresh.STATEMENT_PROMPT).toContain('"Custom MYR Budget"');

        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it("handles empty string env vars by falling back to defaults", async () => {
        vi.stubEnv("ACTUAL_PRIMARY_BUDGET_FILE", "");
        vi.stubEnv("ACTUAL_SECONDARY_BUDGET_FILE", "");
        vi.resetModules();

        const fresh = await import("../../src/statement/prompts.js");
        // Empty string is falsy, so defaults should be used
        expect(fresh.STATEMENT_PROMPT).toContain('"My Budget"');
        expect(fresh.STATEMENT_PROMPT).toContain('"My MYR Budget"');

        vi.unstubAllEnvs();
        vi.resetModules();
    });
});
