# Operations

Running the stack day to day: backups, restoring one, and the notifications the worker
sends (FIN-024). Starting the stack is in the [README](../README.md#quick-start); how the
pieces fit is in [architecture.md](architecture.md#backups-and-notifications).

## Backups

The worker's `backup` job runs every night at 03:30 (`APP_TIMEZONE`). It takes a
`pg_dump --format=custom` of the whole database, encrypts it with
[age](https://age-encryption.org) as it streams, and writes
`finances-<UTC time>.dump.age` (for example `finances-20261024T003000Z.dump.age`, mode
`0600`) to `BACKUP_DIR`. The plaintext dump never touches the disk. A failed dump leaves
no file behind and deletes nothing.

Backups contain every balance and transaction, so **they are always encrypted**: the
worker refuses to start with `BACKUP_DIR` but no `BACKUP_AGE_RECIPIENTS`, and the other
way round.

**Retention.** After each successful backup, old ones are deleted so that these are kept:
the newest backup of each of the last 7 days, of each of the last 4 weeks (Monday to
Sunday) and of each of the last 12 months. That is about a year of history in 20 or so
files. Only files named like a backup are ever deleted.

### Turning it on

1. Make a key pair on a machine you trust, not the server (`age-keygen` comes with the
   [age CLI](https://github.com/FiloSottile/age#installation), e.g. `brew install age` or
   `apt install age`):

   ```sh
   age-keygen -o finances-backup-key.txt
   # Public key: age1…
   ```

   Keep `finances-backup-key.txt` (the identity) **off the server**, e.g. in a password
   manager and on a USB stick. Without it no backup can be restored; with it anyone can
   read them.

2. Put the public key in `.env` (several keys, comma- or space-separated, can each
   decrypt):

   ```sh
   BACKUP_AGE_RECIPIENTS=age1…
   ```

3. `docker compose up -d worker`. With Compose, `BACKUP_DIR` is set to `/backups`, the
   `backups` volume, whenever `BACKUP_AGE_RECIPIENTS` is set. The worker logs
   `Worker started with … job(s): …, backup` and, each night,
   `[backup] wrote /backups/finances-….dump.age (… bytes), removed … old backup(s)`.

To take a backup now: `docker compose exec worker node_modules/.bin/tsx src/server/ops/run-backup.ts`.
Outside Docker, `pnpm backup` does the same with `BACKUP_DIR` and `BACKUP_AGE_RECIPIENTS`
from `.env`; it needs `pg_dump` 18 on the `PATH`.

### Copying backups off the machine

The `backups` volume is on the same disk as the database, so it protects against
mistakes and a broken database, not a lost disk. Copy the files elsewhere regularly. They
are encrypted, so any storage will do:

```sh
docker compose cp worker:/backups/. ./backups-copy/
ls backups-copy/
```

### Restoring

Restore into the Compose `db` service (for another server, run the same `dropdb`,
`createdb` and `pg_restore` against it). This **replaces** the current data.

1. Decrypt the backup on a machine that has the identity, with the age CLI or this
   repository's script (same result):

   ```sh
   age -d -i finances-backup-key.txt -o finances.dump finances-20261024T003000Z.dump.age
   # or
   pnpm --silent backup:decrypt finances-20261024T003000Z.dump.age finances-backup-key.txt > finances.dump
   ```

   `finances.dump` is your financial data in the clear: delete it when you are done.

2. Stop what writes to the database, recreate it empty, and restore:

   ```sh
   docker compose stop app worker
   docker compose exec db sh -c 'dropdb --force -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
   docker compose exec -T db sh -c 'pg_restore --no-owner --no-privileges --exit-on-error -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < finances.dump
   docker compose up -d   # migrate applies any migration newer than the backup
   rm finances.dump
   ```

   The migration history (`drizzle` schema) comes back with the data, so the `migrate`
   service applies only the migrations added after the backup was taken. This is what
   `tests/integration/backup-restore.int.test.ts` checks: a dump restored into an empty
   database has the same rows, and migrating it again changes nothing.

3. Open the app and check the dashboard and the latest transactions. `ENCRYPTION_KEY`
   must be the one in use when the backup was taken, or the stored bank sessions cannot
   be decrypted (reconnect the banks then).

Try a restore now and then, e.g. into a scratch database:

```sh
docker compose exec db createdb -U finances restore_test
docker compose exec -T db pg_restore --no-owner --exit-on-error -U finances -d restore_test < finances.dump
docker compose exec db psql -U finances -d restore_test -c 'select count(*) from transactions'
docker compose exec db dropdb -U finances restore_test
```

## Notifications

The worker can send push notifications through [ntfy](https://ntfy.sh) when something
needs you. Set `NTFY_URL` to a topic URL, either on the public server with a long random
topic name (anyone who knows the name can read the topic) or on your own ntfy server, and
subscribe to it in the ntfy app. `NTFY_TOKEN` is an access token for a protected topic.
Without `NTFY_URL` nothing is sent and the job does not run.

The `notifications` job runs at half past every hour from 08:30 to 22:30
(`APP_TIMEZONE`), so nothing arrives at night. It notifies about:

| Issue           | When                                                                                       | Priority |
| --------------- | ------------------------------------------------------------------------------------------ | -------- |
| Sync failing    | The last `NOTIFY_FAILED_SYNCS` (default 3) syncs of an active connection failed            | high     |
| Consent ending  | A bank connection's consent ends within 7 days (the banner on every page warns at 14 days) | default  |
| Consent expired | A bank connection's consent has ended, or the bank no longer accepts it                    | high     |

Each issue is sent **at most once a day** (per connection, by calendar day in
`APP_TIMEZONE`), and again the next day while it lasts: renew the connection on
Connections, or check the sync log there. A message that could not be sent is retried on
the next run. Messages name the bank and the problem, never amounts or account details.
The worker logs `[notifications] sent …` for each message and `… not sent: …` for a
failure.

To test the setup, publish to the topic yourself:
`curl -d "test" "$NTFY_URL"`.
