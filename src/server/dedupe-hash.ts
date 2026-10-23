import { createHash } from "node:crypto";

/** The fields that identify a transaction when the provider has no stable id. */
export interface DedupeInput {
  /** `YYYY-MM-DD`, an ISO timestamp (its calendar date is used) or Finnish `d.m.yyyy`. */
  bookingDate: string;
  /** Signed integer minor units. */
  amountMinor: number | bigint;
  counterparty?: string | null;
  description?: string | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;
const FINNISH_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

/** Normalises a booking date to `YYYY-MM-DD`; throws on anything else. */
export function normaliseDate(value: string): string {
  const trimmed = value.trim();
  const iso = ISO_DATE.exec(trimmed);
  const finnish = iso ? null : FINNISH_DATE.exec(trimmed);
  const [year, month, day] = iso
    ? [iso[1], iso[2], iso[3]]
    : finnish
      ? [finnish[3], finnish[2].padStart(2, "0"), finnish[1].padStart(2, "0")]
      : [];
  if (!year || !month || !day) {
    throw new Error(`Unrecognised booking date: ${JSON.stringify(value)}`);
  }

  const normalised = `${year}-${month}-${day}`;
  const parsed = new Date(`${normalised}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalised
  ) {
    throw new Error(`Invalid booking date: ${JSON.stringify(value)}`);
  }
  return normalised;
}

/** Integer minor units as a canonical decimal string (`-0` becomes `0`). */
export function normaliseAmount(value: number | bigint): string {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Amount must be integer minor units, got ${value}`);
  }
  return BigInt(value).toString();
}

/** NFKC-normalised, lower-cased text with control characters and runs of whitespace as one space, trimmed. */
export function normaliseText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * Stable fallback identity of a transaction within one account: a SHA-256 hex
 * digest of its normalised booking date, amount, counterparty and description.
 * The same transaction from a re-sync or an overlapping CSV import hashes the
 * same, so `transactions (account_id, dedupe_hash)` rejects the duplicate.
 */
export function dedupeHash(input: DedupeInput): string {
  const parts = [
    normaliseDate(input.bookingDate),
    normaliseAmount(input.amountMinor),
    normaliseText(input.counterparty),
    normaliseText(input.description),
  ];
  // Normalised text has no control characters, so the unit separator keeps
  // the fields apart.
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}
