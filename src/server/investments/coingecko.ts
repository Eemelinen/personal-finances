import { localDate } from "@/server/dates";
import type { CurrencyCode, IsoDate } from "@/server/providers/types";
import { DECIMAL_SCALE, formatDecimal, parseDecimal } from "./decimal";
import { createRateLimiter, PriceApiError } from "./price-client";

// Crypto prices from CoinGecko's `/simple/price` (F-021, D-018): one request
// for up to `IDS_PER_REQUEST` coins in one currency. The public API works
// without a key (a few requests a minute); `COINGECKO_API_KEY`, a free demo
// key, raises the limit. The client keeps to 5 requests a minute itself.
// `fetch`, the clock and sleeping are injectable; tests never reach the API.

export const COINGECKO_SOURCE = "coingecko";
const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price";
const IDS_PER_REQUEST = 50;
const PER_MINUTE = 5;
const PER_DAY = 500;

export interface CoinPrice {
  /** The day of CoinGecko's last update, in the app's time zone. */
  date: IsoDate;
  /** Price of one coin in major units, a decimal string. */
  price: string;
  currency: CurrencyCode;
}

export interface CryptoPriceClient {
  /** Prices by CoinGecko id; ids CoinGecko does not know are absent. */
  getPrices(
    ids: readonly string[],
    currency: CurrencyCode,
  ): Promise<Map<string, CoinPrice>>;
}

export interface CoinGeckoOptions {
  apiKey?: string;
  timeZone: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A JSON number as a decimal string with at most 18 decimals: CoinGecko
 * sends small prices in exponent notation (`1.2e-7`), which
 * `parseDecimal()` rejects, so the shortest representation is expanded.
 */
export function numberToDecimal(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Not a finite number: ${value}`);
  }
  const [mantissa, exponentPart] = String(value).split("e");
  const exponent = Number(exponentPart ?? 0);
  const negative = mantissa.startsWith("-");
  const [whole, fraction = ""] = mantissa.replace("-", "").split(".");
  const digits = whole + fraction;
  const point = whole.length + exponent;
  const expanded =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + "0".repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [int, frac = ""] = expanded.split(".");
  // Below 10^-18 per coin is noise for a valuation.
  const kept = frac.slice(0, DECIMAL_SCALE);
  return formatDecimal(
    parseDecimal(`${negative ? "-" : ""}${int}${kept ? `.${kept}` : ""}`),
  );
}

function errorFor(status: number, message: string): PriceApiError {
  if (status === 429) return new PriceApiError("rate_limited", message);
  if (status === 401 || status === 403) {
    return new PriceApiError("auth", message);
  }
  if (status === 408 || status >= 500) {
    return new PriceApiError("unavailable", message);
  }
  return new PriceApiError("invalid_response", message);
}

type SimplePrice = Record<string, Record<string, number | null | undefined>>;

export function createCoinGeckoClient(
  options: CoinGeckoOptions,
): CryptoPriceClient {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const limit = createRateLimiter({
    perMinute: PER_MINUTE,
    perDay: PER_DAY,
    now,
    sleep:
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  });

  async function fetchChunk(ids: readonly string[], vs: string) {
    await limit();
    const url = new URL(COINGECKO_URL);
    url.searchParams.set("ids", ids.join(","));
    url.searchParams.set("vs_currencies", vs);
    url.searchParams.set("include_last_updated_at", "true");
    let response: Response;
    try {
      response = await fetchFn(url, {
        headers: {
          Accept: "application/json",
          ...(options.apiKey ? { "x-cg-demo-api-key": options.apiKey } : {}),
        },
      });
    } catch (error) {
      throw new PriceApiError(
        "unavailable",
        `CoinGecko is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw errorFor(
        response.status,
        `CoinGecko responded with HTTP ${response.status}`,
      );
    }
    try {
      return (await response.json()) as SimplePrice;
    } catch {
      throw new PriceApiError("invalid_response", "CoinGecko returned no JSON");
    }
  }

  return {
    async getPrices(ids, currency) {
      const vs = currency.toLowerCase();
      const unique = [...new Set(ids)].sort();
      const result = new Map<string, CoinPrice>();
      for (let start = 0; start < unique.length; start += IDS_PER_REQUEST) {
        const body = await fetchChunk(
          unique.slice(start, start + IDS_PER_REQUEST),
          vs,
        );
        for (const [id, quote] of Object.entries(body)) {
          const value = quote?.[vs];
          if (!unique.includes(id) || typeof value !== "number") continue;
          if (value < 0) {
            throw new PriceApiError(
              "invalid_response",
              `CoinGecko returned a negative price for ${id}`,
            );
          }
          const updatedAt = quote.last_updated_at;
          result.set(id, {
            date: localDate(
              new Date(
                typeof updatedAt === "number" ? updatedAt * 1000 : now(),
              ),
              options.timeZone,
            ),
            price: numberToDecimal(value),
            currency,
          });
        }
      }
      return result;
    },
  };
}
