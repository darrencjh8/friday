---
name: image-gen
description: Generate AI images using Perchance or Pollinations. Use `/image-gen <prompt>` for quick generation.
user-invocable: true
---

# Image Generation

## Tools

- `image_gen_perchance` — Free tier, uses Perchance.org. Best for quick/generic images.
- `image_gen_pollinations` — Higher quality, requires API key. Uses gen.pollinations.ai.

## Rules

- When user types `/image-gen <prompt>` — pass the prompt EXACTLY as typed. Do NOT modify, rephrase, enhance, or add context. Call `image_gen_perchance` immediately.
- Return the result as-is — no commentary, no "here's your image", just the file path.
- For "selfie", "photo of you", "what do you look like" — load the `selfie` skill and use its canonical prompt verbatim with `image_gen_perchance`.
- For quality-critical requests, use `image_gen_pollinations` instead of `image_gen_perchance`.
- Never fabricate results. Always call the tool and return what it returns.
