/**
 * Java CLI bridge tests — PpJavaBridge.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";

const {
    mockExistsSync,
    mockReadFileSync,
    mockPullFromOneDrive,
    mockPushToOneDrive,
    mockSpawn,
} = vi.hoisted(() => ({
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockPullFromOneDrive: vi.fn(),
    mockPushToOneDrive: vi.fn(),
    mockSpawn: vi.fn(),
}));

vi.mock("fs", () => ({
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
}));

vi.mock("child_process", () => ({
    spawn: mockSpawn,
}));

vi.mock("../src/onedrive.js", () => ({
    pullFromOneDrive: mockPullFromOneDrive,
    pushToOneDrive: mockPushToOneDrive,
}));

/**
 * Build a mock child process that emits events asynchronously.
 */
function createMockProcess({
    stdoutData,
    stderrData,
    exitCode = 0,
    error = null,
} = {}) {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const proc = new EventEmitter();
    proc.stdout = stdout;
    proc.stderr = stderr;

    setImmediate(() => {
        if (error) {
            proc.emit("error", error);
            return;
        }
        if (stdoutData !== undefined) {
            const data =
                typeof stdoutData === "string"
                    ? stdoutData
                    : JSON.stringify(stdoutData);
            stdout.emit("data", data);
        }
        if (stderrData !== undefined) {
            const data =
                typeof stderrData === "string"
                    ? stderrData
                    : JSON.stringify(stderrData);
            stderr.emit("data", data);
        }
        proc.emit("close", exitCode);
    });

    return proc;
}

import { PpJavaBridge } from "../src/java_bridge.js";

