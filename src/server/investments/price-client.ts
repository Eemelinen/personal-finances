import { parseRetryAfter } from "@/server/providers/errors";
import type { CurrencyCode, IsoDate } from "@/server/providers/types";
import { formatDecimal, parseDecimal } from "./decimal";

// Closing prices from Twelve Data's `/eod` endpoint (F-020, D-017), behind a
// client that keeps to the free Basic plan: 8 requests a minute (it waits)
// and 800 a day (it stops). Twelve Data reports errors as JSON with a
// `code`, often with HTTP 200, so the body decides. `fetch`, the clock and
// sleeping are injectable; tests never reach the real API.

export const TWELVE_DATA_SOURCE = "twelve_data";
const TWELVE_DATA_URL = "https://api.twelvedata.com/eod";

/** Twelve Data's free Basic plan. */
export const FREE_TIER = { perMinute: 8, perDay: 800 } as const;

const MINUTE_MS = 60_000;

export interface PriceQuery {
  symbol: string;
  isin: string | null;
  /** The asset's quote currency; a price in another currency is rejected. */
  currency: CurrencyCode;
}

export interface ClosingPrice {
  /** The trading day of the close. */
  date: IsoDate;
  /** Closing price of one unit in major units, a decimal string. */
  close: string;
  currency: CurrencyCode;
}

export type PriceApiErrorKind =
  "rate_limited" | "daily_limit" | "auth" | "unavailable" | "invalid_response";

/** The API cannot be used right now; the update stops and retries tomorrow. */
export class PriceApiError extends Error {
  override readonly name = "PriceApiError";

  constructor(
    readonly kind: PriceApiErrorKind,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export interface PriceClient {
  /** The latest close, or null when the API does not know the symbol. */
  getClosingPrice(query: PriceQuery): Promise<ClosingPrice | null>;
}

export interface TwelveDataOptions {
  apiKey: string;
  fetch?: typeof fetch;
  perMinute?: number;
  perDay?: number;
  /** Milliseconds since the epoch; defaults to the clock. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The exchange (ISO 10383 MIC) of a Nordic listing from the ISIN's country,
 * so `NOKIA` means Helsinki and not New York; null lets the API choose.
 */
export function micForIsin(isin: string | null): string | null {
  const country = isin?.slice(0, 2);
  switch (country) {
    case "FI":
      return "XHEL";
    case "SE":
      return "XSTO";
    case "DK":
      return "XCSE";
    case "NO":
      return "XOSL";
    default:
      return null;
  }
}

/**
 * Admits at most `perMinute` calls in any 60 s (waiting for a slot) and
 * `perDay` per UTC day (throwing `daily_limit` beyond).
 */
export function createRateLimiter(options: {
  perMinute: number;
  perDay: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): () => Promise<void> {
  const recent: number[] = [];
  let day = "";
  let today = 0;
  return async () => {
    let now = options.now();
    while (recent.length > 0 && recent[0] <= now - MINUTE_MS) recent.shift();
    if (recent.length >= options.perMinute) {
      await options.sleep(recent[0] + MINUTE_MS - now);
      now = options.now();
      while (recent.length > 0 && recent[0] <= now - MINUTE_MS) recent.shift();
    }
    const currentDay = new Date(now).toISOString().slice(0, 10);
    if (currentDay !== day) {
      day = currentDay;
      today = 0;
    }
    if (today >= options.perDay) {
      throw new PriceApiError(
        "daily_limit",
        `The daily limit of ${options.perDay} price requests is used up`,
      );
    }
    today++;
    recent.push(now);
  };
}

interface TwelveDataEod {
  symbol?: string;
  currency?: string;
  datetime?: string;
  close?: string;
  code?: number;
  message?: string;
  status?: string;
}

function errorFor(code: number, message: string, retryAfterMs: number | null) {
  if (code === 429)
    return new PriceApiError("rate_limited", message, retryAfterMs);
  if (code === 401 || code === 403) return new PriceApiError("auth", message);
  if (code === 408 || code >= 500)
    return new PriceApiError("unavailable", message);
  return new PriceApiError("invalid_response", message);
}

export function createTwelveDataClient(
  options: TwelveDataOptions,
): PriceClient {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const limit = createRateLimiter({
    perMinute: options.perMinute ?? FREE_TIER.perMinute,
    perDay: options.perDay ?? FREE_TIER.perDay,
    now,
    sleep:
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  });

  return {
    async getClosingPrice(query) {
      await limit();
      const url = new URL(TWELVE_DATA_URL);
      url.searchParams.set("symbol", query.symbol);
      const mic = micForIsin(query.isin);
      if (mic) url.searchParams.set("mic_code", mic);
      let response: Response;
      try {
        response = await fetchFn(url, {
          headers: { Authorization: `apikey ${options.apiKey}` },
        });
      } catch (error) {
        throw new PriceApiError(
          "unavailable",
          `Twelve Data is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const retryAfterMs = parseRetryAfter(
        response.headers.get("retry-after"),
        new Date(now()),
      );
      let body: TwelveDataEod;
      try {
        body = (await response.json()) as TwelveDataEod;
      } catch {
        throw errorFor(
          response.ok ? 0 : response.status,
          `Twelve Data responded with HTTP ${response.status} and no JSON`,
          retryAfterMs,
        );
      }
      const code =
        body.status === "error"
          ? (body.code ?? 0)
          : response.ok
            ? 0
            : response.status;
      if (
        code === 404 ||
        (code === 400 && /symbol/i.test(body.message ?? ""))
      ) {
        return null;
      }
      if (code !== 0) {
        throw errorFor(
          code,
          `Twelve Data error ${code}: ${body.message ?? "no message"}`,
          retryAfterMs,
        );
      }
      const date = body.datetime?.slice(0, 10) ?? "";
      const currency = body.currency?.toUpperCase() ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Z]{3}$/.test(currency)) {
        throw new PriceApiError(
          "invalid_response",
          `Twelve Data returned no date or currency for ${query.symbol}`,
        );
      }
      let close: string;
      try {
        close = formatDecimal(parseDecimal(body.close ?? ""));
      } catch {
        throw new PriceApiError(
          "invalid_response",
          `Twelve Data returned no close for ${query.symbol}: ${JSON.stringify(body.close)}`,
        );
      }
      if (close.startsWith("-")) {
        throw new PriceApiError(
          "invalid_response",
          `Twelve Data returned a negative close for ${query.symbol}`,
        );
      }
      if (currency !== query.currency) {
        // Another listing than the one the asset is quoted on.
        return null;
      }
      return { date, close, currency };
    },
  };
}
