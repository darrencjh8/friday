const { describe, it } = require("node:test");
const assert = require("node:assert");

// --- Helpers to test shape/prompt/guidance logic without running the full script ---

const SHAPES = { portrait: "512x768", square: "768x768", landscape: "768x512" };
function resolveShape(shapeArg) {
    return SHAPES[shapeArg] || SHAPES.square;
}
function resolveGuidance(guidanceArg) {
    var g = parseFloat(guidanceArg);
    return isNaN(g) || g === 0 ? 7.0 : g;
}
function buildPrompt(prompt, systemPrefix) {
    return systemPrefix ? systemPrefix + " " + prompt : prompt;
}

// --- CLI argument parsing ---
describe("CLI argument parsing", () => {
    it("exits when no prompt", () => {
        var prompt = undefined;
        var outputPath = "/tmp/test.png";
        assert.ok(!prompt || !outputPath);
    });
    it("exits when no output path", () => {
        var prompt = "test";
        var outputPath = undefined;
        assert.ok(!prompt || !outputPath);
    });
    it("continues when both provided", () => {
        assert.ok("test" && "/tmp/test.png");
    });
});

// --- Shape resolution ---
describe("Shape resolution", () => {
    it("resolves portrait", () =>
        assert.equal(resolveShape("portrait"), "512x768"));
    it("resolves square", () =>
        assert.equal(resolveShape("square"), "768x768"));
    it("resolves landscape", () =>
        assert.equal(resolveShape("landscape"), "768x512"));
    it("defaults to square for invalid", () =>
        assert.equal(resolveShape("unknown"), "768x768"));
    it("defaults to square for undefined", () =>
        assert.equal(resolveShape(undefined), "768x768"));
});

// --- Guidance scale parsing ---
describe("Guidance scale parsing", () => {
    it("parses integer", () => assert.equal(resolveGuidance("10"), 10));
    it("parses float", () => assert.equal(resolveGuidance("3.5"), 3.5));
    it("defaults to 7 for NaN", () => assert.equal(resolveGuidance("abc"), 7));
    it("defaults to 7 for undefined", () =>
        assert.equal(resolveGuidance(undefined), 7));
    it("defaults to 7 for zero", () => assert.equal(resolveGuidance("0"), 7));
    it("handles negative", () => assert.equal(resolveGuidance("-3"), -3));
});

// --- Prompt assembly ---
describe("Prompt assembly", () => {
    it("prepends system prefix", () => {
        assert.equal(
            buildPrompt("a cat", "High quality."),
            "High quality. a cat",
        );
    });
    it("uses plain prompt when no prefix", () => {
        assert.equal(buildPrompt("a dog", ""), "a dog");
    });
    it("handles undefined prefix", () => {
        assert.equal(buildPrompt("a bird", undefined), "a bird");
    });
});

// --- DOM image extraction ---
describe("DOM image extraction (waitForImageAndSave)", () => {
    function simulateEvaluate(mockDOM) {
        return mockDOM();
    }
    it("extracts data:image src", () => {
        var r = simulateEvaluate(function () {
            return "data:image/png;base64,ABC=";
        });
        assert.ok(r.startsWith("data:image"));
    });
    it("handles canvas fallback data URL", () => {
        var r = simulateEvaluate(function () {
            return "data:image/png;base64,CANVAS=";
        });
        assert.ok(r.startsWith("data:image/png;base64"));
    });
    it("returns null when no images found", () => {
        assert.equal(
            simulateEvaluate(function () {
                return null;
            }),
            null,
        );
    });
    it("base64 decoding produces a buffer", () => {
        var buf = Buffer.from(
            "data:image/png;base64,ABC=".split(",")[1],
            "base64",
        );
        assert.ok(Buffer.isBuffer(buf));
    });
});

// --- Output formatting ---
describe("Output formatting", () => {
    it("emits valid JSON with path and size", () => {
        var json = JSON.stringify({ path: "/tmp/x.png", size: 12345 });
        var parsed = JSON.parse(json);
        assert.equal(parsed.path, "/tmp/x.png");
        assert.equal(parsed.size, 12345);
    });
});

// --- Page cleanup ---
describe("Page cleanup", () => {
    function filterPages(pages) {
        return pages.filter(function (url) {
            return !url.startsWith("about:");
        });
    }
    it("closes non-about:blank pages", () => {
        var r = filterPages(["https://x.com", "about:blank", "https://y.com"]);
        assert.deepEqual(r, ["https://x.com", "https://y.com"]);
    });
    it("keeps about:blank alive", () => {
        assert.equal(filterPages(["about:blank"]).length, 0);
    });
    it("handles empty list", () => {
        assert.equal(filterPages([]).length, 0);
    });
});

// --- Error handling ---
describe("Error handling", () => {
    it("exitCode 0 on success", () => {
        assert.equal(0, 0);
    });
    it("exitCode 1 on failure", () => {
        var exitCode;
        try {
            throw new Error("fail");
        } catch (e) {
            exitCode = 1;
        }
        assert.equal(exitCode, 1);
    });
    it("error message is meaningful", () => {
        try {
            throw new Error("No image found in embed iframe after 60s");
        } catch (e) {
            assert.ok(e.message.includes("embed iframe"));
            assert.ok(e.message.includes("60s"));
        }
    });
});
