const { chromium } = require("playwright");
const { writeFileSync } = require("fs");

const [
    ,
    ,
    prompt,
    outputPath,
    shapeArg,
    systemPrefixArg,
    negativePromptArg,
    guidanceArg,
] = process.argv;
if (!prompt || !outputPath) {
    console.error(
        "Usage: node perchance-image.cjs <prompt> <output-path> [shape] [system-prefix] [negative-prompt] [guidance]",
    );
    process.exit(1);
}

var HOST_CDP = process.env.CDP_URL || "http://172.17.0.1:9223";
var SHAPES = { portrait: "512x768", square: "768x768", landscape: "768x512" };
var shape = SHAPES[shapeArg] || SHAPES.square;
var fullPrompt = systemPrefixArg ? systemPrefixArg + " " + prompt : prompt;
var negativePromptStr = negativePromptArg || "";
var guidance = parseFloat(guidanceArg) || 7.0;

/** Retry CDP connection up to 3 times */
async function connectCDP(url) {
    for (var i = 0; i < 3; i++) {
        try {
            return await chromium.connectOverCDP(url);
        } catch (e) {
            if (i === 2) throw e;
            await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        }
    }
}

/** Wait for an <img> inside the embed iframe, grab it, save as PNG */
async function waitForImageAndSave(embedFrame) {
    for (var i = 0; i < 150; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
            var b64 = await embedFrame.evaluate(async function () {
                var imgs = document.querySelectorAll("img");
                for (var img of imgs) {
                    if (img.naturalWidth > 100) {
                        if (img.src && img.src.startsWith("data:image")) {
                            return img.src;
                        }
                        try {
                            var c = document.createElement("canvas");
                            c.width = img.naturalWidth;
                            c.height = img.naturalHeight;
                            var ctx = c.getContext("2d");
                            ctx.drawImage(img, 0, 0);
                            return c.toDataURL("image/png");
                        } catch (e) {}
                    }
                }
                return null;
            });
            if (b64) {
                writeFileSync(
                    outputPath,
                    Buffer.from(b64.split(",")[1], "base64"),
                );
                return Buffer.byteLength(b64);
            }
        } catch (e) {}
    }
    throw new Error("No image found in embed iframe after 90s");
}

(async function () {
    var page,
        browser,
        exitCode = 1;
    try {
        browser = await connectCDP(HOST_CDP);
        var context =
            browser.contexts()[0] ||
            browser.contexts()[Object.keys(browser.contexts())[0]];
        page = await context.newPage();

        // Navigate to the generator page with network idle wait
        await page.goto("https://perchance.org/ai-character-generator", {
            waitUntil: "networkidle",
            timeout: 45000,
        });
        await new Promise((r) => setTimeout(r, 5000));

        // Find the generator iframe with retry
        var genFrame = null;
        for (var retry = 0; retry < 3 && !genFrame; retry++) {
            for (var f of page.frames()) {
                if (
                    f.url().includes(".perchance.org/ai-character-generator") &&
                    !f
                        .url()
                        .startsWith(
                            "https://perchance.org/ai-character-generator",
                        )
                ) {
                    genFrame = f;
                    break;
                }
            }
            if (!genFrame) await new Promise((r) => setTimeout(r, 3000));
        }
        if (!genFrame) throw new Error("Generator iframe not found");

        // Set resolution/shape
        if (shapeArg && SHAPES[shapeArg]) {
            try {
                var shapeBtn = genFrame.locator(
                    "button[data-name=" + shapeArg + "]",
                );
                if ((await shapeBtn.count()) > 0) await shapeBtn.click();
                await new Promise((r) => setTimeout(r, 500));
            } catch (e) {}
        }

        // Set negative prompt if provided
        if (negativePromptStr) {
            try {
                await genFrame
                    .locator("textarea[data-name=negativePrompt]")
                    .fill(negativePromptStr);
                await new Promise((r) => setTimeout(r, 300));
            } catch (e) {}
        }

        // Set guidance if not default
        if (guidance !== 7.0) {
            try {
                var guideSlider = genFrame.locator(
                    "input[data-name=guidanceScale]",
                );
                if ((await guideSlider.count()) > 0) {
                    await guideSlider.fill(String(guidance));
                }
            } catch (e) {}
        }

        // Type the prompt
        var descTextarea = genFrame.locator("textarea[data-name=description]");
        await descTextarea.fill(fullPrompt);
        await new Promise((r) => setTimeout(r, 1000));

        // Click Generate
        await genFrame.locator("#generateButtonEl").click();

        // Wait for the embed iframe to appear (up to 60s)
        var embedFrame = null;
        for (var i = 0; i < 30 && !embedFrame; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            for (var f of page.frames()) {
                if (f.url().includes("image-generation.perchance.org/embed")) {
                    embedFrame = f;
                    break;
                }
            }
        }
        if (!embedFrame) throw new Error("Embed iframe not found after 60s");

        // Wait for image and save
        var size = await waitForImageAndSave(embedFrame);
        console.log(JSON.stringify({ path: outputPath, size: size }));
        exitCode = 0;
    } catch (e) {
        console.error(e.message);
    } finally {
        // Close all pages to prevent tab accumulation
        try {
            var ctx = browser ? browser.contexts()[0] : null;
            if (ctx) {
                for (var p of ctx.pages()) {
                    if (!p.url().startsWith("about:")) {
                        try {
                            await p.close();
                        } catch (e) {}
                    }
                }
            }
        } catch (e) {}
    }
    process.exit(exitCode);
})();
