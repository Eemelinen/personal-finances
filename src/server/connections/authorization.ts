import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, lte } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import { getDb, type Db } from "@/server/db/client";
import {
  accounts,
  bankAuthorizations,
  connections,
  institutions,
} from "@/server/db/schema";
import { isProviderError } from "@/server/providers/errors";
import { getBankConnector } from "@/server/providers/registry";
import {
  BANK_PROVIDER_IDS,
  type BankConnectorProvider,
  type ProviderAccount,
  type ProviderAspsp,
  type ProviderAuthorizedSession,
  type ProviderBank,
} from "@/server/providers/types";
import { lockConnectionSync } from "@/server/sync/bank-sync";
import type { Tx } from "@/server/sync/runs";
import { matchRenewedAccounts } from "./account-matching";
import { reuseAccounts } from "./account-reuse";

// Connecting a bank (F-007). `startBankConnection()` stores a fresh random
// `state` (as its hash) and returns the bank's authorisation URL;
// `completeBankConnection()` runs on `/connections/callback`: it consumes the
// state (single-use, expiring), exchanges the code for a session and stores
// the connection, its encrypted session id, the institution and the
// accounts in one transaction. An account the app already holds as an
// archived or manual one with the same IBAN is attached to the new
// connection instead of added again (F-033, `account-reuse.ts`). The first
// sync is F-010's job.
//
// Renewing a connection (F-011) runs the same authorisation for the
// connection's bank, with the connection's id kept in the pending row: the
// callback then attaches the new session to that connection instead of
// adding one, and continues its accounts (matched by IBAN, then provider
// account id, `account-matching.ts`), so their ids and history stay. The
// old session is revoked afterwards, best effort, so a renewal before the
// expiry does not leave two consents running.

/** The banks the app connects (docs/plan.md → Scope). */
export const SUPPORTED_BANKS: readonly ProviderAspsp[] = [
  { name: "Nordea", country: "FI" },
  { name: "S-Pankki", country: "FI" },
];

/** How long a started authorisation can come back (the bank login). */
export const AUTHORIZATION_TTL_MS = 60 * 60 * 1000;

/**
 * Consent asked for when the provider does not say its maximum: the 180 days
 * both banks allow (FIN-001 → Findings).
 */
export const DEFAULT_CONSENT_SECONDS = 180 * 24 * 60 * 60;

/**
 * Taken off the bank's maximum, so a clock slightly ahead of the provider's
 * does not ask for more than it allows.
 */
export const CONSENT_MARGIN_SECONDS = 10 * 60;

/** Something the user can fix or retry; the message says what. */
export class BankConnectionError extends Error {
  override readonly name = "BankConnectionError";
}

export interface ConnectionOptions {
  db?: Db;
  connector?: BankConnectorProvider;
  now?: () => Date;
}

/** The longest consent `bank` grants, ending at `now` + its maximum. */
export function consentValidUntil(bank: ProviderBank, now: Date): Date {
  const seconds = bank.maximumConsentSeconds ?? DEFAULT_CONSENT_SECONDS;
  return new Date(
    now.getTime() + Math.max(seconds - CONSENT_MARGIN_SECONDS, 0) * 1000,
  );
}

export function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/**
 * Starts connecting `bankName` (one of `SUPPORTED_BANKS`): returns the URL
 * to send the user to. The state is 32 random bytes; only its hash is stored.
 */
export async function startBankConnection(
  bankName: string,
  options: ConnectionOptions = {},
): Promise<{ url: string }> {
  const supported = SUPPORTED_BANKS.find((bank) => bank.name === bankName);
  if (!supported) throw new BankConnectionError("Choose Nordea or S-Pankki.");
  return startAuthorization(supported, null, options);
}

/**
 * Starts renewing a bank connection's consent (F-011): the same bank login
 * as connecting, coming back to the same connection. Any connection but an
 * archived one can be renewed, also before its consent ends.
 */
export async function startConnectionRenewal(
  connectionId: string,
  options: ConnectionOptions = {},
): Promise<{ url: string }> {
  const db = options.db ?? getDb();
  const connector = options.connector ?? getBankConnector();
  const [connection] = await db
    .select({
      provider: connections.provider,
      status: connections.status,
      bank: institutions.providerRef,
      country: institutions.country,
    })
    .from(connections)
    .innerJoin(institutions, eq(institutions.id, connections.institutionId))
    .where(
      and(
        eq(connections.id, connectionId),
        inArray(connections.provider, [...BANK_PROVIDER_IDS]),
      ),
    );
  if (!connection) {
    throw new BankConnectionError("That connection no longer exists.");
  }
  if (connection.status === "archived") {
    throw new BankConnectionError(
      "An archived connection cannot be renewed; connect the bank again.",
    );
  }
  if (connection.provider !== connector.id || connection.bank === null) {
    throw new BankConnectionError(
      "This connection was made through another bank service, so it cannot be renewed here; connect the bank again.",
    );
  }
  return startAuthorization(
    { name: connection.bank, country: connection.country },
    connectionId,
    { ...options, db, connector },
  );
}

