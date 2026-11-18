"""pdftext OCRs scanned PDF pages that pdftotext returns blank (#266)."""
import importlib.util
import pathlib
import subprocess
import unittest
from types import SimpleNamespace

_SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "pdftext.py"
_spec = importlib.util.spec_from_file_location("pdftext", _SCRIPT)
pdftext = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pdftext)

IMAGE_ON_PAGE_1 = "page num type\n---- --- ----\n   1   0 image\n"


class FakeRun:
    def __init__(self, text, images=IMAGE_ON_PAGE_1, tesseract_fails=False, qpdf_code=0):
        self.text, self.images = text, images
        self.tesseract_fails, self.qpdf_code = tesseract_fails, qpdf_code
        self.calls = []

    def __call__(self, args, check=False, **kwargs):
        self.calls.append((args, kwargs))
        cmd, code, out = args[0], 0, ""
        if cmd == "pdftotext":
            out = self.text
        elif cmd == "pdfimages":
            out = self.images
        elif cmd == "tesseract":
            code, out = (1, "") if self.tesseract_fails else (0, "OCR STATEMENT\n")
        elif cmd == "qpdf":
            code = self.qpdf_code
        if check and code:
            raise subprocess.CalledProcessError(code, args, out, "boom")
        return SimpleNamespace(returncode=code, stdout=out, stderr="")

    def cmds(self):
        return [args[0] for args, _ in self.calls]


class PdfTextTest(unittest.TestCase):
    def test_ocrs_blank_image_page_and_keeps_text_pages(self):
        run = FakeRun("  \n\fTERMS AND FEES\n\f")
        text = pdftext.extract("in.pdf", run=run)
        self.assertIn("OCR STATEMENT", text)
        self.assertIn("TERMS AND FEES", text)
        ppm = [args for args, _ in run.calls if args[0] == "pdftoppm"]
        self.assertEqual(len(ppm), 1)
        self.assertEqual(ppm[0][ppm[0].index("-f") + 1], "1")

    def test_skips_ocr_when_every_page_has_text(self):
        run = FakeRun("ONE\fTWO\f")
        self.assertEqual(pdftext.extract("in.pdf", run=run), "ONE\fTWO\f")
        self.assertEqual(run.cmds(), ["pdftotext"])

    def test_leaves_blank_page_without_image_alone(self):
        run = FakeRun("\fTERMS\f", images="page num type\n---- --- ----\n")
        self.assertEqual(pdftext.extract("in.pdf", run=run), "\fTERMS\f")
        self.assertEqual(run.cmds(), ["pdftotext", "pdfimages"])

    def test_marks_page_when_ocr_fails(self):
        run = FakeRun("\fTERMS\f", tesseract_fails=True)
        text = pdftext.extract("in.pdf", run=run)
        self.assertIn("[PDF_PAGE_1_IMAGE_ONLY", text)
        self.assertIn("TERMS", text)

    def test_password_goes_to_qpdf_on_stdin_not_argv(self):
        run = FakeRun("\f")
        pdftext.extract("in.pdf", password="s3cret", run=run)
        args, kwargs = run.calls[0]
        self.assertEqual(args[0], "qpdf")
        self.assertNotIn("s3cret", " ".join(args))
        self.assertEqual(kwargs["input"], "s3cret")
        self.assertEqual(run.cmds()[1:], ["pdftotext", "pdfimages", "pdftoppm", "tesseract"])

    def test_qpdf_exit_3_is_success_and_2_is_wrong_password(self):
        pdftext.extract("in.pdf", password="pw", run=FakeRun("A\f", qpdf_code=3))
        with self.assertRaises(pdftext.PdfError):
            pdftext.extract("in.pdf", password="bad", run=FakeRun("A\f", qpdf_code=2))


if __name__ == "__main__":
    unittest.main()
