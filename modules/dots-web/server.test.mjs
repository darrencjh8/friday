import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const PORT = 18789;
const base = `http://127.0.0.1:${PORT}`;
const ID = "AAAAAAAAAAAAAAAAAAAAAA";
const DEPOSIT = JSON.stringify({ v: 1, epk: "ZXBr", iv: "aXY", ct: "Y3Q" });
let server;

before(async () => {
    const dist = mkdtempSync(join(tmpdir(), "dots-web-"));
    writeFileSync(join(dist, "index.html"), "<title>Hermes</title>");
    writeFileSync(join(dist, "app.js"), "export {}");
    writeFileSync(
        join(dist, "manifest-nova.webmanifest"),
        JSON.stringify({ id: "/", name: "Hermes", short_name: "Hermes", start_url: "/", scope: "/", display: "standalone" }),
    );
    server = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
        env: { ...process.env, PORT: String(PORT), DOTS_WEB_DIST: dist },
        stdio: "inherit",
    });
    for (let i = 0; i < 100; i++) {
        try {
            await fetch(base);
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 50));
        }
    }
    throw new Error("server did not start");
});

after(() => server.kill());

test("serves the app with the Vercel security headers", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.match(res.headers.get("content-security-policy"), /connect-src 'self' wss:/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(await res.text(), /Hermes/);
});

test("serves files with their type and falls back to the app for routes", async () => {
    assert.match((await fetch(`${base}/app.js`)).headers.get("content-type"), /javascript/);
    assert.match(await (await fetch(`${base}/pair`)).text(), /Hermes/);
});

test("serves the PWA manifest with its type", async () => {
    const res = await fetch(`${base}/manifest-nova.webmanifest`);
    assert.match(res.headers.get("content-type"), /manifest\+json/);
});

test("manifest ?name= substitutes the first agent's name", async () => {
    const res = await fetch(`${base}/manifest-nova.webmanifest?name=Friday`);
    assert.match(res.headers.get("content-type"), /manifest\+json/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), {
        id: "/",
        name: "Friday",
        short_name: "Friday",
        start_url: "/",
        scope: "/",
        display: "standalone",
    });
});

test("manifest without ?name= serves the static fallback", async () => {
    const res = await fetch(`${base}/manifest-nova.webmanifest`);
    assert.deepEqual(await res.json(), {
        id: "/",
        name: "Hermes",
        short_name: "Hermes",
        start_url: "/",
        scope: "/",
        display: "standalone",
    });
});

test("manifest ?name= caps a hostile over-long name at 24 code points", async () => {
    const res = await fetch(`${base}/manifest-nova.webmanifest?name=${"x".repeat(40)}`);
    const manifest = await res.json();
    assert.equal(manifest.name, "x".repeat(24));
    assert.equal(manifest.short_name, "x".repeat(24));
});

test("never serves anything outside the build directory", async () => {
    for (const path of ["/../server.mjs", "/%2e%2e/server.mjs", "/..%2fserver.mjs", "/%2e%2e%2fserver.mjs"]) {
        const text = await (await fetch(`${base}${path}`)).text();
        assert.match(text, /Hermes/, path);
    }
});

test("relay keeps a deposit once and erases it when read", async () => {
    const url = `${base}/api/pair?id=${ID}`;
    assert.equal((await fetch(url)).status, 204);
    assert.equal((await fetch(url, { method: "POST", body: DEPOSIT })).status, 201);
    assert.equal((await fetch(url, { method: "POST", body: DEPOSIT })).status, 409);
    const read = await fetch(url);
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), JSON.parse(DEPOSIT));
    assert.equal((await fetch(url)).status, 204);
});

test("relay rejects bad ids, bad bodies and oversized bodies", async () => {
    assert.equal((await fetch(`${base}/api/pair?id=short`)).status, 400);
    const url = `${base}/api/pair?id=BBBBBBBBBBBBBBBBBBBBBB`;
    assert.equal((await fetch(url, { method: "POST", body: "nope" })).status, 400);
    assert.equal((await fetch(url, { method: "POST", body: "x".repeat(17 * 1024) })).status, 413);
});

test("other API paths are not found", async () => {
    assert.equal((await fetch(`${base}/api/other`)).status, 404);
});
