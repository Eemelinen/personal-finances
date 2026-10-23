# FIN-012: CSV import (Nordea, S-Pankki)

**Milestone:** M1 Bank data · **Status:** Todo · **Depends on:** FIN-005

## Description

Import transactions from the banks' own CSV exports. This is the fallback if API access is unavailable or delayed, and also a way to load history older than the API provides.

## Acceptance criteria

- [ ] `/import` page: upload a CSV, choose the target account (or create a manual account), preview the parsed rows, confirm
- [ ] Parsers for the **Nordea** and **S-Pankki** netbank export formats: delimiter, decimal comma, `dd.mm.yyyy` dates, encoding (UTF-8 or Windows-1252), column names
- [ ] A generic CSV mapping (choose the columns) for other formats
- [ ] Rows go through the same upsert and dedupe path as API sync (FIN-009), so overlapping imports and API data don't duplicate
- [ ] An import summary: rows read, inserted, skipped as duplicates, errors with row numbers
- [ ] Unit tests with anonymized sample files for both banks in `src/server/providers/csv/__fixtures__/`

## Notes

- Never commit real bank exports. Fixtures must be synthetic.
