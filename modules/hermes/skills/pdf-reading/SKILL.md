---
name: pdf-reading
description: Use whenever you read a PDF, including files the owner uploads in the app, bank and card statements, and email attachments. Scanned pages come back blank from other readers.
version: 1.0.0
author: Hermes Agent
license: MIT-0
metadata:
  hermes:
    tags: [pdf, ocr, statements, uploads]
---

# Reading PDFs

Always read a PDF with `pdftext`, never with pypdf, a Python one-liner or plain `pdftotext`:

```
pdftext /path/to/file.pdf
```

A locked PDF (for example a bank statement) takes the password on stdin:

```
printf %s '<password>' | pdftext /path/to/file.pdf --password-stdin
```

Why: some statements are scanned, so their pages are pictures with no text layer.
Other readers return those pages blank, and the file then looks like it holds only the terms pages (#266).
`pdftext` OCRs those pages, which takes about 10 seconds per scanned page.

Pages are separated by a form feed. When a page reads
`[PDF_PAGE_N_IMAGE_ONLY: ...]`, OCR could not read that scanned page. Tell the owner
the page is a scanned image that could not be read. Do not ask for "a clearer PDF".
