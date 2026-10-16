#!/usr/bin/env node
// CI drift check: fail when the locked @actual-app/api is older (major.minor)
// than the sync-server it talks to. Usage: check-server-version.js <url> [lockfile]
const fs = require("fs");
const path = require("path");
const { isClientBehind, serverVersion } = require("../version-check");

async function main() {
    const [url, lockfile = path.join(__dirname, "..", "package-lock.json")] =
        process.argv.slice(2);
    if (!url) {
        console.error("usage: check-server-version.js <sync-server-url> [lockfile]");
        return 2;
    }
    const client =
        JSON.parse(fs.readFileSync(lockfile, "utf8")).packages[
            "node_modules/@actual-app/api"
        ].version;
    let server;
    try {
        server = await serverVersion(url);
    } catch (e) {
        console.log(
            `::warning title=Actual version check skipped::could not read ${url}/info: ${e.message}`,
        );
        return 0;
    }
    if (isClientBehind(client, server)) {
        console.log(
            `::error title=Actual version mismatch::@actual-app/api ${client} is older than sync-server ${server}. Bump @actual-app/api in modules/actual-api.`,
        );
        return 1;
    }
    console.log(`OK: @actual-app/api ${client}, sync-server ${server}`);
    return 0;
}

main().then((code) => process.exit(code));
