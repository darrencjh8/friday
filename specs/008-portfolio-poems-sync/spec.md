# POEMS Statement PDF Sync — Spec

**Status:** NOT YET IMPLEMENTED

## Overview

Sync POEMS (Phillip Securities) monthly statement PDF data into Plain Text Accounting (PP). Statements contain trade activity, fees, dividends, and holdings information that need to be reconciled against the PP POEMS portfolio.

## User Stories

### US-1: Parse POEMS monthly statement PDF
- OCR the PDF using tesseract (pdf2image → tesseract pipeline)
- Extract structured data: trades (buy/sell), fees, dividends, and period-end holdings
- Output structured JSON per statement

### US-2: Insert POEMS trades into PP POEMS account
- Map trades to the PP POEMS account (uuid: 03f93d83-ae13-4f53-9279-b4df566c5a79)
- Create BUY/SELL transactions in PP with correct ticker, quantity, price, fees
- Handle cash dividends as DEPOSIT entries
- Support CPFIA (864efa79-090d-4df7-ab78-de0f5666d332) and SRS (5db60b61-6a7b-4a82-a52e-e3b31c1ef40b) sub-accounts

### US-3: Reconcile holdings
- Compare POEMS statement holdings with PP portfolio positions
- Flag discrepancies for manual review
- Support partial reconciliation (ignore minor fx rounding)

## Edge Cases

- **Multiple pages:** Statements may span multiple pages; concatenate OCR output
- **Scanned PDFs:** Some statements are scanned images requiring full OCR
- **Trade corrections:** Canceled or amended trades in subsequent statements
- **Corporate actions:** Stock splits, dividends reinvested, rights issues
- **Currency:** POEMS supports SGD and USD; handle multi-currency trades