async function startAuthorization(
  aspsp: ProviderAspsp,
  connectionId: string | null,
  options: ConnectionOptions,
): Promise<{ url: string }> {
  const db = options.db ?? getDb();
  const connector = options.connector ?? getBankConnector();
  const now = (options.now ?? (() => new Date()))();

  const bank = (await connector.listBanks(aspsp.country)).find(
    (candidate) => candidate.name === aspsp.name,
  );
  if (!bank) {
    throw new BankConnectionError(
      `${aspsp.name} is not available through the bank service.`,
    );
  }

  const state = randomBytes(32).toString("base64url");
  await db
    .delete(bankAuthorizations)
    .where(lte(bankAuthorizations.expiresAt, now));
  const [row] = await db
    .insert(bankAuthorizations)
    .values({
      stateHash: hashState(state),
      provider: connector.id,
      aspspName: bank.name,
      aspspCountry: bank.country,
      connectionId,
      expiresAt: new Date(now.getTime() + AUTHORIZATION_TTL_MS),
    })
    .returning({ id: bankAuthorizations.id });

  try {
    const { url } = await connector.startAuthorization({
      aspsp: { name: bank.name, country: bank.country },
      state,
      validUntil: consentValidUntil(bank, now),
    });
    return { url };
  } catch (error) {
    await db
      .delete(bankAuthorizations)
      .where(eq(bankAuthorizations.id, row.id));
    throw error;
  }
}

/** The query of the bank's redirect to `/connections/callback`. */
export interface CallbackParams {
  state: string | null;
  code: string | null;
  /** Set instead of `code` when the authorisation did not finish. */
  error: string | null;
}

/**
 * Why a callback did not connect: the state is missing, unknown, used or
 * expired; the user cancelled at the bank; or the bank or provider failed.
 */
export type CallbackError = "invalid_state" | "cancelled" | "provider_error";

export type CallbackResult =
  | {
      ok: true;
      connectionId: string;
      accounts: number;
      /** The session was attached to an existing connection (F-011). */
      renewed: boolean;
    }
  | { ok: false; error: CallbackError };

/** `error` values that mean the user stopped at the bank. */
const CANCELLED_ERRORS = new Set(["access_denied", "cancelled", "canceled"]);

export interface CompleteOptions extends ConnectionOptions {
  /** Encrypts the session id; defaults to `encryptSecret()`. */
  encrypt?: (sessionRef: string) => string;
  /** Decrypts a renewed connection's old session id; defaults to `decryptSecret()`. */
  decrypt?: (sessionRef: string) => string;
}

