import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/server/db/client";
import { applyMigrations } from "@/server/db/migrations";
import {
  accounts,
  balanceSnapshots,
  connections,
  institutions,
  transactions,
} from "@/server/db/schema";
import {
  decryptBackup,
  listBackups,
  parseIdentities,
  pgDumpCommand,
  pruneBackups,
  writeBackup,
  type DumpCommand,
} from "@/server/ops/backup";
import {
  POSTGRES_IMAGE,
  startTestDatabase,
  type TestDatabase,
} from "./helpers/postgres";

// The nightly backup (F-024) against real Postgres 18: the app's pg_dump
// command, run inside the source container (the host need not have
// pg_dump), streamed through age into BACKUP_DIR; the file is encrypted,
// and decrypting it into pg_restore fills a fresh database with the same
// rows, migration history included.

const NOW = new Date("2026-10-24T00:30:00.000Z");
/** Strings that must not appear in the encrypted file. */
const MARKERS = ["Kahvila Äänekoski", "FI2112345600000785"];

let source: TestDatabase;
let target: StartedPostgreSqlContainer;
let targetDb: Db;
let dir: string;
let identity: string;
let recipient: string;

/** The connection URL of `container` as seen from inside it. */
function insideUrl(container: StartedPostgreSqlContainer): string {
  return `postgres://${container.getUsername()}:${container.getPassword()}@localhost:5432/${container.getDatabase()}`;
}

/** The app's pg_dump command, run in `container` through `docker exec`. */
function dumpIn(container: StartedPostgreSqlContainer): DumpCommand {
  const { command, args } = pgDumpCommand(insideUrl(container));
  return {
    command: "docker",
    args: ["exec", container.getId(), command, ...args],
  };
}

