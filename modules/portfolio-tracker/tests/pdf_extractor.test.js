/**
 * PDF OCR text extraction tests.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("pdf_extractor", () => {
  describe("extractPdfText", () => {
    describe("with all dependencies available", () => {
      let extractPdfText;

      beforeEach(async () => {
        vi.resetModules();
        vi.doMock("pdf2pic", () => {
          const mockConvert = vi.fn().mockResolvedValue([
            { name: "page-1", buffer: Buffer.from("fake-png") },
          ]);
          return {
            fromBuffer: vi.fn().mockReturnValue(mockConvert),
          };
        });
        vi.doMock("tesseract.js", () => ({
          default: {
            recognize: vi
              .fn()
              .mockResolvedValue({ data: { text: "Trade confirmation: BUY 100 AAPL" } }),
          },
        }));
        const mod = await import("../src/pdf_extractor.js");
        extractPdfText = mod.extractPdfText;
      });

      it("extracts text from valid PDF buffer", async () => {
        const text = await extractPdfText(Buffer.from("fake-pdf"));
        expect(text).toContain("Trade confirmation: BUY 100 AAPL");
      });

      it("accepts a Buffer input", async () => {
        const buf = Buffer.from("pretend-pdf-content");
        const text = await extractPdfText(buf);
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
      });
    });

    describe("with multi-page PDF", () => {
      let extractPdfText;

      beforeEach(async () => {
        vi.resetModules();
        vi.doMock("pdf2pic", () => {
          const mockConvert = vi.fn().mockResolvedValue([
            { name: "page-1", buffer: Buffer.from("fake-png-page1") },
            { name: "page-2", buffer: Buffer.from("fake-png-page2") },
          ]);
          return { fromBuffer: vi.fn().mockReturnValue(mockConvert) };
        });
        vi.doMock("tesseract.js", () => {
          let callCount = 0;
          return {
            default: {
              recognize: vi.fn().mockImplementation(() => {
                callCount++;
                return Promise.resolve({
                  data: { text: `Page ${callCount} text` },
                });
              }),
            },
          };
        });
        const mod = await import("../src/pdf_extractor.js");
        extractPdfText = mod.extractPdfText;
      });

      it("concatenates text from all pages with page breaks", async () => {
        const text = await extractPdfText(Buffer.from("fake-multi-page-pdf"));
        expect(text).toContain("Page 1 text");
        expect(text).toContain("--- PAGE BREAK ---");
        expect(text).toContain("Page 2 text");
      });
    });

    describe("with empty page output", () => {
      let extractPdfText;

      beforeEach(async () => {
        vi.resetModules();
        vi.doMock("pdf2pic", () => {
          const mockConvert = vi.fn().mockResolvedValue([
            { name: "page-1", buffer: Buffer.from("blank-png") },
          ]);
          return { fromBuffer: vi.fn().mockReturnValue(mockConvert) };
        });
        vi.doMock("tesseract.js", () => ({
          default: {
            recognize: vi
              .fn()
              .mockResolvedValue({ data: { text: "   " } }),
          },
        }));
        const mod = await import("../src/pdf_extractor.js");
        extractPdfText = mod.extractPdfText;
      });

      it("returns empty string for blank OCR output", async () => {
        const text = await extractPdfText(Buffer.from("empty-pdf"));
        expect(text).toBe("");
      });
    });

    describe("with missing dependencies", () => {
      let extractPdfText;

      beforeEach(async () => {
        vi.resetModules();
        vi.doMock("tesseract.js", () => {
          throw new Error("Module not found");
        });
        // pdf2pic is still installed but tesseract missing → OCR unavailable
        const mod = await import("../src/pdf_extractor.js");
        extractPdfText = mod.extractPdfText;
      });

      it("returns unavailable marker when tesseract is missing", async () => {
        const text = await extractPdfText(Buffer.from("fake-pdf"));
        expect(text).toBe("[PDF_OCR_UNAVAILABLE]");
      });
    });

    describe("OCR processing error", () => {
      let extractPdfText;

      beforeEach(async () => {
        vi.resetModules();
        vi.doMock("pdf2pic", () => {
          const mockConvert = vi.fn().mockResolvedValue([
            { buffer: Buffer.from("fake-png") },
          ]);
          return { fromBuffer: vi.fn().mockReturnValue(mockConvert) };
        });
        vi.doMock("tesseract.js", () => ({
          default: {
            recognize: vi
              .fn()
              .mockRejectedValue(new Error("OCR engine crashed")),
          },
        }));
        const mod = await import("../src/pdf_extractor.js");
        extractPdfText = mod.extractPdfText;
      });

      it("returns error marker on OCR failure", async () => {
        const text = await extractPdfText(Buffer.from("bad-pdf"));
        expect(text).toBe("[PDF_OCR_ERROR: OCR engine crashed]");
      });
    });

    describe("page conversion error", () => {
      let extractPdfText;

      beforeEach(async () => {
        vi.resetModules();
        vi.doMock("pdf2pic", () => {
          const mockConvert = vi
            .fn()
            .mockRejectedValue(new Error("pdf2pic conversion failed"));
          return { fromBuffer: vi.fn().mockReturnValue(mockConvert) };
        });
        vi.doMock("tesseract.js", () => ({
          default: {
            recognize: vi.fn(),
          },
        }));
        const mod = await import("../src/pdf_extractor.js");
        extractPdfText = mod.extractPdfText;
      });

      it("returns error marker on conversion failure", async () => {
        const text = await extractPdfText(Buffer.from("corrupt-pdf"));
        expect(text).toBe("[PDF_OCR_ERROR: pdf2pic conversion failed]");
      });
    });
  });

  describe("extractPdfTextFromFile", () => {
    let extractPdfTextFromFile;

    describe("file exists", () => {
      beforeEach(async () => {
        vi.resetModules();
        vi.doMock("fs", () => ({
          existsSync: vi.fn().mockReturnValue(true),
          readFileSync: vi.fn().mockReturnValue(Buffer.from("pdf-bytes")),
        }));
        vi.doMock("pdf2pic", () => {
          const mockConvert = vi.fn().mockResolvedValue([
            { buffer: Buffer.from("fake-png") },
          ]);
          return { fromBuffer: vi.fn().mockReturnValue(mockConvert) };
        });
        vi.doMock("tesseract.js", () => ({
          default: {
            recognize: vi
              .fn()
              .mockResolvedValue({ data: { text: "File-based OCR result" } }),
          },
        }));
        const mod = await import("../src/pdf_extractor.js");
        extractPdfTextFromFile = mod.extractPdfTextFromFile;
      });

      it("reads PDF from disk and extracts text", async () => {
        const text = await extractPdfTextFromFile("/path/to/file.pdf");
        expect(text).toBe("File-based OCR result");
      });
    });

    describe("file not found", () => {
      beforeEach(async () => {
        vi.resetModules();
        vi.doMock("fs", () => ({
          existsSync: vi.fn().mockReturnValue(false),
          readFileSync: vi.fn(),
        }));
        const mod = await import("../src/pdf_extractor.js");
        extractPdfTextFromFile = mod.extractPdfTextFromFile;
      });

      it("returns not-found marker when file is missing", async () => {
        const text = await extractPdfTextFromFile("/nonexistent/file.pdf");
        expect(text).toBe("[PDF_FILE_NOT_FOUND]");
      });
    });
  });
});
