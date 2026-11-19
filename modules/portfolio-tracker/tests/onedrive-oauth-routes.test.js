import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("fs", () => ({
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
}));

import { writeFileSync } from "fs";
import { mountOneDriveAuthRoutes } from "../src/onedrive_oauth.js";

function mount() {
    const handlers = {};
    mountOneDriveAuthRoutes({ post: (p, h) => (handlers[p] = h) });
    return handlers;
}

const res = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });

describe("OneDrive auth routes", () => {
    afterEach(() => vi.restoreAllMocks());

    it("auth-url returns the authorize URL with the client id", () => {
        process.env.ONEDRIVE_CLIENT_ID = "cid";
        const r = res();
        mount()["/onedrive/auth-url"]({}, r);
        expect(r.json.mock.calls[0][0].url).toMatch(/^https:\/\/login\.microsoftonline\.com\/.*client_id=cid/);
    });

    it("auth-complete exchanges the code and saves the token owner-only", async () => {
        process.env.ONEDRIVE_CLIENT_ID = "cid";
        global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ refresh_token: "rt" }) }));
        const r = res();
        await mount()["/onedrive/auth-complete"](
            { body: { redirect_uri: "https://login.microsoftonline.com/common/oauth2/nativeclient?code=abc" } }, r);
        expect(global.fetch.mock.calls[0][1].body).toContain("code=abc");
        expect(writeFileSync).toHaveBeenCalledWith(expect.any(String), "rt", { mode: 0o600 });
        expect(r.json).toHaveBeenCalledWith({ success: true });
    });

    it("auth-complete answers 500 when the URL has no code", async () => {
        const r = res();
        await mount()["/onedrive/auth-complete"]({ body: {} }, r);
        expect(r.status).toHaveBeenCalledWith(500);
        expect(r.json.mock.calls[0][0].success).toBe(false);
    });
});
