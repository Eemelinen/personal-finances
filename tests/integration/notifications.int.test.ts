import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  connections,
  institutions,
  notifications,
  syncRuns,
} from "@/server/db/schema";
import { parseEnv } from "@/server/env";
import { findIssues, sendNotifications } from "@/server/ops/notifications";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

// The notifications job (F-024) against real Postgres 18: which connections
// have an issue (N failed syncs in a row, a consent ending within 7 days or
// ended), and that the `notifications` table lets each issue through once a
// day, also across separate runs (a restarted worker).

const NOW = new Date("2026-10-24T09:00:00.000Z");
const DAY_MS = 86_400_000;
const TZ = "Europe/Helsinki";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  await testDb.db.delete(notifications);
  await testDb.db.delete(syncRuns);
  await testDb.db.delete(connections);
  await testDb.db.delete(institutions);
});

async function connection(
  name: string,
  values: Partial<typeof connections.$inferInsert> = {},
): Promise<string> {
  const [institution] = await testDb.db
    .insert(institutions)
    .values({
      name,
      country: "FI",
      provider: values.provider ?? "enable_banking",
      providerRef: name,
    })
    .returning();
  const [row] = await testDb.db
    .insert(connections)
    .values({
      institutionId: institution.id,
      provider: "enable_banking",
      consentExpiresAt: new Date(NOW.getTime() + 90 * DAY_MS),
      ...values,
    })
    .returning();
  return row.id;
}

/** Runs one minute apart, oldest first. */
async function runs(
  connectionId: string,
  list: [
    (typeof syncRuns.$inferInsert)["kind"],
    "succeeded" | "failed",
    string?,
  ][],
): Promise<void> {
  const start = NOW.getTime() - list.length * 60_000;
  await testDb.db.insert(syncRuns).values(
    list.map(([kind, status, error], i) => ({
      connectionId,
      kind,
      status,
      error: error ?? null,
      startedAt: new Date(start + i * 60_000),
      finishedAt: new Date(start + i * 60_000 + 1_000),
    })),
  );
}

const find = (failedSyncs = 3) =>
  findIssues({ db: testDb.db, now: () => NOW, timeZone: TZ, failedSyncs });

describe("findIssues", () => {
  it("reports a connection whose last N syncs failed", async () => {
    const nordea = await connection("Nordea");
    // An old success, then: balances failed; balances ok but transactions
    // failed; balances failed: three failed syncs.
    await runs(nordea, [
      ["balances", "succeeded"],
      ["transactions", "succeeded"],
      ["balances", "failed", "timeout"],
      ["balances", "succeeded"],
      ["transactions", "failed", "rate limited"],
      ["balances", "failed", "Bank unavailable"],
    ]);
    const spankki = await connection("S-Pankki");
    // Two failures after a success: below the threshold.
    await runs(spankki, [
      ["balances", "succeeded"],
      ["transactions", "succeeded"],
      ["balances", "failed"],
      ["balances", "failed"],
    ]);

    expect(await find()).toEqual([
      {
        key: `sync-failing:${nordea}`,
        title: "Nordea: sync failing",
        message:
          "The last 3 syncs of Nordea failed. Latest error: Bank unavailable. See the sync log on Connections.",
        priority: "high",
        tags: ["warning"],
      },
    ]);
    expect((await find(2)).map((issue) => issue.key)).toEqual([
      `sync-failing:${nordea}`,
      `sync-failing:${spankki}`,
    ]);
  });

  it("counts Kraken's holdings as a complete sync and leaves archived connections out", async () => {
    const kraken = await connection("Kraken", {
      provider: "kraken",
      consentExpiresAt: null,
    });
    await runs(kraken, [
      ["balances", "failed"],
      ["balances", "failed"],
      ["balances", "failed"],
      ["balances", "succeeded"],
      ["holdings", "succeeded"],
    ]);
    const archived = await connection("Old bank", { status: "archived" });
    await runs(archived, [
      ["balances", "failed"],
      ["balances", "failed"],
      ["balances", "failed"],
    ]);
    const never = await connection("New bank");
    await runs(never, [
      ["balances", "failed"],
      ["balances", "failed"],
      ["balances", "failed"],
    ]);

    expect((await find()).map((issue) => issue.key)).toEqual([
      `sync-failing:${never}`,
    ]);
  });

  it("reports consents ending within 7 days and ended ones", async () => {
    const soon = await connection("Nordea", {
      consentExpiresAt: new Date("2026-10-30T22:30:00Z"), // 00:30 on 31 Oct,
    });
    await connection("Later", {
      consentExpiresAt: new Date(NOW.getTime() + 8 * DAY_MS),
    });
    const ended = await connection("S-Pankki", {
      consentExpiresAt: new Date(NOW.getTime() - 1_000),
    });
    const expired = await connection("Aktia", { status: "expired" });
    const revoked = await connection("OP", { status: "revoked" });
    await connection("Gone", {
      status: "archived",
      consentExpiresAt: new Date(NOW.getTime() - DAY_MS),
    });

    const issues = await find();
    expect(issues.map((issue) => issue.key)).toEqual([
      `consent-expired:${expired}`,
      `consent-expiring:${soon}`,
      `consent-expired:${revoked}`,
      `consent-expired:${ended}`,
    ]);
    expect(issues[1]).toEqual({
      key: `consent-expiring:${soon}`,
      title: "Nordea: consent ending",
      message:
        "The bank consent of Nordea ends on 31.10.2026. Renew the connection on Connections before then.",
      tags: ["hourglass"],
    });
    expect(issues[0].priority).toBe("high");
  });
});

