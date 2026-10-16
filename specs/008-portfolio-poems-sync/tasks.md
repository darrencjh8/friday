# POEMS Statement PDF Sync — Tasks

**Status:** NOT DONE

## Phase 1: Parser
- [ ] T1.1 Create src/extractors/poems_parser.py
- [ ] T1.2 OCR pipeline (pdf2image → tesseract)
- [ ] T1.3 Extract trades (date, ticker, buy/sell, qty, price, fees)
- [ ] T1.4 Extract dividends
- [ ] T1.5 Extract period-end holdings table
- [ ] T1.6 Handle CPFIA and SRS sub-account sections

## Phase 2: PP Integration
- [ ] T2.1 Map POEMS/CPFIA/SRS to PP account UUIDs
- [ ] T2.2 Create BUY/SELL transactions in PP
- [ ] T2.3 Create DEPOSIT transactions for dividends
- [ ] T2.4 Dedup to prevent double-insertion

## Phase 3: Reconciliation
- [ ] T3.1 Fetch current PP portfolio positions
- [ ] T3.2 Compare statement holdings vs PP positions
- [ ] T3.3 Report discrepancies

## Phase 4: Tests
- [ ] T4.1 Unit test POEMS parser
- [ ] T4.2 Test OCR pipeline with sample POEMS statement
- [ ] T4.3 Integration test: POEMS PDF → PP
- [ ] T4.4 Test reconciliation logic
