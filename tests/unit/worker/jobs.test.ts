import cron from "node-cron";
import { afterEach, describe, expect, it, vi } from "vitest";

// The worker's job registry: the daily price update (F-020) and the Kraken
// sync (F-021) are registered with valid schedules and log their outcome.

const updatePrices = vi.hoisted(() => vi.fn());
vi.mock("@/server/investments/update-prices", () => ({ updatePrices }));
const syncKraken = vi.hoisted(() => vi.fn());
vi.mock("@/server/investments/sync-kraken", () => ({ syncKraken }));

const { jobs } = await import("@/worker/jobs");

afterEach(() => {
  vi.restoreAllMocks();
  updatePrices.mockReset();
  syncKraken.mockReset();
});

describe("jobs", () => {
  it("have unique names and valid cron schedules", () => {
    expect(new Set(jobs.map((job) => job.name)).size).toBe(jobs.length);
    for (const job of jobs) expect(cron.validate(job.schedule)).toBe(true);
  });

  it("run the price update once a day at 07:30", async () => {
    const job = jobs.find((j) => j.name === "price-update");
    expect(job?.schedule).toBe("30 7 * * *");
    updatePrices.mockResolvedValue({
      fxDate: "2026-10-23",
      fxRates: 30,
      prices: 2,
      unknown: ["FUND"],
      problems: ["Stock prices: PRICE_API_KEY is not set"],
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await job!.run();
    expect(updatePrices).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      "[price-update] 30 FX rates (2026-10-23), 2 prices, unknown: FUND",
    );
    expect(warn).toHaveBeenCalledWith(
      "[price-update] Stock prices: PRICE_API_KEY is not set",
    );
  });

  it("sync Kraken every six hours and log each connection's outcome", async () => {
    const job = jobs.find((j) => j.name === "kraken-sync");
    expect(job?.schedule).toBe("15 */6 * * *");
    syncKraken.mockResolvedValue([
      {
        connectionId: "c1",
        balances: { status: "succeeded" },
        holdings: {
          status: "succeeded",
          accounts: [
            { holdings: 3, zeroed: 1, fetched: 10, inserted: 4, skipped: [{}] },
          ],
        },
      },
      {
        connectionId: "c2",
        balances: {
          status: "failed",
          errorKind: "auth_expired",
          error: "Kraken: EAPI:Invalid key",
        },
        holdings: null,
      },
    ]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await job!.run();
    expect(syncKraken).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      "[kraken-sync] 3 holdings, 1 sold out, 4 new of 10 ledger transactions, 1 entries not recorded",
    );
    expect(warn).toHaveBeenCalledWith(
      "[kraken-sync] failed (auth_expired): Kraken: EAPI:Invalid key",
    );
  });

  it("say so when there is no Kraken connection", async () => {
    syncKraken.mockResolvedValue([]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await jobs.find((j) => j.name === "kraken-sync")!.run();
    expect(info).toHaveBeenCalledWith(
      "[kraken-sync] no active Kraken connection",
    );
  });
});
