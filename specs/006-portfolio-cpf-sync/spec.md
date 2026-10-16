# CPF Statement PDF Sync — Spec

**Status:** NOT YET IMPLEMENTED

## Overview

Sync CPF (Central Provident Fund) contribution and balance data from monthly/annual CPF statement PDFs into Plain Text Accounting (PP) and Actual Budget (AB, part of expense-tracker). The PDF is OCR'd via tesseract, parsed for structured data, and routed to both the portfolio-tracker and expense-tracker skills.

## User Stories

### US-1: Parse CPF statement PDF
- OCR the PDF using tesseract (via pdf2image → tesseract pipeline)
- Extract Ordinary Account (OA), Special Account (SA), and Medisave Account (MA) contributions and balances
- Handle both monthly contribution statements and annual statements
- Output structured JSON

### US-2: Insert CPF OA contributions as PP transactions
- Map OA contributions to the CPF OA account in PP (uuid: d22c2c5f-d075-453d-87c7-2ec54ec0ee18)
- Record employer contribution, employee contribution, and total as DEPOSIT transactions
- Similar for SA and MA

### US-3: Sync CPF balances to Actual Budget
- Part of the expense-tracker flow
- Create AB budget entries for CPF Contribution and CPF Interest categories

### US-4: Telegram trigger — invoke both skills
- When a CPF PDF is sent to the Telegram bot
- Portfolio-tracker skill handles PP insertion
- Expense-tracker skill handles AB entry
- Both are invoked from a single PDF upload

### US-5: Extract monthly CPF statement data
- Employer contribution amount
- Employee contribution amount
- Interest earned per account (OA, SA, MA)
- Statement period / month

## Edge Cases

- **Multiple pages:** CPF statements may span multiple PDF pages; parser must concatenate OCR output
- **Rotated PDF:** Some scanned PDFs may be rotated; auto-deskew before OCR
- **Different statement formats:** Monthly contribution statement and annual statement have different layouts
- **Interest rate changes:** CPF interest rates change over time; parser should extract actual interest earned rather than compute
- **Partial year statements:** Only show contributions for part of the year; handle missing months gracefully
