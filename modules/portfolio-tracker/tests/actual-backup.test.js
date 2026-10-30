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
        const upload = vi.fn(async (name) => name);
        const out = await backupActual({ budgets: ["Main SGD", "Main MYR"], actualApiUrl: "http://a", upload, date: "2026-11-01" });
        expect(global.fetch.mock.calls.map(([u]) => u)).toEqual([
            "http://a/export?budget_id=Main%20SGD",
            "http://a/export?budget_id=Main%20MYR",
        ]);
        expect(upload.mock.calls.map(([n]) => n)).toEqual(["2026-11/2026-11-01-Main SGD.zip", "2026-11/2026-11-01-Main MYR.zip"]);
        expect(out.files.map((f) => f.name)).toEqual(["2026-11/2026-11-01-Main SGD.zip", "2026-11/2026-11-01-Main MYR.zip"]);
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

    function graph(searchHits) {
        return vi.fn(async (url) => {
            if (url.includes("login.microsoftonline.com")) return { ok: true, json: async () => ({ access_token: "t" }) };
            if (url.includes("/search(")) return { ok: true, json: async () => ({ value: searchHits }) };
            return { ok: true, json: async () => ({ name: "2026-11-01-Main SGD.zip" }) };
        });
    }

    it("PUTs into the shared folder on its owner's drive, replacing", async () => {
        process.env.ONEDRIVE_CLIENT_ID = "cid";
        delete process.env.ONEDRIVE_BACKUP_FOLDER;
        global.fetch = graph([
            { name: "Flyio notes", file: {} },
            { name: "Flyio", remoteItem: { id: "F1", folder: {}, parentReference: { driveId: "D9" } } },
        ]);
        const name = await uploadBackup("2026-11/2026-11-01-Main SGD.zip", new Uint8Array([1]));
        const [url, opts] = global.fetch.mock.calls[2];
        expect(global.fetch.mock.calls[1][0]).toContain("search(q='Flyio')");
        expect(url).toBe("https://graph.microsoft.com/v1.0/drives/D9/items/F1:/2026-11/2026-11-01-Main%20SGD.zip:/content?@microsoft.graph.conflictBehavior=replace");
        expect(opts.method).toBe("PUT");
        expect(name).toBe("2026-11-01-Main SGD.zip");
    });

    it("fails when the shared folder is not visible", async () => {
        global.fetch = graph([{ name: "Other", folder: {} }]);
        await expect(uploadBackup("x.zip", new Uint8Array())).rejects.toThrow(/not found; share it/);
    });

    it("rejects a name that could escape the folder", async () => {
        for (const bad of ["../x.zip", "a//x.zip", "/x.zip", "a\\x.zip", "a:x.zip"]) {
            await expect(uploadBackup(bad, new Uint8Array())).rejects.toThrow(/Unsafe/);
        }
    });
});