/** Pipes `input` into pg_restore in `container`. */
async function restoreInto(
  container: StartedPostgreSqlContainer,
  input: Readable,
): Promise<void> {
  const child = spawn(
    "docker",
    [
      "exec",
      "-i",
      container.getId(),
      "pg_restore",
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      `--dbname=${insideUrl(container)}`,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  input.pipe(child.stdin);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(`pg_restore exited with ${code}: ${stderr}`);
}

/** Every table of `schema`, with a digest of its rows. */
async function tableDigests(
  db: Db,
  schema: string,
): Promise<Record<string, { rows: number; digest: string | null }>> {
  const tables = await db.execute<{ name: string }>(
    sql`select table_name as name from information_schema.tables where table_schema = ${schema} and table_type = 'BASE TABLE' order by 1`,
  );
  const digests: Record<string, { rows: number; digest: string | null }> = {};
  for (const { name } of tables) {
    const table = sql.identifier(name);
    const [row] = await db.execute<{ rows: number; digest: string | null }>(
      sql`select count(*)::int as rows, md5(string_agg(t::text, '|' order by t::text)) as digest from ${sql.identifier(schema)}.${table} t`,
    );
    digests[name] = row;
  }
  return digests;
}

async function seed(db: Db): Promise<void> {
  const [institution] = await db
    .insert(institutions)
    .values({
      name: "Nordea",
      country: "FI",
      provider: "fake",
      providerRef: "Nordea",
    })
    .returning();
  const [connection] = await db
    .insert(connections)
    .values({
      institutionId: institution.id,
      provider: "fake",
      sessionRef: "v1:encrypted-session",
      consentExpiresAt: new Date("2027-04-22T00:00:00Z"),
    })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({
      connectionId: connection.id,
      institutionId: institution.id,
      type: "checking",
      name: "Käyttötili",
      iban: MARKERS[1],
      currency: "EUR",
      providerAccountRef: "acc-1",
    })
    .returning();
  await db.insert(balanceSnapshots).values(
    ["2026-10-22", "2026-10-23", "2026-10-24"].map((date, i) => ({
      accountId: account.id,
      date,
      amountMinor: 123_456 + i * 1_000,
      currency: "EUR",
      balanceType: "CLBD",
    })),
  );
  await db.insert(transactions).values(
    [-450, -12_990, 250_000].map((amountMinor, i) => ({
      accountId: account.id,
      providerTxnRef: `txn-${i}`,
      dedupeHash: `hash-${i}`,
      bookingDate: `2026-10-2${i}`,
      amountMinor,
      currency: "EUR",
      counterparty: i === 0 ? MARKERS[0] : "Palkka Oy",
      description: "Synthetic",
    })),
  );
}

beforeAll(async () => {
  [source, target] = await Promise.all([
    startTestDatabase(),
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
  ]);
  targetDb = createDb(target.getConnectionUri(), { max: 2 });
  await seed(source.db);
  dir = await mkdtemp(join(tmpdir(), "finances-backup-"));
  identity = await generateIdentity();
  recipient = await identityToRecipient(identity);
});

afterAll(async () => {
  await targetDb?.$client.end();
  await Promise.all([source?.stop(), target?.stop()]);
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("backup and restore", () => {
  it("writes an age-encrypted dump that restores into a fresh database with the same rows", async () => {
    const backup = await writeBackup({
      dir,
      recipients: [recipient],
      dump: dumpIn(source.container),
      now: () => NOW,
    });

    expect(backup.path).toBe(join(dir, "finances-20261024T003000Z.dump.age"));
    expect(await readdir(dir)).toEqual(["finances-20261024T003000Z.dump.age"]);
    const info = await stat(backup.path);
    expect(info.size).toBe(backup.bytes);
    expect(info.mode & 0o777).toBe(0o600);
    // Encrypted: an age header, and none of the data in the clear.
    const bytes = await readFile(backup.path);
    expect(bytes.subarray(0, 22).toString()).toBe("age-encryption.org/v1\n");
    for (const marker of MARKERS) {
      expect(bytes.includes(Buffer.from(marker))).toBe(false);
    }
    expect(bytes.includes(Buffer.from("PGDMP"))).toBe(false);

    // The identity file, as age-keygen writes it.
    const identityFile = join(dir, "..", `${Date.now()}-identity.txt`);
    await writeFile(
      identityFile,
      `# created: 2026-10-24T00:00:00Z\n# public key: ${recipient}\n${identity}\n`,
    );
    const identities = parseIdentities(await readFile(identityFile, "utf8"));
    await rm(identityFile);
    expect(identities).toEqual([identity]);

    await restoreInto(target, await decryptBackup(backup.path, identities));

    const before = await tableDigests(source.db, "public");
    expect(before.transactions.rows).toBe(3);
    expect(before.balance_snapshots.rows).toBe(3);
    expect(await tableDigests(targetDb, "public")).toEqual(before);
    expect(await tableDigests(targetDb, "drizzle")).toEqual(
      await tableDigests(source.db, "drizzle"),
    );
    const restored = await targetDb
      .select({ counterparty: transactions.counterparty })
      .from(transactions)
      .orderBy(transactions.bookingDate);
    expect(restored[0].counterparty).toBe(MARKERS[0]);
    // The restored migration history is current: migrating is a no-op.
    await applyMigrations(targetDb);
    expect(await tableDigests(targetDb, "public")).toEqual(before);
  });

  it("does not decrypt with another identity", async () => {
    const [backup] = await listBackups(dir);
    const other = await generateIdentity();
    await expect(
      decryptBackup(join(dir, backup.name), [other]),
    ).rejects.toThrow();
  });

  it("leaves no file behind when the dump fails", async () => {
    const before = await readdir(dir);
    const failing: DumpCommand = {
      command: "docker",
      args: [
        "exec",
        source.container.getId(),
        "pg_dump",
        "--format=custom",
        `--dbname=postgres://${source.container.getUsername()}:${source.container.getPassword()}@localhost:5432/no_such_database`,
      ],
    };
    await expect(
      writeBackup({
        dir,
        recipients: [recipient],
        dump: failing,
        now: () => new Date("2026-10-25T00:30:00Z"),
      }),
    ).rejects.toThrow(/exited with 1: .*no_such_database/);
    expect(await readdir(dir)).toEqual(before);
  });

  it("never writes a backup without a recipient", async () => {
    await expect(
      writeBackup({ dir, recipients: [], dump: dumpIn(source.container) }),
    ).rejects.toThrow(/never written unencrypted/);
  });

  it("prunes old backups by the retention policy and leaves other files alone", async () => {
    const pruneDir = await mkdtemp(join(tmpdir(), "finances-prune-"));
    try {
      // Nightly backups for 40 days up to 2026-10-24, plus a stray file.
      const names: string[] = [];
      for (let i = 0; i < 40; i++) {
        const day = new Date(NOW.getTime() - i * 86_400_000);
        const stamp = day.toISOString().slice(0, 10).replace(/-/g, "");
        names.push(`finances-${stamp}T003000Z.dump.age`);
      }
      for (const name of [...names, "README.txt"]) {
        await writeFile(join(pruneDir, name), "x");
      }

      const removed = await pruneBackups(pruneDir, {
        timeZone: "Europe/Helsinki",
      });
      const left = (await readdir(pruneDir)).sort();
      expect(removed.length + left.length).toBe(41);
      expect(left).toEqual(
        [
          "README.txt",
          // Monthly (Sep, Oct's newest is today's).
          "finances-20260930T003000Z.dump.age",
          // Weekly: the Sundays before this week.
          "finances-20261004T003000Z.dump.age",
          "finances-20261011T003000Z.dump.age",
          // Daily.
          ...[18, 19, 20, 21, 22, 23, 24].map(
            (d) => `finances-202610${d}T003000Z.dump.age`,
          ),
        ].sort(),
      );
    } finally {
      await rm(pruneDir, { recursive: true, force: true });
    }
  });
});
