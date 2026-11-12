// Serves the built web app and its pairing relay from one origin, in place of Vercel + Upstash.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handlePair, MAX_BODY_BYTES } from "./api/_lib/pairing.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = process.env.DOTS_WEB_DIST ?? join(here, "dist");
const port = Number(process.env.PORT ?? 8789);
const securityHeaders = Object.fromEntries(
    JSON.parse(readFileSync(join(here, "vercel.json"), "utf8")).headers[0].headers.map((h) => [h.key, h.value]),
);
const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

// ponytail: in-memory, one process, tailnet-only. A restart loses deposits under 120 s old, and
// nothing caps how many a tailnet peer can leave before they expire. Use Redis if it ever goes public.
const deposits = new Map();
const store = {
    setNx: async (key, value, ttlSeconds) => {
        const now = Date.now();
        for (const [k, e] of deposits) if (e.expires <= now) deposits.delete(k);
        if (deposits.has(key)) return false;
        deposits.set(key, { value, expires: now + ttlSeconds * 1000 });
        return true;
    },
    getDel: async (key) => {
        const entry = deposits.get(key);
        deposits.delete(key);
        return entry && entry.expires > Date.now() ? entry.value : null;
    },
};

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        // Past the limit, stop keeping data: what is kept still exceeds it, so handlePair answers 413.
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
        size += chunk.length;
    }
    return Buffer.concat(chunks);
}

async function relay(req, res, url) {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const reply = await handlePair(new Request(url, { method: req.method, body }), store);
    res.writeHead(reply.status, { ...securityHeaders, ...Object.fromEntries(reply.headers) });
    res.end(Buffer.from(await reply.arrayBuffer()));
}

// The pathname stays percent-encoded and URL has already resolved "..", so it cannot leave dist.
async function serveFile(req, res, pathname, name) {
    if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { ...securityHeaders, Allow: "GET, HEAD" });
        res.end();
        return;
    }
    let file = join(dist, pathname);
    let body;
    try {
        body = await readFile(file);
    } catch {
        file = join(dist, "index.html");
        body = await readFile(file);
    }
    if (name !== null && extname(file) === ".webmanifest") {
        const clean = cleanName(name);
        if (clean) {
            const manifest = JSON.parse(body.toString("utf8"));
            manifest.name = clean;
            manifest.short_name = clean;
            res.writeHead(200, { ...securityHeaders, "Content-Type": types[".webmanifest"], "Cache-Control": "no-store" });
            res.end(Buffer.from(JSON.stringify(manifest)));
            return;
        }
    }
    res.writeHead(200, { ...securityHeaders, "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
}

/** Nom d'app validé pour ?name= : trim, sans caractères de contrôle, 24 points de code max. */
function cleanName(name) {
    return [...name.trim().replace(/[\u0000-\u001f\u007f]/g, "")].slice(0, 24).join("");
}

createServer(async (req, res) => {
    try {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname === "/api/pair") await relay(req, res, url);
        else if (url.pathname.startsWith("/api/")) {
            res.writeHead(404, securityHeaders);
            res.end();
        } else await serveFile(req, res, url.pathname, url.searchParams.get("name"));
    } catch (e) {
        console.error("dots-web:", e);
        if (!res.headersSent) res.writeHead(500, securityHeaders);
        res.end();
    }
}).listen(port);
