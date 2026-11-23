QUESTIONS
q: Is hono a direct dependency of any module? | a: No. It is transitive in all three lockfiles, so only the lockfile entry changes and package.json stays as is.
q: Should the minimatch alert in modules/actual-api be fixed in the same change? | assumption: No. minimatch is dev-only there (test tooling) and the patched 11.x is outside the ^10 range glob requires, so it needs a major override; it is left for a separate decision.

# Plan: clear the hono Dependabot alerts

Darren approved "Open a fix PR for the friday security alerts (hono, minimatch)" on the 2026-11-23 nightly digest.

## Problem

15 open Dependabot alerts (12 medium, 3 low) report hono < 4.13.16 in
modules/expense-tracker, modules/image-gen and modules/portfolio-tracker
package-lock.json.

## Change

Set the `node_modules/hono` entry (version, resolved, integrity) in each
of the three lockfiles to 4.13.21, the latest 4.13 patch, taken from
`npm update hono --package-lock-only`. Nothing else in the lockfiles changes:
running npm update with the container's npm also stripped `libc` fields from
unrelated optional packages, so only the hono entry is applied.

## Verification

- RED/GREEN control: a check that reads each lockfile's hono version and
  fails below 4.13.16. It fails at base and passes at HEAD.
- `npm ci --ignore-scripts` and `npx vitest run` for expense-tracker and
  image-gen in a throwaway `node:22-slim` container (portfolio-tracker has no
  test script; `npm ci` proves its lockfile installs).
- CI on the PR.

No production code, workflow, deploy or auth file changes.
