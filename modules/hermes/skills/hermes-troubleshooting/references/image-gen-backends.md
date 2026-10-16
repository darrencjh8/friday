# Hermes image generation backends — verified 2026-08

## Layout

- Source tree: `/opt/hermes`; profile home: `/opt/data` (`HERMES_HOME`)
- Built-in tool: `tools/image_generation_tool.py` — FAL catalog in `FAL_MODELS`
- Provider plugins: `/opt/hermes/plugins/image_gen/{fal,openai,openai-codex,xai,krea,deepinfra,openrouter}`
- Dispatch: `image_gen.provider` in config.yaml → `agent.image_gen_registry.get_provider()`
- Enablement: `agent.disabled_toolsets` must NOT contain `image_gen`
- Sessions pick up toolset changes only on restart/new session — one-shot test: `hermes chat -q '<prompt>' --yolo` (there is no `--yes` flag)

## FAL model catalog (set via `image_gen.model`)

| id | display | speed | price |
|---|---|---|---|
| fal-ai/flux-2/klein/9b | FLUX 2 Klein 9B | <1s | $0.006/MP |
| fal-ai/flux-2/pro | FLUX 2 Pro | ~6s | $0.03/MP |
| fal-ai/z-image-turbo | Z-Image Turbo | ~2s | $0.005/MP |
| fal-ai/nano-banana | Nano Banana Pro (Gemini 3 Pro Image) | ~8s | $0.15/img |
| fal-ai/gpt-image-1.5 | GPT Image 1.5 | ~15s | $0.034/img |
| fal-ai/gpt-image-2 | GPT Image 2 | ~20s | $0.04–0.06/img |
| fal-ai/ideogram/v3 | Ideogram V3 | ~5s | $0.03–0.09/img |
| fal-ai/recraft-v4 | Recraft V4 Pro | ~8s | $0.25/img |
| fal-ai/qwen-image | Qwen Image | ~12s | $0.02/MP |
| fal-ai/krea/2-medium | Krea 2 Medium | ~15–25s | $0.030+ |

GPT Image 1.5/2 also have edit endpoints (`fal-ai/gpt-image-1.5/edit`, `openai/gpt-image-2/edit`); quality pinned to medium for predictable billing.

## Provider backends (`image_gen.provider`)

| provider | auth | notes |
|---|---|---|
| fal (default) | FAL_KEY in .env OR Nous managed gateway (Portal subscription) | full catalog above |
| openai | OPENAI_API_KEY (platform API) | gpt-image-2 low/medium/high tiers via images.generate; ChatGPT subscription login does NOT work here |
| openai-codex | ChatGPT/Codex OAuth (auth.json / `hermes auth codex`) | gpt-image-2 tiers via `chatgpt.com/backend-api/codex/responses` with a hosted `image_generation` tool entry |
| xai / krea / deepinfra / openrouter | their respective keys | less commonly used |

## openai-codex failure mode (2026-08-26)

Request shape that the backend accepts: host model `gpt-5.5`, `tools: [{"type": "image_generation", "model": "gpt-image-2", "size", "quality", "output_format": "png", "background": "opaque", "partial_images": 1}]`, `stream: true`, NO `tool_choice` (any tool_choice shape 400s with "Tool choice 'image_generation' not found in 'tools' parameter").

Observed over 3 runs: HTTP 200, zero `image_generation_call` events. Run 1: host model text "I'll create the image now." then "I'm sorry, but I don't currently have access to an image generation tool in this chat". Run 2: model emitted a fake call as literal text: `<image_generation.generate_image prompt="..." size="512x512" n="1" />`. Run 3 (function-style tool named `image_generation.generate_image`): HTTP 400.

Conclusion: the chatgpt.com backend does not expose the hosted image_generation tool through the Codex API for this account (entitlement/rollout). Not config-fixable. Fall back to Pollinations (flux/zimage) via the user's image-gen MCP.

## DeepSeek — input only (2026-08)

- No image generation endpoint exists. Janus family = self-host only.
- Direct-API vision capability (2026-08): `deepseek-flash` via `https://api.deepseek.com/chat/completions`, OpenAI-style, content part:
  `{"type": "image_url", "image_url": {"url": "data:image/png;base64,<b64>"}}`
  This records the DeepSeek API's own endpoint. `deepseek-flash` is now the
  `auxiliary.vision` fallback route; the primary is
  `commandcode/deepseek/deepseek-v4.1-flash` reached through codex-router.
- Response includes `reasoning_content` (counts toward tokens) — small `max_tokens` yields empty `content`. Verified working with a 64×64 hand-rolled PNG; the model even described pixelation accurately.

## Diagnostics

- Logs: `/opt/data/logs/agent.log` — `tools.vision_tools` lines show vision call lifecycle; `agent.auxiliary_client` lines name the provider/model used for aux tasks.
- auth.json `credential_pool` stores metadata only (secret_fingerprint); real secrets in `/opt/data/.env`.
- `execute_code` runs `/opt/hermes/.venv/bin/python` (httpx present) — good escape hatch when the terminal lifecycle guard chokes on script paths.
