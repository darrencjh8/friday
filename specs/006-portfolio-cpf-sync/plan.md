# CPF Statement PDF Sync — Plan

**Status:** NOT YET IMPLEMENTED

## Components

### Parser
- **File:** `src/extractors/cpf_parser.py` (to be created)
- Converts PDF pages to images via `pdf2image`
- OCR via `tesseract-ocr` (already installed in Docker image)
- Regex-based extraction of OA/SA/MA contributions, balances, interest

### OCR Pipeline
- `pdf2image` → PIL image → `pytesseract` → raw text → parser

### PP Accounts (UUIDs)
| Account | UUID |
|---------|------|
| CPF OA  | `d22c2c5f-d075-453d-87c7-2ec54ec0ee18` |
| CPF SA  | `c5dc9487-0c43-4fe3-8bdd-ef322913ad3f` |
| CPF MA  | `021eef51-8080-4437-97e3-18878d2b6398` |

### AB Categories
- **CPF Contribution:** employer + employee contributions
- **CPF Interest:** interest earned per account

### Cross-Module Data Flow
- Portfolio-tracker writes DEPOSIT/INTEREST transactions to PP
- Expense-tracker writes budget entries to AB
- Both are invoked from a single Telegram handler

### Telegram Flow
```
PDF upload → OCR → parser → structured data → LLM 
  → portfolio-tracker: insert_pp_transaction 
  → expense-tracker: AB budget update
```
