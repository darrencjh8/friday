import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "node:http";
import { unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const PORT = 18083;
const OUTPUT_DIR = "/tmp/image-gen-test";

// ── Helpers ──────────────────────────────────────────────────────────────

function postMCP(body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request(
            `http://localhost:${PORT}/mcp`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": String(Buffer.byteLength(data)),
                    Accept: "application/json, text/event-stream",
                },
            },
            (res) => {
                let buf = "";
                res.on("data", (c) => (buf += c));
                res.on("end", () => {
                    const match = buf.match(/data:\s*(\{.*\})/s);
                    resolve(match ? JSON.parse(match[1]) : buf);
                });
            },
        );
        req.on("error", reject);
        req.write(data);
        req.end();
    });
}

function getHealth() {
    return new Promise((resolve, reject) => {
        http.get(`http://localhost:${PORT}/health`, (res) => {
            let buf = "";
            res.on("data", (c) => (buf += c));
            res.on("end", () =>
                resolve({ status: res.statusCode, body: JSON.parse(buf) }),
            );
        }).on("error", reject);
    });
}

function startServer() {
    return new Promise(async (resolve, reject) => {
        const { McpServer } =
            await import("@modelcontextprotocol/sdk/server/mcp.js");
        const { StreamableHTTPServerTransport } =
            await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

        mkdirSync(OUTPUT_DIR, { recursive: true });

        const server = createServer(async (req, res) => {
            if (req.method === "GET" && req.url === "/health") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "ok" }));
                return;
            }
            if (req.method === "POST" && req.url === "/mcp") {
                const mcp = new McpServer({
                    name: "image-gen-test",
                    version: "1.0.0",
                });
                mcp.tool(
                    "image_gen_perchance",
                    "Generate an image using Perchance.",
                    {
                        prompt: z.string().describe("Exact user prompt"),
                        shape: z
                            .enum(["square", "landscape", "portrait"])
                            .default("square"),
                        negativePrompt: z.string().default(""),
                        guidance: z.string().default("7"),
                    },
                    async ({ prompt, shape, negativePrompt, guidance }) => {
                        const outputFile = join(
                            OUTPUT_DIR,
                            `test-${Date.now()}.png`,
                        );
                        const { writeFileSync } = await import("fs");
                        writeFileSync(
                            outputFile,
                            JSON.stringify({
                                prompt,
                                shape,
                                negativePrompt,
                                guidance,
                            }),
                        );
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify({
                                        path: outputFile,
                                        tier: "perchance",
                                    }),
                                },
                            ],
                        };
                    },
                );
                mcp.tool(
                    "image_gen_pollinations",
                    "Generate an image using Pollinations.ai.",
                    {
                        prompt: z.string().describe("Image prompt"),
                        model: z.string().default("flux"),
                        width: z.number().default(1024),
                        height: z.number().default(1024),
                    },
                    async ({ prompt, model, width, height }) => {
                        if (!process.env.POLLINATIONS_API_KEY) {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: "Pollinations image generation is unavailable — POLLINATIONS_API_KEY is not configured. Use image_gen_perchance instead.",
                                    },
                                ],
                                isError: true,
                            };
                        }
                        const url =
                            `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}` +
                            `?model=${encodeURIComponent(model)}&width=${width}&height=${height}`;
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify({
                                        url,
                                        tier: "pollinations",
                                        model,
                                        width,
                                        height,
                                    }),
                                },
                            ],
                        };
                    },
                );
                const transport = new StreamableHTTPServerTransport();
                await mcp.connect(transport);
                await transport.handleRequest(req, res);
                await mcp.close();
                return;
            }
            res.writeHead(404);
            res.end();
        });

        server.listen(PORT, "0.0.0.0", () => resolve(server));
        server.on("error", reject);
    });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("image-gen MCP server", () => {
    let server;

    before(async () => {
        server = await startServer();
    });
    after(() => {
        server.close();
    });

    it("GET /health returns 200", async () => {
        const res = await getHealth();
        assert.equal(res.status, 200);
        assert.equal(res.body.status, "ok");
    });

    it("MCP initialize returns server info", async () => {
        const res = await postMCP({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "test", version: "1.0.0" },
            },
        });
        assert.ok(res.result, "Initialize should return result");
        assert.equal(res.result.serverInfo.name, "image-gen-test");
    });

    it("tools/list includes image_gen_perchance", async () => {
        await postMCP({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "test", version: "1.0.0" },
            },
        });
        await postMCP({ jsonrpc: "2.0", method: "notifications/initialized" });
        const res = await postMCP({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
        });
        const tools = res.result?.tools || [];
        const names = tools.map((t) => t.name);
        assert.ok(
            names.includes("image_gen_perchance"),
            `Tools: ${names.join(", ")}`,
        );
    });

    it("tools/call generates file", async () => {
        await postMCP({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "test", version: "1.0.0" },
            },
        });
        await postMCP({ jsonrpc: "2.0", method: "notifications/initialized" });
        const res = await postMCP({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
                name: "image_gen_perchance",
                arguments: { prompt: "test sunset", shape: "landscape" },
            },
        });
        assert.ok(res.result?.content, "Should have content");
        const parsed = JSON.parse(res.result.content[0].text);
        assert.equal(parsed.tier, "perchance");
        assert.ok(existsSync(parsed.path), "Output file exists");
        unlinkSync(parsed.path);
    });

    it("tools/list includes image_gen_pollinations", async () => {
        await postMCP({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "test", version: "1.0.0" },
            },
        });
        await postMCP({ jsonrpc: "2.0", method: "notifications/initialized" });
        const res = await postMCP({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
        });
        const tools = res.result?.tools || [];
        const names = tools.map((t) => t.name);
        assert.ok(
            names.includes("image_gen_pollinations"),
            `Tools: ${names.join(", ")}`,
        );
    });

    it("tools/call pollinations returns error when key is missing", async () => {
        delete process.env.POLLINATIONS_API_KEY;
        await postMCP({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "test", version: "1.0.0" },
            },
        });
        await postMCP({ jsonrpc: "2.0", method: "notifications/initialized" });
        const res = await postMCP({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
                name: "image_gen_pollinations",
                arguments: { prompt: "test sunset", model: "flux" },
            },
        });
        assert.ok(res.result?.isError, "Should be an error when key missing");
        assert.match(
            res.result.content[0].text,
            /POLLINATIONS_API_KEY/,
            "Error message should mention the missing key",
        );
    });

    it("tools/call pollinations returns URL when key is set", async () => {
        process.env.POLLINATIONS_API_KEY = "sk_test123";
        await postMCP({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "test", version: "1.0.0" },
            },
        });
        await postMCP({ jsonrpc: "2.0", method: "notifications/initialized" });
        const res = await postMCP({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
                name: "image_gen_pollinations",
                arguments: {
                    prompt: "test sunset",
                    model: "flux",
                    width: 512,
                    height: 512,
                },
            },
        });
        assert.ok(res.result?.content, "Should have content");
        const parsed = JSON.parse(res.result.content[0].text);
        assert.equal(parsed.tier, "pollinations");
        assert.equal(parsed.model, "flux");
        assert.match(parsed.url, /^https:\/\/gen\.pollinations\.ai\/image\//);
        // Key should NOT appear in the returned URL (it's stripped from test tool)
        assert.ok(
            !parsed.url.includes("sk_test123"),
            "API key must not leak into URL",
        );
    });
});
