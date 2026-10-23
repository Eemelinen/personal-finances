# FIN-024: Backups and notifications

**Feature:** F-024 · **Milestone:** M5 Operations · **Area:** ops · **Depends on:** [F-010](FIN-010-scheduled-sync.md), [F-011](FIN-011-consent-expiry-and-renewal.md) · **Runs:** unattended

> Status, verification commands and evidence live in [feature_list.json](../../feature_list.json): `pnpm harness:feature show F-024`. This ticket is the spec the session reads first.

## Goal

A nightly job writes an encrypted `pg_dump` (age) to `BACKUP_DIR` with 7 daily, 4 weekly and 12 monthly backups kept, and `docs/operations.md` documents backup and restore. A notifier (ntfy; disabled when `NTFY_URL` is unset) sends at most one message per issue per day when a connection fails N syncs in a row, when a consent expires within 7 days and when it has expired.

## Acceptance criteria

- Backups contain financial data, so they are always encrypted

## Tests (what the verification proves)

- **L1** `tests/unit/ops/retention.test.ts`: which backups are kept
- **L1** `tests/unit/ops/notifier.test.ts`: one message per issue per day; disabled without config
- **L2** `tests/integration/backup-restore.int.test.ts`: a dump of a Testcontainers database restores into a fresh one with the same rows

## Notes

- Replaces old FIN-026 and FIN-027.
