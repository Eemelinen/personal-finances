import { describe, expect, it, vi } from "vitest";
import {
  ECB_DAILY_URL,
  fetchEcbRates,
  parseEcbRates,
} from "@/server/investments/ecb";
import {
  createRateLimiter,
  createTwelveDataClient,
  micForIsin,
  PriceApiError,
  type PriceQuery,
} from "@/server/investments/price-client";

// The price client against a mocked `fetch`: Twelve Data's `/eod` JSON, its
// errors (often with HTTP 200), unknown symbols and the free-tier rate
// limit; and the ECB reference rate file. Nothing reaches the network.

const NOKIA: PriceQuery = {
  symbol: "AAA1",
  isin: "FI4000000011",
  currency: "EUR",
};
const USX: PriceQuery = {
  symbol: "USX",
  isin: "US0000000018",
  currency: "USD",
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** A fake clock whose sleep advances it. */
function clock(start = Date.parse("2026-10-23T07:30:00Z")) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    sleeps,
  };
}

function client(
  fetch: typeof globalThis.fetch,
  options: { perMinute?: number; perDay?: number } = {},
) {
  const time = clock();
  return {
    time,
    client: createTwelveDataClient({
      apiKey: "test-key",
      fetch,
      now: time.now,
      sleep: time.sleep,
      ...options,
    }),
  };
}

