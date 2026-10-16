/**
 * Tests for pino-based structured logger.
 */
import { describe, test, expect } from "vitest";
import pino from "pino";
import { logger, getLogger, setLogLevel } from "../src/logging.js";

describe("logger", () => {
    test("is a pino instance", () => {
        expect(logger).toBeDefined();
        expect(typeof logger.info).toBe("function");
        expect(typeof logger.error).toBe("function");
        expect(typeof logger.warn).toBe("function");
        expect(typeof logger.debug).toBe("function");
    });

    test("accepts object without throwing", () => {
        // Pino accepts objects directly — no JSON.stringify needed
        expect(() => logger.info({ event: "test", value: 42 })).not.toThrow();
    });

    test("accepts string message", () => {
        expect(() => logger.info("plain string")).not.toThrow();
    });
});

describe("getLogger", () => {
    test("returns a child logger with the given name binding", () => {
        const child = getLogger("test-module");
        expect(child).toBeDefined();
        expect(typeof child.info).toBe("function");
        // Child logger has bindings
        expect(child.bindings()).toHaveProperty("logger", "test-module");
    });

    test("returns different child loggers for different names", () => {
        const a = getLogger("a");
        const b = getLogger("b");
        expect(a.bindings().logger).toBe("a");
        expect(b.bindings().logger).toBe("b");
    });
});

describe("setLogLevel", () => {
    test("changes the logger level", () => {
        const original = logger.level;
        setLogLevel("error");
        expect(logger.level).toBe("error");
        setLogLevel("silent");
        expect(logger.level).toBe("silent");
        // Restore
        logger.level = original;
    });
});

describe("pino configuration", () => {
    test("isoTime timestamp includes ISO date", () => {
        const ts = pino.stdTimeFunctions.isoTime;
        const result = ts();
        // pino's isoTime returns '"time":"2026-06-18T..."' as a JSON fragment
        expect(result).toContain("time");
        expect(result).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    });
});
