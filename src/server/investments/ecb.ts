import type { CurrencyCode, IsoDate } from "@/server/providers/types";
import { formatDecimal, parseDecimal } from "./decimal";
import { PriceApiError } from "./price-client";

// The ECB's euro foreign exchange reference rates (F-020, D-017): one XML
// file of the latest working day's rates, units per 1 EUR, no key and no
// limit. Parsed with a regular expression; the file is small and flat.

export const ECB_DAILY_URL =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

export interface EcbRates {
  date: IsoDate;
  rates: { currency: CurrencyCode; rate: string }[];
}

/** Reads `eurofxref-daily.xml`: `<Cube time="…">` with `<Cube currency rate>`s. */
export function parseEcbRates(xml: string): EcbRates {
  const day = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml);
  if (!day) {
    throw new PriceApiError("invalid_response", "The ECB file has no rate day");
  }
  const rates: EcbRates["rates"] = [];
  for (const match of xml.matchAll(
    /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/>/g,
  )) {
    const rate = formatDecimal(parseDecimal(match[2]));
    if (rate !== "0") rates.push({ currency: match[1], rate });
  }
  if (rates.length === 0) {
    throw new PriceApiError("invalid_response", "The ECB file has no rates");
  }
  return { date: day[1], rates };
}

export async function fetchEcbRates(
  options: { fetch?: typeof fetch } = {},
): Promise<EcbRates> {
  const fetchFn = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(ECB_DAILY_URL);
  } catch (error) {
    throw new PriceApiError(
      "unavailable",
      `The ECB is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new PriceApiError(
      response.status >= 500 ? "unavailable" : "invalid_response",
      `The ECB responded with HTTP ${response.status}`,
    );
  }
  return parseEcbRates(await response.text());
}
