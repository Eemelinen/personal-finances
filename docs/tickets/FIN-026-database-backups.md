# FIN-026: Automated database backups

**Milestone:** M5 Operations · **Status:** Todo · **Depends on:** FIN-002

## Description

Losing the database means losing history the banks no longer provide, often anything older than about 2 years. Back it up automatically.

## Acceptance criteria

- [ ] A nightly `pg_dump` (custom format) to a mounted host folder (`BACKUP_DIR`), e.g. as a `backup` service or a worker job
- [ ] Retention: 7 daily, 4 weekly, 12 monthly
- [ ] Backups encrypted (e.g. `age` with a public key), since they contain financial data
- [ ] `docs/operations.md` with backup and restore steps, and a restore tested once
