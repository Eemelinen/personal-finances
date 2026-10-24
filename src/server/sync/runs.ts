import { and, eq } from "drizzle-orm";
import { decryptSecret } from "@/server/crypto";
import type { Db } from "@/server/db/client";
import { connections, syncRuns } from "@/server/db/schema";
import {
  ProviderAuthError,
  ProviderRateLimitError,
  type ProviderError,
  type ProviderErrorKind,
} from "@/server/providers/errors";
import {
  getProviderRegistry,
  type ProviderRegistry,
} from "@/server/providers/registry";
import type {
  FinancialProvider,
  ProviderConnection,
} from "@/server/providers/types";

// The `sync_runs` bookkeeping every sync of a connection shares (D-009): the
// run row is inserted first, outside any data transaction, so a failure is
// recorded even when the data changes roll back. Provider failures are
// results; an auth failure also marks the connection `expired`. Anything
// else fails the run and is rethrown by the caller.

export type Connection = typeof connections.$inferSelect;
export type ConnectionStatus = Connection["status"];
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type SyncRunKind = NonNullable<(typeof syncRuns.$inferSelect)["kind"]>;

/**
 * Why a failed run failed: the provider error's kind, or `not_active` when
 * the connection is not `active` and the provider was not called.
 */
export type SyncErrorKind = ProviderErrorKind | "not_active";

export class ConnectionNotFoundError extends Error {
  override readonly name = "ConnectionNotFoundError";

  constructor(readonly connectionId: string) {
    super(`No connection ${JSON.stringify(connectionId)}`);
  }
}

export interface SyncOptions {
  db?: Db;
  providers?: ProviderRegistry;
  /** Decrypts `connections.session_ref`; defaults to `decryptSecret()`. */
  decrypt?: (sessionRef: string) => string;
  /** The clock for `started_at`, `finished_at` and `last_synced_at`. */
  now?: () => Date;
}

/** What a failed run reports besides its counts. */
export interface SyncFailure {
  status: "failed";
  /** The connection's status after the sync. */
  connectionStatus: ConnectionStatus;
  error: string;
  errorKind: SyncErrorKind;
  /** When rate limited: how long the provider asked to wait, if it said. */
  retryAfterMs: number | null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Loads the connection and inserts its `running` run. */
export async function startRun(
  db: Db,
  connectionId: string,
  kind: SyncRunKind,
  now: () => Date,
): Promise<{ connection: Connection; runId: string }> {
  const [connection] = await db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId));
  if (!connection) throw new ConnectionNotFoundError(connectionId);

  const [run] = await db
    .insert(syncRuns)
    .values({ connectionId, kind, startedAt: now() })
    .returning({ id: syncRuns.id });
  return { connection, runId: run.id };
}

export async function finishRun(
  db: Db | Tx,
  runId: string,
  finishedAt: Date,
  values: Partial<typeof syncRuns.$inferInsert>,
): Promise<void> {
  await db
    .update(syncRuns)
    .set({ ...values, finishedAt })
    .where(eq(syncRuns.id, runId));
}

/** A non-`active` connection is not synced, but the attempt is logged. */
export async function failNotActive(
  db: Db,
  runId: string,
  connection: Connection,
  now: () => Date,
): Promise<SyncFailure> {
  const error = `The connection is ${connection.status}`;
  await finishRun(db, runId, now(), { status: "failed", error });
  return {
    status: "failed",
    connectionStatus: connection.status,
    error,
    errorKind: "not_active",
    retryAfterMs: null,
  };
}

/**
 * The provider and the decrypted session of an `active` connection; a
 * connection without a session rejects with `ProviderAuthError`.
 */
export function openConnection(
  connection: Connection,
  options: SyncOptions,
): { provider: FinancialProvider; session: ProviderConnection } {
  const providers = options.providers ?? getProviderRegistry();
  const provider = providers.get(connection.provider);
  const decrypt = options.decrypt ?? ((value) => decryptSecret(value));
  if (connection.sessionRef === null) {
    throw new ProviderAuthError(
      provider.id,
      "The connection has no provider session",
    );
  }
  return { provider, session: { sessionRef: decrypt(connection.sessionRef) } };
}

/**
 * Fails the run with a provider error (plus whatever counts it got to) and,
 * for an auth failure, marks the connection `expired`.
 */
export async function recordProviderFailure(
  db: Db,
  runId: string,
  connectionId: string,
  error: ProviderError,
  now: () => Date,
  counts: Partial<typeof syncRuns.$inferInsert> = {},
): Promise<SyncFailure> {
  const expired = error.kind === "auth_expired";
  const connectionStatus = await db.transaction(async (tx) => {
    await finishRun(tx, runId, now(), {
      ...counts,
      status: "failed",
      error: errorMessage(error),
    });
    if (!expired) return "active" as const;
    await tx
      .update(connections)
      .set({ status: "expired" })
      .where(eq(connections.id, connectionId));
    return "expired" as const;
  });
  return {
    status: "failed",
    connectionStatus,
    error: errorMessage(error),
    errorKind: error.kind,
    retryAfterMs:
      error instanceof ProviderRateLimitError ? error.retryAfterMs : null,
  };
}

/**
 * A bug or a database failure: keep the run from staying `running`, with
 * the counts of whatever was already committed.
 */
export async function failRunOnBug(
  db: Db,
  runId: string,
  error: unknown,
  now: () => Date,
  counts: Partial<typeof syncRuns.$inferInsert> = {},
): Promise<void> {
  await db
    .update(syncRuns)
    .set({
      ...counts,
      status: "failed",
      finishedAt: now(),
      error: errorMessage(error),
    })
    .where(and(eq(syncRuns.id, runId), eq(syncRuns.status, "running")));
}
