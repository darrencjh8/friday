import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "http";
import { execFile } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { z } from "zod";

const PERCHANCE_SCRIPT = "/app/modules/perchance-gen/perchance-image.cjs";
const POLLINATIONS_KEY = process.env.POLLINATIONS_API_KEY || "";
const OUTPUT_DIR = "/app/.openclaw/workspace/media";
mkdirSync(OUTPUT_DIR, { recursive: true });

function run(cmd, args, timeout) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
            if (err) { const detail = (stderr || err.message || "").trim(); return reject(new Error(detail || "Unknown error")); }
            resolve(stdout);
        });
    });
}

function createMcpServer() {
    const mcp = new McpServer({
        name: "image-gen-perchance",
        version: "1.0.0",
    });

    mcp.tool(
        "image_gen_perchance",
        "Generate an image using Perchance. Pass the user's prompt verbatim — do NOT modify, enhance, or rephrase.",
        {
            prompt: z.string().describe("Exact user prompt — do not modify"),
            shape: z
                .enum(["square", "landscape", "portrait"])
                .default("square"),
            negativePrompt: z.string().default(""),
            guidance: z.string().default("7"),
        },
        async ({ prompt, shape, negativePrompt, guidance }) => {
            const outputFile = join(OUTPUT_DIR, `img-${Date.now()}.png`);
            try {
                await run(
                    "node",
                    [
                        PERCHANCE_SCRIPT,
                        prompt,
                        outputFile,
                        shape || "square",
                        "",
                        negativePrompt || "",
                        String(guidance || "7"),
                    ],
                    360000,
                );
                if (existsSync(outputFile)) {
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
                }
            } catch (e) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                error: `Perchance failed: ${e.message}`,
                            }),
                        },
                    ],
                    isError: true,
                };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            error: "Perchance generation failed — no output file",
                        }),
                    },
                ],
                isError: true,
            };
        },
    );

    mcp.tool(
        "image_gen_pollinations",
        "Generate an image using Pollinations.ai. Premium quality with many models. Use this when Perchance fails or user requests a specific Pollinations model.",
        {
            prompt: z.string().describe("Image prompt — do not modify"),
            model: z
                .string()
                .default("flux")
                .describe(
                    "Model: flux, kontext, nanobanana, seedream, ideogram-v4-turbo, gptimage, etc.",
                ),
            width: z.number().default(1024).describe("Image width"),
            height: z.number().default(1024).describe("Image height"),
        },
        async ({ prompt, model, width, height }) => {
            if (!POLLINATIONS_KEY) {
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
                `?model=${encodeURIComponent(model)}&width=${width}&height=${height}&key=${POLLINATIONS_KEY}`;
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

    return mcp;
}

const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
    }

    if (req.method === "POST" && req.url === "/mcp") {
        const mcp = createMcpServer();
        const transport = new StreamableHTTPServerTransport();
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
        await mcp.close();
        return;
    }

    if (req.method === "POST" && req.url === "/generate") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
            try {
                const { prompt, shape } = JSON.parse(body);
                const outputFile = join(OUTPUT_DIR, `img-${Date.now()}.png`);
                await run(
                    "node",
                    [
                        PERCHANCE_SCRIPT,
                        prompt,
                        outputFile,
                        shape || "square",
                        "",
                        "",
                        "7",
                    ],
                    480000,
                );
                if (existsSync(outputFile)) {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, path: outputFile }));
                } else {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(
                        JSON.stringify({ ok: false, error: "no output file" }),
                    );
                }
            } catch (e) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        ok: false,
                        error: e.message.slice(0, 200),
                    }),
                );
            }
        });
        return;
    }

    res.writeHead(404);
    res.end();
});

server.listen(8083, "0.0.0.0", () => {
    console.log(JSON.stringify({ event: "image_gen_ready", port: 8083 }));
});
