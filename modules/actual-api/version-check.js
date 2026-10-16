const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/** Installed `@actual-app/api` version. Its `exports` map hides package.json from require(). */
function clientVersion() {
    const pkg = path.join(
        path.dirname(require.resolve("@actual-app/api")),
        "..",
        "package.json",
    );
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version;
}

const majorMinor = (v) => String(v).split(".").slice(0, 2).map(Number);

/** True when the client's major.minor is older than the server's. Patch and pre-release tags are ignored. */
function isClientBehind(client, server) {
    const [cMaj, cMin] = majorMinor(client);
    const [sMaj, sMin] = majorMinor(server);
    return cMaj < sMaj || (cMaj === sMaj && cMin < sMin);
}

/** The sync-server's version, from its public `/info`. */
async function serverVersion(url) {
    const res = await fetch(`${url.replace(/\/+$/, "")}/info`);
    if (!res.ok) throw new Error(`/info returned HTTP ${res.status}`);
    return (await res.json()).build.version;
}

const notified = new Set();

/**
 * Warn the operator through the Hermes webhook, once per distinct message per
 * process. A no-op without NOTIFY_URL; a failure is logged and never thrown.
 */
async function notifyOnce(message) {
    const url = process.env.NOTIFY_URL;
    if (!url || notified.has(message)) return;
    notified.add(message);
    try {
        const body = JSON.stringify({ message });
        const headers = { "Content-Type": "application/json" };
        const secret = process.env.HERMES_WEBHOOK_SECRET;
        if (secret) {
            headers["X-Webhook-Signature"] = crypto
                .createHmac("sha256", secret)
                .update(body)
                .digest("hex");
        }
        await fetch(url, { method: "POST", headers, body });
    } catch (e) {
        console.error("Version-mismatch notify failed:", e.message);
    }
}

module.exports = { clientVersion, isClientBehind, serverVersion, notifyOnce };
