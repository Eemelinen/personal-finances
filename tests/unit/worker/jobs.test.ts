import cron from "node-cron";
import { afterEach, describe, expect, it, vi } from "vitest";

// The worker's job registry: the bank sync (F-010), the daily price update
// (F-020), the Kraken sync (F-021), the backup and the notifications
// (F-024) are registered with valid schedules and log their outcome.

const updatePrices = vi.hoisted(() => vi.fn());
vi.mock("@/server/investments/update-prices", () => ({ updatePrices }));
const syncKraken = vi.hoisted(() => vi.fn());
vi.mock("@/server/investments/sync-kraken", () => ({ syncKraken }));
const writeBackup = vi.hoisted(() => vi.fn());
const pruneBackups = vi.hoisted(() => vi.fn());
vi.mock("@/server/ops/backup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/ops/backup")>()),
  writeBackup,
  pruneBackups,
}));
const sendNotifications = vi.hoisted(() => vi.fn());
vi.mock("@/server/ops/notifications", () => ({ sendNotifications }));
const syncBankConnections = vi.hoisted(() => vi.fn());
vi.mock("@/server/sync/bank-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/sync/bank-sync")>()),
  syncBankConnections,
}));

const { createJobs } = await import("@/worker/jobs");
const { parseEnv } = await import("@/server/env");

const DATABASE_URL = "postgres://user:pass@localhost:5432/finances";
const ENV = parseEnv({ DATABASE_URL });
const DEFAULT_SYNC_CRON = ENV.SYNC_CRON;
const jobs = createJobs(ENV);
const RECIPIENT =
  "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";

afterEach(() => {
  vi.restoreAllMocks();
  updatePrices.mockReset();
  syncKraken.mockReset();
  syncBankConnections.mockReset();
  writeBackup.mockReset();
  pruneBackups.mockReset();
  sendNotifications.mockReset();
});

