import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Decrypter, Encrypter } from "age-encryption";
import {
  BACKUP_RETENTION,
  backupsToKeep,
  type RetentionPolicy,
} from "./retention";

// The nightly backup (F-024): `pg_dump --format=custom` of the whole
// database, streamed through age (the `age-encryption` package, the
// reference implementation's TypeScript port) into `BACKUP_DIR`, so the
// plaintext dump never touches the disk. A backup needs at least one age
// recipient: financial data is never written unencrypted. The file is
// written as `<name>.partial` and renamed when pg_dump has exited cleanly,
// so a failed run leaves no backup that looks complete. After a backup the
// old ones are pruned by `BACKUP_RETENTION`; files whose names are not
// backups' are never touched. Restore: docs/operations.md.

const BACKUP_PREFIX = "finances-";
const BACKUP_SUFFIX = ".dump.age";
const NAME_PATTERN =
  /^finances-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump\.age$/;

/** A web stream as a Node one (the DOM and `node:stream/web` types differ). */
function fromWeb(stream: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(stream as unknown as WebReadableStream<Uint8Array>);
}

/** How much of pg_dump's stderr an error keeps. */
const STDERR_LIMIT = 4096;

/** The command that writes the dump to its stdout. */
export interface DumpCommand {
  command: string;
  args: string[];
}

/** pg_dump of `databaseUrl` in the custom format, restorable with pg_restore. */
export function pgDumpCommand(databaseUrl: string): DumpCommand {
  return {
    command: "pg_dump",
    args: [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--dbname=${databaseUrl}`,
    ],
  };
}

/** `finances-20261024T013000Z.dump.age`, in UTC. */
export function backupFileName(takenAt: Date): string {
  const stamp = takenAt
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
  return `${BACKUP_PREFIX}${stamp}${BACKUP_SUFFIX}`;
}

/** When the backup was taken, or null if `name` is not a backup's. */
export function parseBackupFileName(name: string): Date | null {
  const match = NAME_PATTERN.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const takenAt = new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}Z`,
  );
  return Number.isNaN(takenAt.getTime()) ? null : takenAt;
}

export interface BackupOptions {
  dir: string;
  /** age public keys (`age1…`); at least one. */
  recipients: readonly string[];
  dump: DumpCommand;
  now?: () => Date;
}

export interface WrittenBackup {
  path: string;
  bytes: number;
}

/** Runs the dump, encrypts it to the recipients and writes it to `dir`. */
export async function writeBackup(
  options: BackupOptions,
): Promise<WrittenBackup> {
  if (options.recipients.length === 0) {
    throw new Error(
      "A backup needs at least one age recipient; backups are never written unencrypted",
    );
  }
  const encrypter = new Encrypter();
  for (const recipient of options.recipients) {
    encrypter.addRecipient(recipient);
  }

  await mkdir(options.dir, { recursive: true });
  const takenAt = (options.now ?? (() => new Date()))();
  const path = join(options.dir, backupFileName(takenAt));
  const partial = `${path}.partial`;

  const child = spawn(options.dump.command, options.dump.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; error?: Error }>(
    (resolve) => {
      child.once("error", (error) => resolve({ code: null, error }));
      child.once("close", (code) => resolve({ code }));
    },
  );

  try {
    const encrypted = await encrypter.encrypt(
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    await pipeline(
      fromWeb(encrypted),
      // Owner-only, and never over an existing file.
      createWriteStream(partial, { flags: "wx", mode: 0o600 }),
    );
    const { code, error } = await exited;
    if (error) throw error;
    if (code !== 0) {
      throw new Error(
        `${options.dump.command} exited with ${code}: ${stderr.trim()}`,
      );
    }
    await rename(partial, path);
  } catch (error) {
    child.kill();
    await rm(partial, { force: true });
    throw error;
  }
  return { path, bytes: (await stat(path)).size };
}

export interface StoredBackup {
  name: string;
  takenAt: Date;
}

/** The backups in `dir`, newest first; other files are left out. */
export async function listBackups(dir: string): Promise<StoredBackup[]> {
  const backups: StoredBackup[] = [];
  for (const name of await readdir(dir)) {
    const takenAt = parseBackupFileName(name);
    if (takenAt) backups.push({ name, takenAt });
  }
  return backups.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
}

/** Deletes the backups the policy does not keep; returns their names. */
export async function pruneBackups(
  dir: string,
  options: { timeZone: string; policy?: RetentionPolicy },
): Promise<string[]> {
  const backups = await listBackups(dir);
  const keep = backupsToKeep(
    backups,
    options.policy ?? BACKUP_RETENTION,
    options.timeZone,
  );
  const removed: string[] = [];
  for (const backup of backups) {
    if (keep.has(backup)) continue;
    await rm(join(dir, backup.name));
    removed.push(backup.name);
  }
  return removed;
}

/** The age identities (`AGE-SECRET-KEY-…`) of an age identity file. */
export function parseIdentities(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("AGE-SECRET-KEY-"));
}

/** The decrypted dump of the backup at `path`, for pg_restore. */
export async function decryptBackup(
  path: string,
  identities: readonly string[],
): Promise<Readable> {
  if (identities.length === 0) throw new Error("No age identity given");
  const decrypter = new Decrypter();
  for (const identity of identities) decrypter.addIdentity(identity);
  const decrypted = await decrypter.decrypt(
    Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
  );
  return fromWeb(decrypted);
}