describe("PpJavaBridge", () => {
    const jarPath = "/app/pp-cli.jar";
    const xmlPath = "/data/portfolio.xml";

    beforeEach(() => {
        vi.clearAllMocks();
        mockExistsSync.mockReturnValue(true);
        mockPullFromOneDrive.mockResolvedValue({ success: true });
    });

    describe("constructor", () => {
        it("sets jarPath, xmlPath, password, and timeout", () => {
            const bridge = new PpJavaBridge(jarPath, xmlPath, "secret", 60);
            expect(bridge._jarPath).toBe(jarPath);
            expect(bridge._xmlPath).toBe(xmlPath);
            expect(bridge._password).toBe("secret");
            expect(bridge._timeout).toBe(60000);
        });

        it("defaults password to empty string and timeout to 30s", () => {
            const bridge = new PpJavaBridge(jarPath, xmlPath);
            expect(bridge._password).toBe("");
            expect(bridge._timeout).toBe(30000);
        });
    });

    describe("_validateJar", () => {
        it("does not throw when JAR exists", () => {
            mockExistsSync.mockReturnValue(true);
            const bridge = new PpJavaBridge(jarPath, xmlPath);
            expect(() => bridge._validateJar()).not.toThrow();
        });

        it("throws when JAR is missing", () => {
            mockExistsSync.mockReturnValue(false);
            const bridge = new PpJavaBridge("/missing/cli.jar", xmlPath);
            expect(() => bridge._validateJar()).toThrow(
                "Java CLI JAR not found",
            );
        });
    });

    describe("_runCommand", () => {
        let bridge;

        beforeEach(() => {
            vi.clearAllMocks();
            mockExistsSync.mockReturnValue(true);
            bridge = new PpJavaBridge(jarPath, xmlPath);
        });

        it("spawns Java with correct args", async () => {
            mockSpawn.mockReturnValue(
                createMockProcess({ stdoutData: { accounts: [] } }),
            );
            await bridge._runCommand("accounts", "--file", xmlPath);
            expect(mockSpawn).toHaveBeenCalledWith(
                "java",
                ["-jar", jarPath, "accounts", "--file", xmlPath],
                expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
            );
        });

        it("includes --password flag when password is set", async () => {
            const pwBridge = new PpJavaBridge(jarPath, xmlPath, "mypass");
            mockSpawn.mockReturnValue(createMockProcess({ stdoutData: {} }));
            await pwBridge._runCommand("status", "--file", xmlPath);
            expect(mockSpawn).toHaveBeenCalledWith(
                "java",
                [
                    "-jar",
                    jarPath,
                    "status",
                    "--password",
                    "mypass",
                    "--file",
                    xmlPath,
                ],
                expect.any(Object),
            );
        });

        it("returns parsed JSON from stdout", async () => {
            mockSpawn.mockReturnValue(
                createMockProcess({
                    stdoutData: { summary: { total_value_native: "50000.00" } },
                }),
            );
            const result = await bridge._runCommand(
                "status",
                "--file",
                xmlPath,
            );
            expect(result).toEqual({
                summary: { total_value_native: "50000.00" },
            });
        });

        it("returns raw object when stdout is not valid JSON", async () => {
            mockSpawn.mockReturnValue(
                createMockProcess({ stdoutData: "plain text output" }),
            );
            const result = await bridge._runCommand(
                "status",
                "--file",
                xmlPath,
            );
            expect(result).toEqual({ raw: "plain text output" });
        });

        it("rejects with error when Java is not installed", async () => {
            mockSpawn.mockReturnValue(
                createMockProcess({ error: new Error("spawn java ENOENT") }),
            );
            await expect(
                bridge._runCommand("accounts", "--file", xmlPath),
            ).rejects.toThrow("Java not found");
        });

        it("rejects with error on non-zero exit code", async () => {
            mockSpawn.mockReturnValue(
                createMockProcess({
                    stderrData: "Something went wrong",
                    exitCode: 1,
                }),
            );
            await expect(
                bridge._runCommand("accounts", "--file", xmlPath),
            ).rejects.toThrow("Java CLI error (exit 1)");
        });

        it("reports unknown error when stderr is empty on non-zero exit", async () => {
            mockSpawn.mockReturnValue(createMockProcess({ exitCode: 2 }));
            await expect(
                bridge._runCommand("accounts", "--file", xmlPath),
            ).rejects.toThrow("unknown error");
        });

        it("parses JSON error from stderr", async () => {
            mockSpawn.mockReturnValue(
                createMockProcess({
                    stderrData: { error: "Account not found" },
                    exitCode: 1,
                }),
            );
            await expect(
                bridge._runCommand("accounts", "--file", xmlPath),
            ).rejects.toThrow("Account not found");
        });

        it("auto-recovers from corruption by re-downloading and retrying", async () => {
            mockPullFromOneDrive.mockResolvedValue({ success: true });
            mockSpawn
                .mockReturnValueOnce(
                    createMockProcess({
                        stderrData: "File is corrupt - IllegalBlockSize",
                        exitCode: 1,
                    }),
                )
                .mockReturnValueOnce(
                    createMockProcess({
                        stdoutData: { accounts: [{ id: "acct-1" }] },
                    }),
                );
            const result = await bridge._runCommand(
                "accounts",
                "--file",
                xmlPath,
            );
            expect(result).toEqual({ accounts: [{ id: "acct-1" }] });
            expect(mockPullFromOneDrive).toHaveBeenCalled();
            expect(mockSpawn).toHaveBeenCalledTimes(2);
        });

        it("rejects when corruption recovery pull fails", async () => {
            mockPullFromOneDrive.mockRejectedValue(new Error("OneDrive down"));
            mockSpawn.mockReturnValue(
                createMockProcess({
                    stderrData: "decrypt error: IllegalBlockSize",
                    exitCode: 1,
                }),
            );
            await expect(
                bridge._runCommand("accounts", "--file", xmlPath),
            ).rejects.toThrow("Java CLI error (exit 1)");
        });

        it("validates JAR before spawning", async () => {
            mockExistsSync.mockReturnValue(false);
            const badBridge = new PpJavaBridge("/missing/cli.jar", xmlPath);
            await expect(
                badBridge._runCommand("accounts", "--file", xmlPath),
            ).rejects.toThrow("Java CLI JAR not found");
        });

        it("passes additional args after command name", async () => {
            mockSpawn.mockReturnValue(createMockProcess({ stdoutData: {} }));
            await bridge._runCommand(
                "query",
                "--file",
                xmlPath,
                "--search",
                "AAPL",
            );
            expect(mockSpawn).toHaveBeenCalledWith(
                "java",
                [
                    "-jar",
                    jarPath,
                    "query",
                    "--file",
                    xmlPath,
                    "--search",
                    "AAPL",
                ],
                expect.any(Object),
            );
        });
    });

    describe("getAccounts", () => {
        it("returns array when result is an array", async () => {
            mockSpawn.mockReturnValue(
                createMockProcess({
                    stdoutData: [{ id: "acct-1", name: "IBKR USD" }],
                }),
            );
            const bridge = new PpJavaBridge(jarPath, xmlPath);
            const result = await bridge.getAccounts();
            expect(result).toEqual([{ id: "acct-1", name: "IBKR USD" }]);
        });

        it("extracts accounts property from object result", async () => {
            mockSpawn.mockReturnValue(
                createMockProcess({
                    stdoutData: { accounts: [{ id: "acct-1" }] },
                }),
            );
            const bridge = new PpJavaBridge(jarPath, xmlPath);
            const result = await bridge.getAccounts();
            expect(result).toEqual([{ id: "acct-1" }]);
        });

        it("returns empty array when no accounts", async () => {
            mockSpawn.mockReturnValue(createMockProcess({ stdoutData: {} }));
            const bridge = new PpJavaBridge(jarPath, xmlPath);
            const result = await bridge.getAccounts();
            expect(result).toEqual([]);
        });
    });

    describe("getStatus", () => {
        it("returns status from Java CLI", async () => {
            mockSpawn.mockReturnValue(
                createMockProcess({
                    stdoutData: { summary: { total_value_native: "12345.67" } },
                }),
            );
            const bridge = new PpJavaBridge(jarPath, xmlPath);
            const result = await bridge.getStatus();
            expect(result).toEqual({
                summary: { total_value_native: "12345.67" },
            });
        });
    });

    describe("pull", () => {
        it("returns ok status when pull succeeds", async () => {
            mockPullFromOneDrive.mockResolvedValue({ success: true });
            const bridge = new PpJavaBridge(jarPath, xmlPath);
            const result = await bridge.pull();
            expect(result).toEqual({ status: "ok", detail: "downloaded" });
        });

        it("returns error status when pull returns error info", async () => {
            mockPullFromOneDrive.mockResolvedValue({
                success: false,
                error: "Network error",
            });
            const bridge = new PpJavaBridge(jarPath, xmlPath);
            const result = await bridge.pull();
            expect(result).toEqual({ status: "error", detail: "Network error" });
        });

        it("returns error when pullFromOneDrive throws", async () => {
            mockPullFromOneDrive.mockRejectedValue(new Error("crash"));
            const bridge = new PpJavaBridge(jarPath, xmlPath);
            const result = await bridge.pull();
            expect(result).toEqual({ status: "error", detail: "crash" });
        });
    });

    describe("push", () => {
        it("returns ok status when push succeeds", async () => {
            mockPushToOneDrive.mockResolvedValue({ success: true });
            const bridge = new PpJavaBridge(jarPath, xmlPath);
            const result = await bridge.push();
            expect(result).toEqual({ status: "ok", detail: "uploaded" });
        });

        it("returns error when pushToOneDrive throws", async () => {
            mockPushToOneDrive.mockRejectedValue(new Error("Upload failed"));
            const bridge = new PpJavaBridge(jarPath, xmlPath);
            const result = await bridge.push();
            expect(result).toEqual({
                status: "error",
                detail: "Upload failed",
            });
        });
    });

    describe("querySecurity", () => {
        it("queries by search term", async () => {
            mockSpawn.mockReturnValue(
                createMockProcess({
                    stdoutData: { ticker: "AAPL", shares: 100, price: 185.3 },
                }),
            );
            const bridge = new PpJavaBridge(jarPath, xmlPath);
            const result = await bridge.querySecurity("AAPL");
            expect(result).toEqual({
                ticker: "AAPL",
                shares: 100,
                price: 185.3,
            });
            expect(mockSpawn).toHaveBeenCalledWith(
                "java",
                expect.arrayContaining([
                    "query",
                    "--file",
                    xmlPath,
                    "--search",
                    "AAPL",
                ]),
                expect.any(Object),
            );
        });
    });

    describe("insertTransaction", () => {
        it("inserts a transaction with all fields", async () => {
            mockSpawn.mockReturnValue(
                createMockProcess({ stdoutData: { status: "inserted" } }),
            );
            const bridge = new PpJavaBridge(jarPath, xmlPath);
            const result = await bridge.insertTransaction({
                accountId: "acct-1",
                securityId: "sec-aapl",
                txnType: "Buy",
                date: "2026-06-01",
                shares: 100,
                price: 185.3,
                currencyCode: "USD",
                fees: 1.5,
                taxes: 0.75,
                notes: "Test trade",
            });
            expect(result).toEqual({ status: "inserted" });
            expect(mockSpawn).toHaveBeenCalledWith(
                "java",
                expect.arrayContaining([
                    "insert",
                    "--account-id",
                    "acct-1",
                    "--security-id",
                    "sec-aapl",
                    "--type",
                    "Buy",
                    "--date",
                    "2026-06-01",
                    "--shares",
                    "100",
                    "--price",
                    "185.3",
                    "--currency",
                    "USD",
                    "--fees",
                    "1.5",
                    "--taxes",
                    "0.75",
                    "--notes",
                    "Test trade",
                ]),
                expect.any(Object),
            );
        });

        it("omits security-id and notes when not provided", async () => {
            mockSpawn.mockReturnValue(
                createMockProcess({ stdoutData: { status: "inserted" } }),
            );
            const bridge = new PpJavaBridge(jarPath, xmlPath);
            await bridge.insertTransaction({
                accountId: "acct-1",
                txnType: "Deposit",
                date: "2026-06-01",
                shares: 5000,
                price: 1,
                currencyCode: "SGD",
            });
            const callArgs = mockSpawn.mock.calls[0][1];
            expect(callArgs).not.toContain("--security-id");
            expect(callArgs).not.toContain("--notes");
        });

        it("defaults fees and taxes to 0", async () => {
            mockSpawn.mockReturnValue(
                createMockProcess({ stdoutData: { status: "inserted" } }),
            );
            const bridge = new PpJavaBridge(jarPath, xmlPath);
            await bridge.insertTransaction({
                accountId: "acct-1",
                txnType: "Buy",
                date: "2026-06-01",
                shares: 10,
                price: 100,
                currencyCode: "USD",
            });
            const callArgs = mockSpawn.mock.calls[0][1];
            const feesIdx = callArgs.indexOf("--fees");
            const taxesIdx = callArgs.indexOf("--taxes");
            expect(callArgs[feesIdx + 1]).toBe("0");
            expect(callArgs[taxesIdx + 1]).toBe("0");
        });
    });
});
