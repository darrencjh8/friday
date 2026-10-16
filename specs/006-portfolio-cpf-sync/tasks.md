# CPF Statement PDF Sync — Tasks

**Status:** NOT DONE

## Phase 1: Parser
- [ ] T1.1 Create src/extractors/cpf_parser.py
- [ ] T1.2 OCR pipeline (pdf2image → tesseract)
- [ ] T1.3 Parse OA/SA/MA contribution amounts
- [ ] T1.4 Parse employer vs employee split
- [ ] T1.5 Parse interest earned per account
- [ ] T1.6 Handle annual vs monthly statement formats

## Phase 2: PP Integration
- [ ] T2.1 Map CPF OA/SA/MA to PP account UUIDs
- [ ] T2.2 Create DEPOSIT transactions for contributions
- [ ] T2.3 Create INTEREST transactions for interest earned
- [ ] T2.4 Dedup to prevent double-insertion

## Phase 3: AB Integration (expense-tracker)
- [ ] T3.1 Create AB budget entries for CPF flows
- [ ] T3.2 Cross-module tool call from portfolio-tracker to expense-tracker (or shared tool)
- [ ] T3.3 Handle CPF statement as income in AB

## Phase 4: Channels
- [ ] T4.1 Telegram PDF handler for CPF
- [ ] T4.2 Invoke both portfolio + expense skills on single CPF PDF

## Phase 5: Tests
- [ ] T5.1 Unit test CPF parser
- [ ] T5.2 Test OCR pipeline with sample CPF statement
- [ ] T5.3 Integration test: CPF PDF → PP + AB
- [ ] T5.4 Cross-module test (both services called)