describe("sendNotifications", () => {
  const env = (url?: string) =>
    parseEnv({
      DATABASE_URL: "postgres://user:pass@localhost:5432/finances",
      APP_TIMEZONE: TZ,
      NTFY_URL: url,
    });

  it("does nothing without NTFY_URL", async () => {
    await connection("S-Pankki", { status: "expired" });
    const fetchImpl = vi.fn();
    expect(
      await sendNotifications(env(), {
        db: testDb.db,
        now: () => NOW,
        fetch: fetchImpl,
      }),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await testDb.db.select().from(notifications)).toEqual([]);
  });

  it("sends each issue once a day, across runs, and again the next day", async () => {
    const id = await connection("S-Pankki", { status: "expired" });
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const run = (now: Date) =>
      sendNotifications(env("https://ntfy.example/topic"), {
        db: testDb.db,
        now: () => now,
        fetch: fetchImpl,
      });

    expect((await run(NOW))?.sent).toEqual([`consent-expired:${id}`]);
    expect((await run(new Date(NOW.getTime() + 3_600_000)))?.skipped).toEqual([
      `consent-expired:${id}`,
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      await testDb.db
        .select({ issue: notifications.issue, day: notifications.day })
        .from(notifications),
    ).toEqual([{ issue: `consent-expired:${id}`, day: "2026-10-24" }]);

    expect((await run(new Date(NOW.getTime() + DAY_MS)))?.sent).toEqual([
      `consent-expired:${id}`,
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a failed send and prunes rows older than 30 days", async () => {
    const id = await connection("S-Pankki", { status: "expired" });
    await testDb.db.insert(notifications).values([
      { issue: "old", day: "2026-09-01" },
      { issue: "recent", day: "2026-10-01" },
    ]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValue(new Response("{}"));
    const run = () =>
      sendNotifications(env("https://ntfy.example/topic"), {
        db: testDb.db,
        now: () => NOW,
        fetch: fetchImpl,
      });

    expect((await run())?.failed).toEqual([
      { key: `consent-expired:${id}`, error: "ntfy answered 500 " },
    ]);
    expect(
      await testDb.db
        .select({ issue: notifications.issue })
        .from(notifications)
        .where(eq(notifications.issue, `consent-expired:${id}`)),
    ).toEqual([]);
    expect((await run())?.sent).toEqual([`consent-expired:${id}`]);
    expect(
      (await testDb.db.select().from(notifications))
        .map((row) => row.issue)
        .sort(),
    ).toEqual([`consent-expired:${id}`, "recent"]);
  });
});
