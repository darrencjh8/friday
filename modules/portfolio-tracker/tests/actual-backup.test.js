/**
 * Nightly Actual Budget backup: export each budget, upload it to OneDrive.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", () => ({
    existsSync: () => true,
    readFileSync: () => "fake-refresh-token",
    writeFileSync: vi.fn(),
}));

import { backupActual, mountBackupRoute } from "../src/actual_backup.js";
import { uploadBackup } from "../src/onedrive.js";

describe("backupActual", () => {
    beforeEach(() => {
        global.fetch = vi.fn(async (url) => ({
            ok: true,
            arrayBuffer: async () => new TextEncoder().encode(`zip:${url}`).buffer,
        }));
    });
    afterEach(() => vi.restoreAllMocks());

    it("exports every configured budget and uploads a dated zip", async () => {
        const upload = vi.fn(async (_folder, name) => name);
        const out = await backupActual({ budgets: ["Main SGD", "Main MYR"], actualApiUrl: "http://a", upload, date: "2026-11-01" });
        expect(global.fetch.mock.calls.map(([u]) => u)).toEqual([
            "http://a/export?budget_id=Main%20SGD",
            "http://a/export?budget_id=Main%20MYR",
        ]);
        expect(upload.mock.calls.map(([f, n]) => [f, n])).toEqual([
            ["Actual", "Main SGD 2026-11-01.zip"],
            ["Actual", "Main MYR 2026-11-01.zip"],
        ]);
        expect(out.files.map((f) => f.name)).toEqual(["Main SGD 2026-11-01.zip", "Main MYR 2026-11-01.zip"]);
    });

    it("fails the whole run when an export fails, before uploading it", async () => {
        global.fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" }));
        const upload = vi.fn();
        await expect(backupActual({ budgets: ["Main SGD"], upload })).rejects.toThrow(/Export Main SGD failed: HTTP 500/);
        expect(upload).not.toHaveBeenCalled();
    });

    it("refuses to run with no budget configured", async () => {
        await expect(backupActual({ budgets: [] })).rejects.toThrow(/No budget/);
    });

    it("route answers 500 with the error", async () => {
        let handler;
        mountBackupRoute({ post: (_p, h) => (handler = h) }, async () => { throw new Error("nope"); });
        const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
        await handler({}, res);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: "nope" });
    });
});

describe("uploadBackup", () => {
    afterEach(() => vi.restoreAllMocks());

    it("PUTs to /Backups/<folder>/<name> with replace", async () => {
        process.env.ONEDRIVE_CLIENT_ID = "cid";
        global.fetch = vi.fn(async (url) =>
            url.includes("login.microsoftonline.com")
                ? { ok: true, json: async () => ({ access_token: "t" }) }
                : { ok: true, json: async () => ({ name: "Main SGD 2026-11-01.zip" }) });
        const name = await uploadBackup("Actual", "Main SGD 2026-11-01.zip", new Uint8Array([1]));
        const [url, opts] = global.fetch.mock.calls[1];
        expect(url).toBe("https://graph.microsoft.com/v1.0/me/drive/root:/Backups/Actual/Main%20SGD%202026-11-01.zip:/content?@microsoft.graph.conflictBehavior=replace");
        expect(opts.method).toBe("PUT");
        expect(name).toBe("Main SGD 2026-11-01.zip");
    });

    it("rejects a name that could escape the folder", async () => {
        await expect(uploadBackup("Actual", "../x.zip", new Uint8Array())).rejects.toThrow(/Unsafe/);
    });
});
