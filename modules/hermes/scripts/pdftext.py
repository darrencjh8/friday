#!/usr/bin/env python3
"""Print a PDF's text, OCR'ing scanned pages (stdlib only).

pdftotext returns nothing for a page that is only an image, so scanned bank
statement pages looked blank to Friday (#266). Blank pages that hold an image
are rendered with pdftoppm and read with tesseract; text pages are kept as is.
Same approach as extractPdfFromBuffer in modules/expense-tracker/src/extractors.js.

Usage:
    pdftext FILE
    printf %s PASSWORD | pdftext FILE --password-stdin

The password goes to qpdf on stdin, never argv (#263).
"""
import os
import subprocess
import sys
import tempfile

# qpdf exit 3 means warnings, and the decrypted output is still written (#647).
_QPDF_OK = (0, 3)


class PdfError(Exception):
    pass


def _out(run, args):
    return run(args, capture_output=True, text=True, check=True).stdout


def _ocr_page(run, path, n, tmp):
    img = os.path.join(tmp, f"p{n}")
    try:
        _out(run, ["pdftoppm", "-r", "300", "-f", n, "-l", n, "-singlefile", "-png", path, img])
        text = _out(run, ["tesseract", img + ".png", "stdout"]).strip()
    except (OSError, subprocess.CalledProcessError) as error:
        return f"[PDF_PAGE_{n}_IMAGE_ONLY: scanned page, OCR failed: {type(error).__name__}]"
    return text or f"[PDF_PAGE_{n}_IMAGE_ONLY: OCR found no text]"


def extract(path, password=None, run=subprocess.run):
    with tempfile.TemporaryDirectory(prefix="pdftext-") as tmp:
        if password is not None:
            decrypted = os.path.join(tmp, "dec.pdf")
            result = run(["qpdf", "--password-file=-", "--decrypt", path, decrypted],
                         input=password, capture_output=True, text=True)
            if result.returncode not in _QPDF_OK:
                raise PdfError("qpdf could not decrypt the PDF (wrong password?)")
            path = decrypted
        text = _out(run, ["pdftotext", "-layout", path, "-"])
        # pdftotext ends every page with a form feed, so the last part is empty.
        pages = text.split("\f")
        blank = [i for i, page in enumerate(pages[:-1]) if not page.strip()]
        if not blank:
            return text
        # `pdfimages -list` rows start with the page number; header rows do not.
        listing = run(["pdfimages", "-list", path], capture_output=True, text=True).stdout
        image_pages = {row.split()[0] for row in listing.splitlines() if row.split() and row.split()[0].isdigit()}
        for i in blank:
            if str(i + 1) in image_pages:
                pages[i] = _ocr_page(run, path, str(i + 1), tmp)
        return "\f".join(pages)


def main(argv):
    if len(argv) not in (1, 2) or (len(argv) == 2 and argv[1] != "--password-stdin"):
        print(__doc__.split("Usage:")[1].split("The password")[0].strip(), file=sys.stderr)
        return 2
    password = sys.stdin.read().strip() if len(argv) == 2 else None
    try:
        sys.stdout.write(extract(argv[0], password))
    except PdfError as error:
        print(f"pdftext: {error}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or "").strip().splitlines()
        print(f"pdftext: {error.cmd[0]} failed: {detail[-1] if detail else error.returncode}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
