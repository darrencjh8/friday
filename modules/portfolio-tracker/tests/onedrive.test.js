/**
 * OneDrive download/upload client tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync } =
    vi.hoisted(() => ({
        mockExistsSync: vi.fn(),
        mockReadFileSync: vi.fn(),
        mockWriteFileSync: vi.fn(),
        mockMkdirSync: vi.fn(),
    }));

vi.mock("fs", () => ({
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
}));

vi.mock("path", () => ({
    dirname: (p) => {
        const idx = p.lastIndexOf("/");
        return idx === -1 ? "." : p.substring(0, idx);
    },
}));

describe("onedrive", () => {
    let pullFromOneDrive;
    let pushToOneDrive;

    const REFRESH_TOKEN_PATH = "/app/config/onedrive/refresh_token";
    const DEFAULT_PP_PATH = "/data/onedrive/Portfolio/Portfolio.portfolio";

    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();

        // Default: existsSync returns true for everything
        mockExistsSync.mockReturnValue(true);
        // readFileSync returns a plain string that supports .trim()
        mockReadFileSync.mockReturnValue("fake-refresh-token");

        process.env.ONEDRIVE_REFRESH_TOKEN_PATH = REFRESH_TOKEN_PATH;
        process.env.ONEDRIVE_CLIENT_ID = "test-client-id";
        process.env.PP_XML_PATH = DEFAULT_PP_PATH;

        global.fetch = vi.fn();

        const mod = await import("../src/onedrive.js");
        pullFromOneDrive = mod.pullFromOneDrive;
        pushToOneDrive = mod.pushToOneDrive;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function mockTokenResponse(token = "test-access-token") {
        return {
            ok: true,
            json: async () => ({ access_token: token }),
        };
    }

    function mockGraphItem(downloadUrl) {
        if (downloadUrl) {
            return {
                ok: true,
                json: async () => ({
                    "@microsoft.graph.downloadUrl": downloadUrl,
                }),
            };
        }
        return {
            ok: true,
            json: async () => ({
                remoteItem: {
                    id: "folder-123",
                    parentReference: { driveId: "drive-abc" },
                },
            }),
        };
    }

    function mockChildren(portfolioUrl) {
        return {
            ok: true,
            json: async () => ({
                value: [
                    { name: "other.txt" },
                    portfolioUrl
                        ? {
                              name: "Portfolio.portfolio",
                              "@microsoft.graph.downloadUrl": portfolioUrl,
                          }
                        : null,
                ].filter(Boolean),
            }),
        };
    }

    function mockDownload(content = "xml-content") {
        return {
            ok: true,
            arrayBuffer: async () => new TextEncoder().encode(content).buffer,
        };
    }

    describe("pullFromOneDrive", () => {
        it("downloads Portfolio.portfolio from OneDrive (direct file)", async () => {
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/Portfolio.portfolio"),
                )
                .mockResolvedValueOnce(mockDownload("<portfolio />"));

            const result = await pullFromOneDrive();

            expect(result.success).toBe(true);
            expect(result.path).toBe(DEFAULT_PP_PATH);
            expect(mockWriteFileSync).toHaveBeenCalled();
        });

        it("downloads from a shared folder (remoteItem)", async () => {
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce(mockGraphItem(null))
                .mockResolvedValueOnce(
                    mockChildren(
                        "https://dl.example.com/shared/Portfolio.portfolio",
                    ),
                )
                .mockResolvedValueOnce(mockDownload("<portfolio />"));

            const result = await pullFromOneDrive();

            expect(result.success).toBe(true);
            expect(result.path).toBe(DEFAULT_PP_PATH);
        });

        it("returns error when Graph API resolve fails", async () => {
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce({
                    ok: false,
                    status: 403,
                    json: async () => ({}),
                });

            const result = await pullFromOneDrive();
            expect(result.success).toBe(false);
            expect(result.error).toContain("HTTP 403");
        });

        it("returns error when shared folder children list fails", async () => {
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce(mockGraphItem(null))
                .mockResolvedValueOnce({
                    ok: false,
                    status: 500,
                    json: async () => ({}),
                });

            const result = await pullFromOneDrive();
            expect(result.success).toBe(false);
            expect(result.error).toContain("HTTP 500");
        });

        it("returns error when Portfolio.portfolio not in shared folder", async () => {
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce(mockGraphItem(null))
                .mockResolvedValueOnce(mockChildren(null));

            const result = await pullFromOneDrive();
            expect(result.success).toBe(false);
            expect(result.error).toContain("not found");
        });

        it("returns error when download fails", async () => {
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/Portfolio.portfolio"),
                )
                .mockResolvedValueOnce({ ok: false, status: 404 });

            const result = await pullFromOneDrive();
            expect(result.success).toBe(false);
            expect(result.error).toContain("HTTP 404");
        });

        it("uses provided localPath instead of default", async () => {
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/Portfolio.portfolio"),
                )
                .mockResolvedValueOnce(mockDownload());

            const result = await pullFromOneDrive("/custom/path/portfolio.xml");

            expect(result.success).toBe(true);
            expect(result.path).toBe("/custom/path/portfolio.xml");
        });

        it("creates parent directory if it does not exist", async () => {
            // existsSync: true for refresh token, false for data dir
            mockExistsSync.mockImplementation((p) => p === REFRESH_TOKEN_PATH);

            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/Portfolio.portfolio"),
                )
                .mockResolvedValueOnce(mockDownload());

            const result = await pullFromOneDrive();
            expect(result.success).toBe(true);
            expect(mockMkdirSync).toHaveBeenCalledWith(
                "/data/onedrive/Portfolio",
                {
                    recursive: true,
                },
            );
        });

        it("returns error when token refresh fails after retries", async () => {
            vi.useFakeTimers();
            global.fetch.mockRejectedValue(new Error("Network down"));

            const promise = pullFromOneDrive();
            // Advance past all sleep intervals (2000 + 4000 = 6000ms + buffer)
            await vi.advanceTimersByTimeAsync(10000);
            const result = await promise;

            expect(result.success).toBe(false);
            expect(result.error).toContain("Network down");
            vi.useRealTimers();
        });
    });

    describe("pushToOneDrive", () => {
        it("uploads to OneDrive (direct file)", async () => {
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/pp"),
                )
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ name: "Portfolio.portfolio" }),
                });

            const result = await pushToOneDrive("/data/portfolio.xml");
            expect(result.success).toBe(true);
            expect(result.path).toBe("Portfolio.portfolio");
        });

        it("uploads to shared folder (remoteItem)", async () => {
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce(mockGraphItem(null))
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ name: "Portfolio.portfolio" }),
                });

            const result = await pushToOneDrive("/data/portfolio.xml");
            expect(result.success).toBe(true);
        });

        it("returns error when local file not found", async () => {
            // existsSync returns true for token path, false for local file
            mockExistsSync.mockImplementation((p) => p === REFRESH_TOKEN_PATH);
            // Token fetch must succeed for getAccessToken() to complete
            global.fetch.mockResolvedValueOnce(mockTokenResponse());

            const result = await pushToOneDrive("/data/missing.xml");
            expect(result.success).toBe(false);
            expect(result.error).toContain("Local file not found");
        });

        it("returns error when upload receives non-ok response", async () => {
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/pp"),
                )
                .mockResolvedValueOnce({
                    ok: false,
                    status: 413,
                    text: async () => "Content too large",
                });

            const result = await pushToOneDrive("/data/portfolio.xml");
            expect(result.success).toBe(false);
            expect(result.error).toContain("HTTP 413");
        });

        it("returns error when token refresh fails after retries", async () => {
            vi.useFakeTimers();
            global.fetch.mockRejectedValue(
                new Error("Auth service unreachable"),
            );

            const promise = pushToOneDrive("/data/portfolio.xml");
            await vi.advanceTimersByTimeAsync(10000);
            const result = await promise;

            expect(result.success).toBe(false);
            expect(result.error).toContain("Auth service unreachable");
            vi.useRealTimers();
        });

        it("returns error when Graph API folder resolve fails", async () => {
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce({
                    ok: false,
                    status: 401,
                    json: async () => ({}),
                });

            const result = await pushToOneDrive("/data/portfolio.xml");
            expect(result.success).toBe(false);
            expect(result.error).toContain("HTTP 401");
        });

        it("uses default localPath when none provided", async () => {
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/pp"),
                )
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ name: "Portfolio.portfolio" }),
                });

            const result = await pushToOneDrive();
            expect(result.success).toBe(true);
        });
    });

    describe("credentials handling", () => {
        it("returns error when refresh token file is missing", async () => {
            mockExistsSync.mockReturnValue(false);

            const result = await pullFromOneDrive();
            expect(result.success).toBe(false);
            expect(result.error).toContain("refresh token not found");
        });

        it("uses configured ONEDRIVE_REFRESH_TOKEN_PATH", async () => {
            process.env.ONEDRIVE_REFRESH_TOKEN_PATH = "/custom/refresh_token";
            mockExistsSync.mockImplementation(
                (p) => p === "/custom/refresh_token" || p === DEFAULT_PP_PATH,
            );

            global.fetch
                .mockResolvedValueOnce(mockTokenResponse("custom-access-token"))
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/Portfolio.portfolio"),
                )
                .mockResolvedValueOnce(mockDownload());

            const result = await pullFromOneDrive();
            expect(result.success).toBe(true);
            expect(mockExistsSync).toHaveBeenCalledWith(
                "/custom/refresh_token",
            );
        });
    });
});