function parseTimestamp(value: string): Date | null {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

export async function completeBankConnection(
  params: CallbackParams,
  options: CompleteOptions = {},
): Promise<CallbackResult> {
  const db = options.db ?? getDb();
  const connector = options.connector ?? getBankConnector();
  const now = (options.now ?? (() => new Date()))();
  const encrypt = options.encrypt ?? ((value) => encryptSecret(value));

  if (!params.state) return { ok: false, error: "invalid_state" };
  // Deleting is what makes the state single-use, even for two concurrent
  // callbacks: only one of them gets the row back.
  const [pending] = await db
    .delete(bankAuthorizations)
    .where(eq(bankAuthorizations.stateHash, hashState(params.state)))
    .returning();
  if (
    !pending ||
    pending.expiresAt.getTime() <= now.getTime() ||
    pending.provider !== connector.id
  ) {
    return { ok: false, error: "invalid_state" };
  }

  if (params.error) {
    if (CANCELLED_ERRORS.has(params.error.toLowerCase())) {
      return { ok: false, error: "cancelled" };
    }
    console.warn(
      `[connections] ${pending.aspspName} returned the authorisation error ${JSON.stringify(params.error.slice(0, 64))}`,
    );
    return { ok: false, error: "provider_error" };
  }
  if (!params.code) return { ok: false, error: "provider_error" };

  let session;
  try {
    session = await connector.completeAuthorization(params.code);
  } catch (error) {
    // The name only: it tells a spent code from an outage, without ids.
    console.warn(
      `[connections] completing the ${pending.aspspName} authorisation failed (${error instanceof Error ? error.name : "unknown"})`,
    );
    return { ok: false, error: "provider_error" };
  }

  if (pending.connectionId !== null) {
    return renewConnection(pending.connectionId, session, {
      ...options,
      db,
      connector,
      now: () => now,
      encrypt,
    });
  }

  const connectionId = await db.transaction(async (tx) => {
    const [institution] = await tx
      .insert(institutions)
      .values({
        name: session.aspsp.name,
        country: session.aspsp.country,
        provider: connector.id,
        providerRef: session.aspsp.name,
      })
      .onConflictDoUpdate({
        target: [institutions.provider, institutions.providerRef],
        set: { updatedAt: now },
      })
      .returning({ id: institutions.id });

    const [connection] = await tx
      .insert(connections)
      .values({
        institutionId: institution.id,
        provider: connector.id,
        sessionRef: encrypt(session.sessionRef),
        status: "active",
        consentExpiresAt: parseTimestamp(session.validUntil),
      })
      .returning({ id: connections.id });

    const fresh = (
      await reuseAccounts(tx, connection.id, institution.id, session.accounts)
    ).flatMap((match) => (match.existingId === null ? [match.account] : []));
    if (fresh.length > 0) {
      await tx.insert(accounts).values(
        fresh.map((account) => ({
          connectionId: connection.id,
          institutionId: institution.id,
          type: account.type,
          name: account.name,
          iban: account.iban,
          currency: account.currency,
          providerAccountRef: account.ref,
        })),
      );
    }
    return connection.id;
  });

  return {
    ok: true,
    connectionId,
    accounts: session.accounts.length,
    renewed: false,
  };
}

/**
 * Attaches a renewed session to its connection: the new session id and
 * consent end, status `active`, and the session's accounts matched to the
 * connection's (archived ones included, which come back); unmatched ones
 * take over an archived or manual account with their IBAN, or are added. Accounts the session no longer lists are left to the next
 * sync, which archives them. Waits for a running sync of the connection.
 */
async function renewConnection(
  connectionId: string,
  session: ProviderAuthorizedSession,
  options: CompleteOptions & {
    db: Db;
    connector: BankConnectorProvider;
    now: () => Date;
    encrypt: (sessionRef: string) => string;
  },
): Promise<CallbackResult> {
  const { db, connector, encrypt } = options;
  const now = options.now();

  const outcome = await db.transaction(async (tx) => {
    await lockConnectionSync(tx, connectionId);
    const [connection] = await tx
      .select({
        status: connections.status,
        sessionRef: connections.sessionRef,
        institutionId: connections.institutionId,
        bank: institutions.providerRef,
      })
      .from(connections)
      .innerJoin(institutions, eq(institutions.id, connections.institutionId))
      .where(eq(connections.id, connectionId))
      .for("update", { of: connections });
    if (
      !connection ||
      connection.status === "archived" ||
      connection.bank !== session.aspsp.name
    ) {
      return null;
    }

    await tx
      .update(connections)
      .set({
        sessionRef: encrypt(session.sessionRef),
        status: "active",
        consentExpiresAt: parseTimestamp(session.validUntil),
        updatedAt: now,
      })
      .where(eq(connections.id, connectionId));
    await attachAccounts(tx, connectionId, connection.institutionId, session);
    return { oldSessionRef: connection.sessionRef };
  });

  if (!outcome) {
    // Archived or removed while the user was at the bank (or the bank is
    // not the connection's): the new consent has no use.
    console.warn(
      `[connections] the ${session.aspsp.name} renewal no longer matches its connection`,
    );
    await revokeQuietly(connector, session.sessionRef, session.aspsp.name);
    return { ok: false, error: "invalid_state" };
  }

  if (outcome.oldSessionRef !== null) {
    const decrypt = options.decrypt ?? ((value) => decryptSecret(value));
    let oldSessionRef: string | null = null;
    try {
      oldSessionRef = decrypt(outcome.oldSessionRef);
    } catch {
      // Unreadable (another key): nothing to revoke with.
    }
    if (oldSessionRef !== null && oldSessionRef !== session.sessionRef) {
      await revokeQuietly(connector, oldSessionRef, session.aspsp.name);
    }
  }

  return {
    ok: true,
    connectionId,
    accounts: session.accounts.length,
    renewed: true,
  };
}

async function attachAccounts(
  tx: Tx,
  connectionId: string,
  institutionId: string,
  session: ProviderAuthorizedSession,
): Promise<void> {
  const stored = await tx
    .select({
      id: accounts.id,
      iban: accounts.iban,
      providerAccountRef: accounts.providerAccountRef,
    })
    .from(accounts)
    .where(eq(accounts.connectionId, connectionId));

  const unmatched: ProviderAccount[] = [];
  for (const match of matchRenewedAccounts(stored, session.accounts)) {
    const { account } = match;
    if (match.existingId !== null) {
      // Name and type stay the user's (D-024).
      await tx
        .update(accounts)
        .set({
          providerAccountRef: account.ref,
          iban: account.iban,
          currency: account.currency,
          archived: false,
        })
        .where(eq(accounts.id, match.existingId));
    } else {
      unmatched.push(account);
    }
  }
  for (const match of await reuseAccounts(
    tx,
    connectionId,
    institutionId,
    unmatched,
  )) {
    const { account } = match;
    if (match.existingId === null) {
      await tx.insert(accounts).values({
        connectionId,
        institutionId,
        type: account.type,
        name: account.name,
        iban: account.iban,
        currency: account.currency,
        providerAccountRef: account.ref,
      });
    }
  }
}

/**
 * Ends a session that is no longer needed; a session already gone is fine,
 * any other failure is only logged (the consent then runs out by itself).
 */
async function revokeQuietly(
  connector: BankConnectorProvider,
  sessionRef: string,
  bank: string,
): Promise<void> {
  try {
    await connector.revokeSession({ sessionRef });
  } catch (error) {
    if (isProviderError(error) && error.kind === "auth_expired") return;
    console.warn(
      `[connections] revoking an unused ${bank} session failed (${error instanceof Error ? error.name : "unknown"})`,
    );
  }
}
