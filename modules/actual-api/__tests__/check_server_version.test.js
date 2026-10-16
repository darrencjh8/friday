const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");

const SCRIPT = path.join(__dirname, "..", "scripts", "check-server-version.js");

function lockfileWith(version) {
    const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "lock-")),
        "package-lock.json",
    );
    fs.writeFileSync(
        file,
        JSON.stringify({ packages: { "node_modules/@actual-app/api": { version } } }),
    );
    return file;
}

let stub;
let url;
let serverVersion = "26.10.0";

beforeAll(async () => {
    stub = http.createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ build: { version: serverVersion } }));
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${stub.address().port}`;
});
afterAll(() => new Promise((r) => stub.close(r)));

// Async spawn: the stub lives in this process, so a sync spawn would deadlock it.
function run(target, lockfile) {
    return new Promise((resolve) => {
        const child = require("child_process").spawn("node", [SCRIPT, target, lockfile]);
        let stdout = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.on("close", (status) => resolve({ status, stdout }));
    });
}

test("client behind the server fails with a titled error", async () => {
    const r = await run(url, lockfileWith("26.9.0"));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error title=Actual version mismatch::");
});

test("client equal or ahead passes", async () => {
    expect((await run(url, lockfileWith("26.10.0"))).status).toBe(0);
    expect((await run(url, lockfileWith("26.11.0"))).status).toBe(0);
});

test("unreachable server warns and passes", async () => {
    const r = await run("http://127.0.0.1:1", lockfileWith("26.9.0"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("::warning");
});
