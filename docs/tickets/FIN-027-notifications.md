# FIN-027: Notifications for failed syncs & expiring consent

**Milestone:** M5 Operations · **Status:** Todo · **Depends on:** FIN-010, FIN-011

## Description

Get notified without opening the app when something needs attention.

## Acceptance criteria

- [ ] Notifier abstraction with an **ntfy** implementation (push to phone). Email is optional.
- [ ] Notify when: a sync has failed N times in a row, a consent expires within 7 days, a consent has expired
- [ ] No more than one notification per issue per day
- [ ] Optional weekly summary: spending this week vs average, plus the balance change
- [ ] Config via env (`NTFY_URL`, `NTFY_TOPIC`). Disabled when not set.
