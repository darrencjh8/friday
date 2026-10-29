QUESTIONS
q: Which alerts and where? | a: Critical alerts open on main: `proxy-addr` < 2.0.8 (runtime, through express `^2.0.7`) in portfolio-tracker, expense-tracker, image-gen and actual-api; `protobufjs` < 7.5.5 (runtime, through `onnx-proto`, which pins `^6.8.8`, under `@xenova/transformers`) and `tinypool` < 2.1.2 (dev, through vitest 3, which pins `^1.1.1`) in portfolio-tracker and expense-tracker.
q: Why overrides instead of upgrading the parents? | a: Neither parent has a release that accepts the patched major: `onnx-proto` pins protobufjs 6, and vitest 3 pins tinypool 1. An npm `overrides` entry is the smallest change; upgrading vitest to 4 would change the test runner for two modules.
q: Does protobufjs 7 work for onnx-proto? | a: Yes. Locally, `onnx-proto`'s `ModelProto` encodes and decodes a round trip under protobufjs 7.6.6. protobufjs 7 keeps the `protobufjs/minimal` runtime that generated static code uses.
q: Does tinypool 2 work for vitest 3? | a: Yes, by evidence: the full portfolio-tracker (481 tests) and expense-tracker (1709 tests, with poppler and qpdf installed) suites pass under tinypool 2.2.0 in node:22 containers.

# Plan: clear the critical Dependabot alerts (issue #100)

## Change

1. `npm update proxy-addr --package-lock-only` in the four module lockfiles (2.0.7 → 2.0.8; express already allows it).
2. Add `"overrides": {"protobufjs": "^7.5.5", "tinypool": "^2.1.2"}` to the portfolio-tracker and expense-tracker `package.json`, and refresh their lockfiles.

## Tests

- New `modules/tests/test_critical_dependency_floors.py` reads the four lockfiles and fails if any resolves a vulnerable version. It fails at base.
- The portfolio-tracker and expense-tracker vitest suites pass in node:22 containers; CI runs them again.
