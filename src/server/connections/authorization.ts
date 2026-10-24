import { createHash, randomBytes } from "node:crypto";
import { eq, lte } from "drizzle-orm";
import { encryptSecret } from "@/server/crypto";
import { getDb, type Db } from "@/server/db/client";
import {
  accounts,
  bankAuthorizations,
  connections,
  institutions,
} from "@/server/db/schema";
import { getBankConnector } from "@/server/providers/registry";
import type {
  BankConnectorProvider,
  ProviderAspsp,
  ProviderBank,
} from "@/server/providers/types";

// Connecting a bank (F-007). `startBankConnection()` stores a fresh random
// `state` (as its hash) and returns the bank's authorisation URL;
// `completeBankConnection()` runs on `/connections/callback`: it consumes the
// state (single-use, expiring), exchanges the code for a session and stores
// the connection, its encrypted session id, the institution and the
// accounts in one transaction. The first sync is F-010's job.

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
  const db = options.db ?? getDb();
  const connector = options.connector ?? getBankConnector();
  const now = (options.now ?? (() => new Date()))();

  const supported = SUPPORTED_BANKS.find((bank) => bank.name === bankName);
  if (!supported) throw new BankConnectionError("Choose Nordea or S-Pankki.");
  const bank = (await connector.listBanks(supported.country)).find(
    (candidate) => candidate.name === supported.name,
  );
  if (!bank) {
    throw new BankConnectionError(
      `${supported.name} is not available through the bank service.`,
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
  | { ok: true; connectionId: string; accounts: number }
  | { ok: false; error: CallbackError };

/** `error` values that mean the user stopped at the bank. */
const CANCELLED_ERRORS = new Set(["access_denied", "cancelled", "canceled"]);

export interface CompleteOptions extends ConnectionOptions {
  /** Encrypts the session id; defaults to `encryptSecret()`. */
  encrypt?: (sessionRef: string) => string;
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

    if (session.accounts.length > 0) {
      await tx.insert(accounts).values(
        session.accounts.map((account) => ({
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

  return { ok: true, connectionId, accounts: session.accounts.length };
}
