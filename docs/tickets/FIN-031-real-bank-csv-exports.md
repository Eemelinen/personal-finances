# FIN-031: Real bank CSV exports

**Feature:** F-031 · **Milestone:** M6 Data correctness · **Area:** banking · **Depends on:** [F-012](FIN-012-csv-import.md), [F-028](FIN-028-counterparty-account-numbers.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-031`. This ticket is the spec the session reads first.

## Goal

`/import` reads the exports the S-Pankki and Nordea netbanks really produce (October 2026), including the Nordea credit card export, with the counterparty name, account number and the bank's archive id in the right fields. F-012's layouts were written without a real file (D-011) and mis-read several columns.

## Acceptance criteria

- S-Pankki (`Kirjauspäivä;Maksupäivä;Summa;Tapahtumalaji;Maksaja;Saajan nimi;Saajan tilinumero;Saajan BIC-tunnus;Viitenumero;Viesti;Arkistointitunnus`):
  - a cell wrapped in single quotes (`'Wedding gift'`) is unwrapped; `-` and `'-'` are empty
  - `Arkistointitunnus` becomes the row's `ref`
  - `Saajan tilinumero` (trailing spaces trimmed, normalised) becomes `counterpartyIban` for money out; for money in the account column names the receiving account, so it is not the counterparty's
  - counterparty: `Saajan nimi` for money out, `Maksaja` for money in (as now)
- Nordea netbank (`Kirjauspäivä;Määrä;Maksaja;Maksunsaaja;Nimi;Otsikko;Viesti;Viitenumero;Saldo;Valuutta;`, dates `yyyy/mm/dd`, trailing delimiter):
  - `Maksaja` and `Maksunsaaja` hold account numbers: the other side's one (`Maksunsaaja` for money out, `Maksaja` for money in) becomes `counterpartyIban`, never the counterparty name (today a debit's counterparty is an IBAN)
  - counterparty from `Nimi`, else `Otsikko` unless it is a generic word such as `Tilisiirto`; description from `Viesti`
  - rows identical in every column including `Saldo` are one export duplicate: imported once, counted in the summary as "repeated in the file"
- Nordea credit card (`Tapahtumapäivä;Kirjauspäivä;Otsikko;Määrä;Valuutta;Tapahtumatyyppi;Alkuperäinen määrä;…`, quoted cells, `d.m.yyyy`, decimal point): its own format `nordea-card`, detected by `Tapahtumapäivä` + `Otsikko` + `Määrä`; booking date `Kirjauspäivä`, value date `Tapahtumapäivä`, description `Otsikko`, no counterparty; a foreign-currency purchase uses the EUR `Määrä`
- `prepareRows()` (`src/server/csv/import-csv.ts`) keeps a row's `ref` and `counterpartyIban` instead of forcing `ref: null`
- New synthetic fixtures in `tests/fixtures/csv/` copy the real headers, quoting and encodings with made-up rows (no real data); the format list on `/import` names the card export
- D-011 in `docs/DECISIONS.md` gets a dated amendment with the verified layouts

## Tests (what the verification proves)

- **L1** `tests/unit/csv/bank-csv.test.ts`: the three real layouts (quoted cells, placeholders, archive id as ref, IBAN columns, Nordea duplicate lines, card export with decimal points and quoted cells), the old fixtures still parse
- **L2** `tests/integration/csv-import.int.test.ts`: an imported S-Pankki row keeps its ref and counterparty IBAN

## Notes

- Verified on 2026-10-24 against real exports: the S-Pankki `Arkistointitunnus` equals the Enable Banking `entry_reference` of the same transaction (F-032 uses it), the Nordea netbank export puts account numbers in `Maksaja`/`Maksunsaaja`, and a Nordea savings-account export repeated one line verbatim (same `Saldo`).