describe("Twelve Data client", () => {
  it("parses the end-of-day close and sends the key in a header", async () => {
    const fetch = vi.fn(async () =>
      json({
        symbol: "AAA1",
        exchange: "Helsinki",
        mic_code: "XHEL",
        currency: "EUR",
        datetime: "2026-10-22",
        close: "13.45500",
      }),
    );
    const { client: prices } = client(fetch);
    await expect(prices.getClosingPrice(NOKIA)).resolves.toEqual({
      date: "2026-10-22",
      close: "13.455",
      currency: "EUR",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe("https://api.twelvedata.com/eod");
    expect(url.searchParams.get("symbol")).toBe("AAA1");
    expect(url.searchParams.get("mic_code")).toBe("XHEL");
    expect(url.searchParams.has("apikey")).toBe(false);
    expect(init.headers).toEqual({ Authorization: "apikey test-key" });
  });

  it("lets the API choose the exchange outside the Nordics", async () => {
    const fetch = vi.fn(async () =>
      json({ currency: "USD", datetime: "2026-10-22", close: "50.1" }),
    );
    const { client: prices } = client(fetch);
    await prices.getClosingPrice(USX);
    const [url] = fetch.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.has("mic_code")).toBe(false);
    expect([micForIsin("SE0000000000"), micForIsin(null)]).toEqual([
      "XSTO",
      null,
    ]);
  });

  it("returns null for an unknown symbol, in a 200 or a 404", async () => {
    const notFound = {
      code: 404,
      message: "**symbol** or **figi** parameter is missing or invalid.",
      status: "error",
    };
    const { client: in200 } = client(vi.fn(async () => json(notFound)));
    await expect(in200.getClosingPrice(NOKIA)).resolves.toBeNull();
    const { client: in404 } = client(
      vi.fn(async () => json(notFound, { status: 404 })),
    );
    await expect(in404.getClosingPrice(NOKIA)).resolves.toBeNull();
    const { client: invalid } = client(
      vi.fn(async () =>
        json({
          code: 400,
          message: "Invalid **symbol** parameter",
          status: "error",
        }),
      ),
    );
    await expect(invalid.getClosingPrice(NOKIA)).resolves.toBeNull();
  });

  it("returns null when the listing found is quoted in another currency", async () => {
    const { client: prices } = client(
      vi.fn(async () =>
        json({ currency: "USD", datetime: "2026-10-22", close: "1" }),
      ),
    );
    await expect(prices.getClosingPrice(NOKIA)).resolves.toBeNull();
  });

  it("maps the API's limit, key and outage errors", async () => {
    const cases: [Response, string][] = [
      [
        json({
          code: 429,
          message: "You have run out of API credits",
          status: "error",
        }),
        "rate_limited",
      ],
      [
        json({}, { status: 429, headers: { "retry-after": "30" } }),
        "rate_limited",
      ],
      [
        json({ code: 401, message: "apikey is incorrect", status: "error" }),
        "auth",
      ],
      [new Response("Bad gateway", { status: 502 }), "unavailable"],
      [
        json({ currency: "EUR", datetime: "2026-10-22", close: "n/a" }),
        "invalid_response",
      ],
      [json({ currency: "EUR", close: "1" }), "invalid_response"],
    ];
    for (const [response, kind] of cases) {
      const { client: prices } = client(vi.fn(async () => response));
      const error = await prices
        .getClosingPrice(NOKIA)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PriceApiError);
      expect((error as PriceApiError).kind).toBe(kind);
    }
  });

  it("passes on Retry-After with a rate limit", async () => {
    const { client: prices } = client(
      vi.fn(async () =>
        json({}, { status: 429, headers: { "retry-after": "30" } }),
      ),
    );
    await expect(prices.getClosingPrice(NOKIA)).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 30_000,
    });
  });

  it("maps a network failure to unavailable", async () => {
    const { client: prices } = client(
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(prices.getClosingPrice(NOKIA)).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("waits so that at most 8 requests go out in any minute", async () => {
    const fetch = vi.fn(async () =>
      json({ currency: "EUR", datetime: "2026-10-22", close: "1" }),
    );
    const { client: prices, time } = client(fetch);
    for (let i = 0; i < 8; i++) {
      await prices.getClosingPrice(NOKIA);
      time.advance(1_000);
    }
    expect(time.sleeps).toEqual([]);
    // The ninth waits until the first is a minute old (8 s have passed).
    await prices.getClosingPrice(NOKIA);
    expect(time.sleeps).toEqual([52_000]);
    expect(fetch).toHaveBeenCalledTimes(9);
  });

  it("stops at the daily limit without calling the API", async () => {
    const fetch = vi.fn(async () =>
      json({ currency: "EUR", datetime: "2026-10-22", close: "1" }),
    );
    const { client: prices } = client(fetch, { perDay: 2, perMinute: 100 });
    await prices.getClosingPrice(NOKIA);
    await prices.getClosingPrice(NOKIA);
    await expect(prices.getClosingPrice(NOKIA)).rejects.toMatchObject({
      kind: "daily_limit",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("createRateLimiter", () => {
  it("starts a new daily count on the next UTC day", async () => {
    const time = clock(Date.parse("2026-10-23T23:59:00Z"));
    const limit = createRateLimiter({ perMinute: 10, perDay: 1, ...time });
    await limit();
    await expect(limit()).rejects.toThrow(/daily limit of 1/);
    time.advance(120_000);
    await expect(limit()).resolves.toBeUndefined();
  });
});

const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
	<gesmes:subject>Reference rates</gesmes:subject>
	<Cube>
		<Cube time='2026-10-23'>
			<Cube currency='USD' rate='1.0812'/>
			<Cube currency='JPY' rate='162.35'/>
			<Cube currency='SEK' rate='11.4835'/>
		</Cube>
	</Cube>
</gesmes:Envelope>`;

describe("ECB reference rates", () => {
  it("parses the day and the rates per EUR", () => {
    expect(parseEcbRates(ECB_XML)).toEqual({
      date: "2026-10-23",
      rates: [
        { currency: "USD", rate: "1.0812" },
        { currency: "JPY", rate: "162.35" },
        { currency: "SEK", rate: "11.4835" },
      ],
    });
  });

  it("rejects a file without a day or rates", () => {
    expect(() => parseEcbRates("<html></html>")).toThrow(PriceApiError);
    expect(() => parseEcbRates("<Cube time='2026-10-23'></Cube>")).toThrow(
      /no rates/,
    );
  });

  it("fetches the daily file and maps HTTP failures", async () => {
    const fetch = vi.fn(async () => new Response(ECB_XML));
    await expect(fetchEcbRates({ fetch })).resolves.toMatchObject({
      date: "2026-10-23",
    });
    expect(fetch).toHaveBeenCalledWith(ECB_DAILY_URL);
    await expect(
      fetchEcbRates({
        fetch: vi.fn(async () => new Response("", { status: 503 })),
      }),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });
});
