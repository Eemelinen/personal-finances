import type { ProviderId } from "./types";

// The failures the sync layer reacts to. Everything else a provider throws is
// treated as a bug and surfaces as is.

export type ProviderErrorKind = "auth_expired" | "rate_limited" | "unavailable";

interface ProviderErrorOptions {
  cause?: unknown;
}

export abstract class ProviderError extends Error {
  abstract readonly kind: ProviderErrorKind;

  constructor(
    readonly providerId: ProviderId,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
  }
}

/** The session or consent expired or was revoked: the user must reconnect. */
export class ProviderAuthError extends ProviderError {
  readonly kind = "auth_expired";
  override readonly name = "ProviderAuthError";
}

/** Too many requests: retry after `retryAfterMs` when the provider said so. */
export class ProviderRateLimitError extends ProviderError {
  readonly kind = "rate_limited";
  override readonly name = "ProviderRateLimitError";
  readonly retryAfterMs: number | null;

  constructor(
    providerId: ProviderId,
    message: string,
    options: ProviderErrorOptions & { retryAfterMs?: number | null } = {},
  ) {
    super(providerId, message, options);
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** The provider or the bank behind it is down or unreachable: retry later. */
export class ProviderUnavailableError extends ProviderError {
  readonly kind = "unavailable";
  override readonly name = "ProviderUnavailableError";
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/**
 * Parses a `Retry-After` header (delay in seconds or an HTTP date) into
 * milliseconds from `now`; null when absent or unparsable.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: Date = new Date(),
): number | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now.getTime());
}

/**
 * Maps an HTTP error status from a provider API to the typed error, or
 * undefined when the status is not one the sync layer handles (a 400 or 404
 * means the request was wrong, which is a bug, not a provider state).
 */
export function providerErrorFromStatus(
  providerId: ProviderId,
  status: number,
  options: { retryAfter?: string | null; now?: Date; cause?: unknown } = {},
): ProviderError | undefined {
  const message = `${providerId} responded with HTTP ${status}`;
  const { cause } = options;
  if (status === 401 || status === 403) {
    return new ProviderAuthError(providerId, message, { cause });
  }
  if (status === 429) {
    return new ProviderRateLimitError(providerId, message, {
      cause,
      retryAfterMs: parseRetryAfter(options.retryAfter, options.now),
    });
  }
  if (status === 408 || (status >= 500 && status <= 599)) {
    return new ProviderUnavailableError(providerId, message, { cause });
  }
  return undefined;
}
