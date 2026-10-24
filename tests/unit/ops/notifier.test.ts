import { describe, expect, it, vi } from "vitest";
import {
  createNotifier,
  memoryNotificationStore,
  type Issue,
} from "@/server/ops/notifier";

// The ntfy notifier (F-024): at most one message per issue per calendar day
// (APP_TIMEZONE), a failed send is retried on the next check, and nothing
// is sent without NTFY_URL.

const TZ = "Europe/Helsinki";
const URL_ = "https://ntfy.example/finances-alerts";

const expiring: Issue = {
  key: "consent-expiring:c1",
  title: "Säästöpankki: consent ending",
  message: "The bank consent of Säästöpankki ends on 30.10.2026.",
  tags: ["hourglass"],
};
const failing: Issue = {
  key: "sync-failing:c2",
  title: "Nordea: sync failing",
  message: "The last 3 syncs of Nordea failed.",
  priority: "high",
};

function ok() {
  return vi.fn(async () => new Response("{}", { status: 200 }));
}

function setup(fetchImpl = ok(), token?: string) {
  let now = new Date("2026-10-24T06:30:00Z");
  const notifier = createNotifier({
    url: URL_,
    token,
    store: memoryNotificationStore(),
    timeZone: TZ,
    now: () => now,
    fetch: fetchImpl as unknown as typeof fetch,
  });
  return {
    notifier,
    fetchImpl,
    setNow: (iso: string) => (now = new Date(iso)),
  };
}

describe("createNotifier", () => {
  it("is disabled without NTFY_URL and sends nothing", async () => {
    const fetchImpl = ok();
    const store = {
      claim: vi.fn(async () => true),
      release: vi.fn(async () => {}),
    };
    const notifier = createNotifier({
      url: undefined,
      store,
      timeZone: TZ,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    expect(notifier.enabled).toBe(false);
    expect(await notifier.notify([expiring, failing])).toEqual({
      sent: [],
      skipped: [],
      failed: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
  });

  it("publishes each issue to the topic with its title, priority and tags", async () => {
    const { notifier, fetchImpl } = setup();
    const result = await notifier.notify([expiring, failing]);

    expect(result).toEqual({
      sent: ["consent-expiring:c1", "sync-failing:c2"],
      skipped: [],
      failed: [],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [target, init] = fetchImpl.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(target.origin + target.pathname).toBe(URL_);
    // Non-ASCII titles go in the query string, which headers could not carry.
    expect(target.searchParams.get("title")).toBe(
      "Säästöpankki: consent ending",
    );
    expect(target.searchParams.get("priority")).toBe("default");
    expect(target.searchParams.get("tags")).toBe("hourglass");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(expiring.message);
    expect(init.headers).toBeUndefined();
    const [second] = fetchImpl.mock.calls[1] as unknown as [URL];
    expect(second.searchParams.get("priority")).toBe("high");
    expect(second.searchParams.has("tags")).toBe(false);
  });

  it("sends an access token when one is set", async () => {
    const { notifier, fetchImpl } = setup(ok(), "tk_secret");
    await notifier.notify([failing]);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.headers).toEqual({ Authorization: "Bearer tk_secret" });
  });

  it("sends an issue at most once a day", async () => {
    const { notifier, fetchImpl, setNow } = setup();
    await notifier.notify([expiring]);
    setNow("2026-10-24T20:30:00Z"); // 23:30 in Helsinki, the same day
    const again = await notifier.notify([expiring, failing]);

    expect(again).toEqual({
      sent: ["sync-failing:c2"],
      skipped: ["consent-expiring:c1"],
      failed: [],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("sends a lasting issue again the next day, by APP_TIMEZONE", async () => {
    const { notifier, fetchImpl, setNow } = setup();
    await notifier.notify([expiring]);
    setNow("2026-10-24T21:30:00Z"); // 00:30 on 25 Oct in Helsinki
    expect((await notifier.notify([expiring])).sent).toEqual([
      "consent-expiring:c1",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries an issue whose message failed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", { status: 503, statusText: "Service Unavailable" }),
      )
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const { notifier } = setup(fetchImpl);

    expect(await notifier.notify([expiring])).toEqual({
      sent: [],
      skipped: [],
      failed: [
        {
          key: "consent-expiring:c1",
          error: "ntfy answered 503 Service Unavailable",
        },
      ],
    });
    expect((await notifier.notify([expiring])).failed).toEqual([
      { key: "consent-expiring:c1", error: "fetch failed" },
    ]);
    expect((await notifier.notify([expiring])).sent).toEqual([
      "consent-expiring:c1",
    ]);
    expect((await notifier.notify([expiring])).skipped).toEqual([
      "consent-expiring:c1",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
