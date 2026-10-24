import cron from "node-cron";
import { afterEach, describe, expect, it, vi } from "vitest";

// The worker's job registry: the daily price update (F-020) is registered
// with a valid schedule and runs updatePrices(), logging its outcome.

const updatePrices = vi.hoisted(() => vi.fn());
vi.mock("@/server/investments/update-prices", () => ({ updatePrices }));

const { jobs } = await import("@/worker/jobs");

afterEach(() => {
  vi.restoreAllMocks();
  updatePrices.mockReset();
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
});
