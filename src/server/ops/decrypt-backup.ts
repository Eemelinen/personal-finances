import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { decryptBackup, parseIdentities } from "./backup";

// `pnpm --silent backup:decrypt <backup> <identity file> > finances.dump`:
// writes the decrypted pg_dump of a backup to stdout, for pg_restore
// (docs/operations.md). The same as `age -d -i <identity file> <backup>`,
// for a machine without the age CLI.

const [backupPath, identityPath] = process.argv.slice(2);
if (!backupPath || !identityPath) {
  console.error("Usage: pnpm --silent backup:decrypt <backup> <identity file>");
  process.exit(1);
}
if (process.stdout.isTTY) {
  console.error("Redirect the output to a file or pipe it to pg_restore.");
  process.exit(1);
}
const identities = parseIdentities(await readFile(identityPath, "utf8"));
await pipeline(await decryptBackup(backupPath, identities), process.stdout);