describe("jobs", () => {
  it("have unique names and valid cron schedules", () => {
    expect(new Set(jobs.map((job) => job.name)).size).toBe(jobs.length);
    for (const job of jobs) expect(cron.validate(job.schedule)).toBe(true);
  });

  it("sync the banks every six hours by default, at most four times a day", () => {
    expect(DEFAULT_SYNC_CRON).toBe("0 */6 * * *");
    const job = jobs.find((j) => j.name === "bank-sync");
    expect(job?.schedule).toBe(DEFAULT_SYNC_CRON);
    expect(
      createJobs({ ...ENV, SYNC_CRON: "30 5 * * *" }).find(
        (j) => j.name === "bank-sync",
      )?.schedule,
    ).toBe("30 5 * * *");
  });

  it("log each bank connection's sync, failures and bugs included", async () => {
    const bug = new Error("relation does not exist");
    syncBankConnections.mockResolvedValue([
      {
        connectionId: "c1",
        institution: "Nordea",
        status: "succeeded",
        error: null,
        errorKind: null,
        balances: {
          counts: { accounts: 3, inserted: 2, updated: 1 },
        },
        transactions: {
          counts: { fetched: 40, inserted: 5, updated: 2, removed: 1 },
        },
      },
      {
        connectionId: "c2",
        institution: "S-Pankki",
        status: "failed",
        error: "fake bank unavailable",
        errorKind: "unavailable",
        balances: null,
        transactions: null,
      },
      {
        connectionId: "c3",
        institution: "Nordea",
        status: "failed",
        error: bug.message,
        errorKind: "internal",
        balances: null,
        transactions: null,
        cause: bug,
      },
      {
        connectionId: "c4",
        institution: "S-Pankki",
        status: "skipped",
        skipReason: "running",
        error: "A sync of this connection is running",
        errorKind: null,
        balances: null,
        transactions: null,
      },
      {
        connectionId: "c5",
        institution: "Nordea",
        status: "skipped",
        skipReason: "consent_expired",
        error: "The consent has expired; renew the connection",
        errorKind: null,
        balances: null,
        transactions: null,
      },
    ]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await jobs.find((j) => j.name === "bank-sync")!.run();
    expect(syncBankConnections).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      "[bank-sync] Nordea: 3 accounts, 2 new and 1 changed balances, 5 new, 2 changed and 1 removed of 40 transactions",
    );
    expect(info).toHaveBeenCalledWith(
      "[bank-sync] S-Pankki: skipped (A sync of this connection is running)",
    );
    expect(warn).toHaveBeenCalledWith(
      "[bank-sync] S-Pankki: failed (unavailable): fake bank unavailable",
    );
    expect(warn).toHaveBeenCalledWith(
      "[bank-sync] Nordea: skipped (The consent has expired; renew the connection)",
    );
    expect(error).toHaveBeenCalledWith(
      "[bank-sync] Nordea: failed (internal): relation does not exist",
      bug,
    );
  });

  it("say so when there is no bank connection", async () => {
    syncBankConnections.mockResolvedValue([]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await jobs.find((j) => j.name === "bank-sync")!.run();
    expect(info).toHaveBeenCalledWith("[bank-sync] no active bank connection");
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

  it("back up and notify only when configured", () => {
    const names = jobs.map((job) => job.name);
    expect(names).not.toContain("backup");
    expect(names).not.toContain("notifications");

    const configured = createJobs(
      parseEnv({
        DATABASE_URL,
        BACKUP_DIR: "/backups",
        BACKUP_AGE_RECIPIENTS: RECIPIENT,
        NTFY_URL: "https://ntfy.example/finances",
      }),
    );
    for (const job of configured)
      expect(cron.validate(job.schedule)).toBe(true);
    expect(configured.find((j) => j.name === "backup")?.schedule).toBe(
      "30 3 * * *",
    );
    expect(configured.find((j) => j.name === "notifications")?.schedule).toBe(
      "30 8-22 * * *",
    );
  });

  it("write an encrypted backup of the database, then prune the old ones", async () => {
    const env = parseEnv({
      DATABASE_URL,
      BACKUP_DIR: "/backups",
      BACKUP_AGE_RECIPIENTS: RECIPIENT,
    });
    const job = createJobs(env).find((j) => j.name === "backup")!;
    writeBackup.mockResolvedValue({
      path: "/backups/finances-20261024T003000Z.dump.age",
      bytes: 2048,
    });
    pruneBackups.mockResolvedValue(["a", "b"]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await job.run();

    expect(writeBackup).toHaveBeenCalledWith({
      dir: "/backups",
      recipients: [RECIPIENT],
      dump: {
        command: "pg_dump",
        args: expect.arrayContaining([
          "--format=custom",
          `--dbname=${DATABASE_URL}`,
        ]),
      },
    });
    expect(pruneBackups).toHaveBeenCalledWith("/backups", {
      timeZone: "Europe/Helsinki",
    });
    expect(info).toHaveBeenCalledWith(
      "[backup] wrote /backups/finances-20261024T003000Z.dump.age (2048 bytes), removed 2 old backup(s)",
    );
  });

  it("do not prune when the backup fails", async () => {
    const env = parseEnv({
      DATABASE_URL,
      BACKUP_DIR: "/backups",
      BACKUP_AGE_RECIPIENTS: RECIPIENT,
    });
    const job = createJobs(env).find((j) => j.name === "backup")!;
    writeBackup.mockRejectedValue(new Error("pg_dump exited with 1"));
    await expect(job.run()).rejects.toThrow("pg_dump exited with 1");
    expect(pruneBackups).not.toHaveBeenCalled();
  });

  it("log the notifications sent and the ones that failed", async () => {
    const env = parseEnv({ DATABASE_URL, NTFY_URL: "https://ntfy.example/x" });
    const job = createJobs(env).find((j) => j.name === "notifications")!;
    sendNotifications.mockResolvedValue({
      sent: ["consent-expiring:c1"],
      skipped: ["sync-failing:c2"],
      failed: [{ key: "consent-expired:c3", error: "ntfy answered 500" }],
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await job.run();

    expect(sendNotifications).toHaveBeenCalledWith(env);
    expect(info).toHaveBeenCalledWith(
      "[notifications] sent consent-expiring:c1",
    );
    expect(warn).toHaveBeenCalledWith(
      "[notifications] consent-expired:c3 not sent: ntfy answered 500",
    );
  });
});
