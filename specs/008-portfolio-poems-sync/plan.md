# POEMS Statement PDF Sync — Plan

**Status:** NOT YET IMPLEMENTED

## Components

### Parser
- **File:** `src/extractors/poems_parser.py` (to be created)
- Converts PDF pages to images → OCR → structured extraction
- Regex + table detection for trade entries

### PP Accounts (UUIDs)
| Account        | UUID |
|----------------|------|
| POEMS          | `03f93d83-ae13-4f53-9279-b4df566c5a79` |
| POEMS CPFIA    | `864efa79-090d-4df7-ab78-de0f5666d332` |
| POEMS SRS      | `5db60b61-6a7b-4a82-a52e-e3b31c1ef40b` |

### Statement Format
- Monthly PDF containing:
  - Trade summary (date, ticker, buy/sell, quantity, price, net amount)
  - Fees and charges
  - Dividends received
  - Period-end holdings table

### Data Flow
```
PDF upload → OCR → parser → structured JSON → LLM 
  → insert_pp_transaction (trades, dividends)
  → reconcile_holdings (compare vs PP portfolio)
```
