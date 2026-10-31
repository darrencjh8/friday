QUESTIONS
q: May major-version bumps be included? | a: No. Decision 3 asked to clear the high alerts; majors (zod 3 to 4, @xenova/transformers for sharp, openai) can change behaviour, so they stay out and are listed as follow-ups.
q: Should the Hermes codex-router litellm pin follow codex-router's own pin? | a: Yes. codex-router main already pins litellm[proxy]==1.100.4 (codex-router#475), and a pip dry run resolves it with the other pins in requirements-codex-router.txt.

# Clear the high Dependabot alerts in friday (nightly decision 3, 2026-10-30)

## Goal
friday has 95 open high alerts. 84 of them have a patched version reachable without a major bump.

## Change
- Run `npm audit fix --package-lock-only --ignore-scripts` (no `--force`) in node:22 for modules/actual-api, expense-tracker, image-gen and portfolio-tracker. Only package-lock.json changes; package.json ranges are untouched.
- Bump modules/hermes/requirements-codex-router.txt to `litellm[proxy]==1.100.4` (alert 149).
- Extend modules/tests/test_critical_dependency_floors.py with one floor per major line for every fixed package (undici, fast-uri, @modelcontextprotocol/sdk, nodemailer, body-parser, brace-expansion, js-yaml, ip-address, deepmerge-ts, form-data, linkify-it, postcss, source-map-js, vite, browserslist) and a litellm pin check. It fails at base and passes at HEAD.

## Not in scope (stay open)
- zod < 4.6.6 (3.25.76 via the MCP SDK/openai), sharp < 0.35.5 (0.32.6 via @xenova/transformers), guava in pp-cli/pom.xml: all need a major bump or a Java change.

## Verification
- `python3 -m unittest modules/tests/test_critical_dependency_floors.py` (RED at base, GREEN at HEAD).
- CI runs each module's suite (actual-api, expense-tracker, image-gen, portfolio-tracker) on the new lockfiles.
