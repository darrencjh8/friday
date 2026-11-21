/**
 * Repro / regression tests for friday #286.
 *
 * 2026-11-20 14:30 SGT run: the OneDrive pull and the IBKR flex pull both
 * failed with the bare Node message "fetch failed", and neither leg retried,
 * so a transient external-network blip failed the whole daily sync (the
 * shell script exits 1 on any error leg). The push later in the same run
 * succeeded, so the outage lasted under two minutes.
 *
 * The RED control is the flex test: at base it fails because pullFlexXml
 * never retries. The OneDrive pull/push tests fail the same way, and the
 * cause test fails because the error string drops Node's underlying cause.
 * The 503/timeout tests fail because the transient classifier does not
 * exist at base. 14 fail / 4 pass at base; the 4 passes are the three
 * never-retry guards plus the shared-budget guard test, which passes at
 * base only because getAccessToken's internal 2s retry succeeds on the
 * second token attempt (~2s, vs ~20ms with the fix). Retry tests pass
 * short `retryDelays` ([10, 20] ms) so they run in milliseconds against
 * the 30s/60s production defaults. The token test asserts elapsed time:
 * at base getAccessToken ignores the injected delays and sleeps
 * 2000ms+4000ms, so it takes ~6s and fails the <1000ms bound.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync, mockRenameSync } =
    vi.hoisted(() => ({
        mockExistsSync: vi.fn(),
        mockReadFileSync: vi.fn(),
        mockWriteFileSync: vi.fn(),
        mockMkdirSync: vi.fn(),
        mockRenameSync: vi.fn(),
    }));

vi.mock("fs", () => ({
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    renameSync: mockRenameSync,
}));

vi.mock("path", () => ({
    dirname: (p) => {
        const idx = p.lastIndexOf("/");
        return idx === -1 ? "." : p.substring(0, idx);
    },
}));

const savedEnv = {};
const FLEX_TOKEN = "IBKR_FLEX_TOKEN";
const FLEX_QUERY = "IBKR_FLEX_QUERY_ID";

function transientFetchFailure(causeMessage) {
    const err = new TypeError("fetch failed");
    if (causeMessage) err.cause = new Error(causeMessage);
    return err;
}

function mockTokenResponse(token = "test-access-token") {
    return { ok: true, json: async () => ({ access_token: token }) };
}

function mockGraphItem(downloadUrl) {
    return {
        ok: true,
        json: async () => ({
            "@microsoft.graph.downloadUrl": downloadUrl,
        }),
    };
}

function mockDownload(content = "<portfolio />") {
    return {
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(content).buffer,
    };
}

describe("sync.retry.286", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue("fake-refresh-token");
        for (const k of [FLEX_TOKEN, FLEX_QUERY, "ONEDRIVE_REFRESH_TOKEN_PATH", "ONEDRIVE_CLIENT_ID", "PP_XML_PATH"]) {
            savedEnv[k] = process.env[k];
        }
        process.env[FLEX_TOKEN] = "tkn";
        process.env[FLEX_QUERY] = "qid";
        process.env.ONEDRIVE_REFRESH_TOKEN_PATH = "/app/config/onedrive/refresh_token";
        process.env.ONEDRIVE_CLIENT_ID = "test-client-id";
        process.env.PP_XML_PATH = "/data/onedrive/Portfolio/Portfolio.portfolio";
        global.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        for (const k of Object.keys(savedEnv)) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

    it(
        "sync.retry.286.flex.pull.retries.transient.fetch.failure",
        { timeout: 20000 },
        async () => {
            const { pullFlexXml } = await import("../src/ibkr_flex.js");
            global.fetch
                .mockRejectedValueOnce(transientFetchFailure())
                .mockResolvedValueOnce({
                    ok: true,
                    text: async () =>
                        "<FlexStatementResponse><Status>Success</Status><FlexStatements><FlexStatement/></FlexStatements></FlexStatementResponse>",
                });
            const res = await pullFlexXml({ retryDelays: [10, 20] });
            expect(res.success).toBe(true);
            expect(global.fetch).toHaveBeenCalledTimes(2);
        },
    );

    it(
        "sync.retry.286.flex.pull.retries.http.503",
        { timeout: 20000 },
        async () => {
            const { pullFlexXml } = await import("../src/ibkr_flex.js");
            global.fetch
                .mockResolvedValueOnce({
                    ok: false,
                    status: 503,
                    text: async () => "",
                })
                .mockResolvedValueOnce({
                    ok: true,
                    text: async () =>
                        "<FlexStatementResponse><Status>Success</Status><FlexStatements><FlexStatement/></FlexStatements></FlexStatementResponse>",
                });
            const res = await pullFlexXml({ retryDelays: [10, 20] });
            expect(res.success).toBe(true);
            expect(global.fetch).toHaveBeenCalledTimes(2);
        },
    );

    it("sync.retry.286.flex.pull.does.not.retry.http.400", async () => {
        const { pullFlexXml } = await import("../src/ibkr_flex.js");
        global.fetch.mockResolvedValue({
            ok: false,
            status: 400,
            text: async () => "",
        });
        const res = await pullFlexXml({ retryDelays: [10, 20] });
        expect(res.success).toBe(false);
        expect(res.error).toContain("HTTP 400");
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it(
        "sync.retry.286.flex.pull.retries.timeout.abort",
        { timeout: 20000 },
        async () => {
            const { pullFlexXml } = await import("../src/ibkr_flex.js");
            const timeoutError = Object.assign(
                new Error("The operation timed out"),
                { name: "TimeoutError" },
            );
            global.fetch
                .mockRejectedValueOnce(timeoutError)
                .mockResolvedValueOnce({
                    ok: true,
                    text: async () =>
                        "<FlexStatementResponse><Status>Success</Status><FlexStatements><FlexStatement/></FlexStatements></FlexStatementResponse>",
                });
            const res = await pullFlexXml({ retryDelays: [10, 20] });
            expect(res.success).toBe(true);
            expect(global.fetch).toHaveBeenCalledTimes(2);
        },
    );

    it(
        "sync.retry.286.onedrive.pull.retries.transient.fetch.failure",
        { timeout: 20000 },
        async () => {
            const { pullFromOneDrive } = await import("../src/onedrive.js");
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockRejectedValueOnce(transientFetchFailure())
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/Portfolio.portfolio"),
                )
                .mockResolvedValueOnce(mockDownload());
            const res = await pullFromOneDrive(undefined, {
                retryDelays: [10, 20],
            });
            expect(res.success).toBe(true);
        },
    );

    it(
        "sync.retry.286.onedrive.pull.retries.http.503",
        { timeout: 20000 },
        async () => {
            const { pullFromOneDrive } = await import("../src/onedrive.js");
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce({ ok: false, status: 503 })
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/Portfolio.portfolio"),
                )
                .mockResolvedValueOnce(mockDownload());
            const res = await pullFromOneDrive(undefined, {
                retryDelays: [10, 20],
            });
            expect(res.success).toBe(true);
        },
    );

    it(
        "sync.retry.286.onedrive.push.retries.transient.fetch.failure",
        { timeout: 20000 },
        async () => {
            const { pushToOneDrive } = await import("../src/onedrive.js");
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockRejectedValueOnce(transientFetchFailure())
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/Portfolio.portfolio"),
                )
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ name: "Portfolio.portfolio" }),
                });
            const res = await pushToOneDrive(undefined, {
                retryDelays: [10, 20],
            });
            expect(res.success).toBe(true);
        },
    );

    it(
        "sync.retry.286.fetch.error.names.underlying.cause",
        { timeout: 20000 },
        async () => {
            const { pullFlexXml } = await import("../src/ibkr_flex.js");
            global.fetch.mockRejectedValue(
                transientFetchFailure(
                    "getaddrinfo ENOTFOUND ndcdyn.interactivebrokers.com",
                ),
            );
            const res = await pullFlexXml({ retryDelays: [10, 20] });
            expect(res.success).toBe(false);
            expect(res.error).toContain("ENOTFOUND");
        },
    );

    it("sync.retry.286.flex.pull.does.not.retry.expired.token", async () => {
        const { pullFlexXml } = await import("../src/ibkr_flex.js");
        global.fetch.mockResolvedValue({
            ok: true,
            text: async () =>
                "<FlexStatementResponse><Status>Fail</Status><ErrorCode>1012</ErrorCode><ErrorMessage>Token has expired</ErrorMessage></FlexStatementResponse>",
        });
        const res = await pullFlexXml();
        expect(res.success).toBe(false);
        expect(res.error).toContain("1012");
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("sync.retry.286.onedrive.pull.does.not.retry.http.400", async () => {
        const { pullFromOneDrive } = await import("../src/onedrive.js");
        global.fetch
            .mockResolvedValueOnce(mockTokenResponse())
            .mockResolvedValueOnce({
                ok: false,
                status: 400,
                json: async () => ({}),
                text: async () => "",
            });
        const res = await pullFromOneDrive();
        expect(res.success).toBe(false);
        // Token fetch + one resolve attempt, no retry of the 400.
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it(
        "sync.retry.286.flex.pull.retries.getstatement.after.referencecode",
        { timeout: 20000 },
        async () => {
            const { pullFlexXml } = await import("../src/ibkr_flex.js");
            const refResponse = {
                ok: true,
                text: async () =>
                    "<FlexStatementResponse><Status>Success</Status><ReferenceCode>123456</ReferenceCode><Url>https://gdcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</Url></FlexStatementResponse>",
            };
            const statementResponse = {
                ok: true,
                text: async () =>
                    "<FlexStatementResponse><Status>Success</Status><FlexStatements><FlexStatement/></FlexStatements></FlexStatementResponse>",
            };
            global.fetch
                .mockResolvedValueOnce(refResponse)
                .mockRejectedValueOnce(transientFetchFailure())
                .mockResolvedValueOnce(refResponse)
                .mockResolvedValueOnce(statementResponse);
            const res = await pullFlexXml({ retryDelays: [10, 20] });
            expect(res.success).toBe(true);
            // SendRequest, GetStatement (fails), SendRequest again, GetStatement.
            expect(global.fetch).toHaveBeenCalledTimes(4);
        },
    );

    it(
        "sync.retry.286.onedrive.pull.retries.download.failure",
        { timeout: 20000 },
        async () => {
            const { pullFromOneDrive } = await import("../src/onedrive.js");
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/Portfolio.portfolio"),
                )
                .mockResolvedValueOnce({ ok: false, status: 503 })
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/Portfolio.portfolio"),
                )
                .mockResolvedValueOnce(mockDownload());
            const res = await pullFromOneDrive(undefined, {
                retryDelays: [10, 20],
            });
            expect(res.success).toBe(true);
            expect(global.fetch).toHaveBeenCalledTimes(5);
        },
    );

    it(
        "sync.retry.286.onedrive.push.retries.upload.failure",
        { timeout: 20000 },
        async () => {
            const { pushToOneDrive } = await import("../src/onedrive.js");
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/Portfolio.portfolio"),
                )
                .mockRejectedValueOnce(transientFetchFailure())
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/Portfolio.portfolio"),
                )
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ name: "Portfolio.portfolio" }),
                });
            const res = await pushToOneDrive(undefined, {
                retryDelays: [10, 20],
            });
            expect(res.success).toBe(true);
            expect(global.fetch).toHaveBeenCalledTimes(5);
        },
    );

    it(
        "sync.retry.286.onedrive.pull.retries.token.fetch.with.leg.delays",
        { timeout: 20000 },
        async () => {
            const { pullFromOneDrive } = await import("../src/onedrive.js");
            global.fetch
                .mockRejectedValueOnce(transientFetchFailure())
                .mockRejectedValueOnce(transientFetchFailure())
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/Portfolio.portfolio"),
                )
                .mockResolvedValueOnce(mockDownload());
            const started = performance.now();
            const res = await pullFromOneDrive(undefined, {
                retryDelays: [10, 20],
            });
            const elapsedMs = performance.now() - started;
            expect(res.success).toBe(true);
            // At base getAccessToken ignores the injected delays and sleeps
            // 2000ms+4000ms, so this takes ~6s; with the fix it takes ~30ms.
            expect(elapsedMs).toBeLessThan(1000);
        },
    );

    it(
        "sync.retry.286.flex.pull.stops.retrying.after.elapsed.budget",
        { timeout: 20000 },
        async () => {
            const { pullFlexXml } = await import("../src/ibkr_flex.js");
            global.fetch.mockRejectedValue(transientFetchFailure());
            const res = await pullFlexXml({
                retryDelays: [20, 40],
                retryBudgetMs: 45,
            });
            expect(res.success).toBe(false);
            // Attempt 1, one 20ms sleep, attempt 2, then the guard stops it:
            // elapsed (~20ms) + next delay (40ms) exceeds the 45ms budget.
            expect(global.fetch).toHaveBeenCalledTimes(2);
        },
    );

    it(
        "sync.retry.286.onedrive.pull.does.not.retry.token.http.400",
        { timeout: 20000 },
        async () => {
            const { pullFromOneDrive } = await import("../src/onedrive.js");
            // Refresh token revoked/expired: the token endpoint returns 400.
            global.fetch.mockResolvedValueOnce({
                ok: false,
                status: 400,
                json: async () => ({
                    error: "invalid_grant",
                    error_description: "AADSTS70008: The refresh token has expired.",
                }),
            });
            const res = await pullFromOneDrive(undefined, {
                retryDelays: [10, 20],
            });
            expect(res.success).toBe(false);
            expect(res.error).toContain("Token HTTP 400");
            // At base getAccessToken retries every error unconditionally and
            // calls fetch 3 times; with the classifier it fails after 1.
            expect(global.fetch).toHaveBeenCalledTimes(1);
        },
    );

    it(
        "sync.retry.286.onedrive.pull.error.names.underlying.cause",
        { timeout: 20000 },
        async () => {
            const { pullFromOneDrive } = await import("../src/onedrive.js");
            global.fetch
                .mockResolvedValueOnce(mockTokenResponse())
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/Portfolio.portfolio"),
                )
                .mockRejectedValue(
                    transientFetchFailure("read ECONNRESET"),
                );
            const res = await pullFromOneDrive(undefined, {
                retryDelays: [10, 20],
            });
            expect(res.success).toBe(false);
            // At base the error is the bare "fetch failed".
            expect(res.error).toContain("ECONNRESET");
        },
    );

    it(
        "sync.retry.286.onedrive.pull.token.and.graph.share.one.budget",
        { timeout: 20000 },
        async () => {
            const { pullFromOneDrive } = await import("../src/onedrive.js");
            global.fetch
                .mockRejectedValueOnce(transientFetchFailure())
                .mockResolvedValueOnce(mockTokenResponse())
                .mockRejectedValueOnce(transientFetchFailure())
                .mockResolvedValueOnce(
                    mockGraphItem("https://dl.example.com/Portfolio.portfolio"),
                )
                .mockResolvedValueOnce(mockDownload());
            const res = await pullFromOneDrive(undefined, {
                retryDelays: [20, 40],
                retryBudgetMs: 35,
            });
            expect(res.success).toBe(false);
            // Token fails once then succeeds (~20ms in); the Graph resolve
            // then fails once and would succeed on retry — but the two loops
            // share one 35ms clock, so elapsed (~20ms) + next delay (20ms)
            // exceeds the budget and the leg stops: token x2, resolve x1.
            // With a fresh clock per loop the leg would succeed (5 calls).
            expect(global.fetch).toHaveBeenCalledTimes(3);
        },
    );
});
