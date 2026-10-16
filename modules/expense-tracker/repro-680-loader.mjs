// Dependency stub loader for the #680 reproduction probe.
//
// `src/orchestrator.js` pulls in a wide import graph (openai, pino, cheerio,
// imapflow, mailparser, zod, better-sqlite3, express, the MCP SDK). The probe
// needs none of them: it replaces `orch._llm` outright and asserts on return
// values. But `loop.py repro` runs in a throwaway BASE worktree with no
// `node_modules`, and `external_path_control` refuses a command naming an
// absolute path outside the reviewed repository, so a real install cannot be
// linked or copied by the recorded command (darrencjh8/codex-router#352).
//
// So this loader writes a stub package per dependency into a local
// `node_modules`. ESM named exports are resolved statically, so a Proxy cannot
// satisfy them and the stub declares exactly the names the import graph binds —
// verified with `grep -rhoE "import \{[^}]*\} from \"<pkg>\"" src/*.js`. Default
// exports are classes that throw if constructed, so an accidental dependency on a
// real package fails loudly instead of quietly reaching a live service.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const nm = `${fileURLToPath(new URL(".", import.meta.url))}node_modules`;

// Per-package stub bodies. `pino` is special-cased because src/logging.js reads
// `pino.stdTimeFunctions.isoTime` at construction; a generic callable default is
// not enough there.
// The default export is an inert class: the orchestrator constructs an OpenAI
// client in its own constructor, and the probe replaces `orch._llm` afterwards,
// so construction must be harmless while every METHOD throws. A method that
// quietly returned a value would let a stub stand in for a real LLM call and
// certify a decision the real code never made.
const GENERIC = (named) => `
class Stub {
    constructor() {}
    chat() { throw new Error("repro-680 stub: this package must not decide issue #680"); }
    completions() { throw new Error("repro-680 stub: this package must not decide issue #680"); }
    embeddings() { throw new Error("repro-680 stub: this package must not decide issue #680"); }
}
const noop = () => undefined;
${named.map((n) => `export const ${n} = noop;`).join("\n")}
export default Stub;
`;

// `src/logging.js` reads `pino.stdTimeFunctions.isoTime` off the DEFAULT export,
// so the stub's default must carry the named members as properties too.
const PINO = [
    "const noop = () => undefined;",
    "const logger = { debug: noop, info: noop, warn: noop, error: noop, fatal: noop, trace: noop, silent: noop };",
    "const stdTimeFunctions = { isoTime: () => new Date().toISOString(), epochTime: noop, nullTime: noop };",
    "const factory = () => logger;",
    "factory.stdTimeFunctions = stdTimeFunctions;",
    "factory.default = factory;",
    "export const stdTimeFunctionsAlias = stdTimeFunctions;",
    "export default factory;",
    "export { logger, stdTimeFunctionsAlias as stdTimeFunctions };",
    "",
].join("\n");

const bodyFor = (name, named) => (name === "pino" ? PINO : GENERIC(named));

const PACKAGES = {
    openai: { named: [] },
    pino: { named: [] },
    express: { named: [] },
    "better-sqlite3": { named: [] },
    "@xenova/transformers": { named: ["pipeline", "env"] },
    cheerio: { named: ["load"] },
    imapflow: { named: ["ImapFlow"] },
    mailparser: { named: ["simpleParser"] },
    zod: { named: ["z"] },
    "@modelcontextprotocol/sdk": { named: [] },
};

const SUBPATHS = {
    "@modelcontextprotocol/sdk": {
        "server/index.js": ["Server"],
        "server/stdio.js": ["StdioServerTransport"],
        "types.js": [],
    },
};

function writePackage(name, named) {
    const dir = `${nm}/${name}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        `${dir}/package.json`,
        JSON.stringify({
            name,
            version: "0.0.0-repro-stub",
            type: "module",
            main: "index.js",
            exports: {
                ".": "./index.js",
                "./package.json": "./package.json",
                "./*": "./*",
            },
        }),
    );
    writeFileSync(`${dir}/index.js`, bodyFor(name, named));
}

for (const [name, spec] of Object.entries(PACKAGES)) {
    writePackage(name, spec.named);
    for (const [subpath, named] of Object.entries(SUBPATHS[name] || {})) {
        const dir = `${nm}/${name}/${subpath.replace(/\.js$/, "")}`;
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${dir}/index.js`, bodyFor(name, named));
        writeFileSync(`${dir}/package.json`, JSON.stringify({ type: "module", main: "index.js" }));
    }
}
