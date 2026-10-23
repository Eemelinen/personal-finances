import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodePasswordHash,
  encodePasswordHash,
} from "@/server/auth/hash-encoding";
import { LoginThrottle } from "@/server/auth/login-throttle";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import {
  SESSION_REFRESH_AFTER_MS,
  SESSION_TTL_SECONDS,
  sealSession,
  sessionCookieOptions,
  shouldRefreshSession,
  unsealSession,
} from "@/server/auth/session";

const SECRET = "unit-test-session-secret-0123456789abcdef";
const OTHER_SECRET = "another-unit-test-secret-0123456789abcdef";
const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_MS = SESSION_TTL_SECONDS * 1000;
const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);

describe("password check", () => {
  it("accepts the hashed password and rejects others", async () => {
    const phc = await hashPassword("correct horse battery");

    expect(phc).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(phc, "correct horse battery")).toBe(true);
    expect(await verifyPassword(phc, "correct horse batter")).toBe(false);
    expect(await verifyPassword(phc, "")).toBe(false);
  });

  it("returns false for a malformed hash instead of throwing", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });

  it("round-trips the .env encoding and also accepts a raw PHC string", async () => {
    const phc = await hashPassword("correct horse battery");
    const encoded = encodePasswordHash(phc);

    expect(encoded).not.toContain("$");
    expect(decodePasswordHash(encoded)).toBe(phc);
    expect(decodePasswordHash(` ${encoded}\n`)).toBe(phc);
    expect(decodePasswordHash(phc)).toBe(phc);
    expect(decodePasswordHash("plain-text-password")).toBeUndefined();
    expect(decodePasswordHash("")).toBeUndefined();
  });
});

describe("session sealing and expiry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("unseals a fresh session with the same secret", async () => {
    const seal = await sealSession(SECRET, T0);

    expect(seal).not.toContain(String(T0));
    expect(await unsealSession(seal, SECRET, T0)).toEqual({ issuedAt: T0 });
  });

  it("rejects a missing, tampered or foreign seal", async () => {
    const seal = await sealSession(SECRET, T0);
    const tampered = `${seal.slice(0, -4)}AAAA`;

    expect(await unsealSession(undefined, SECRET, T0)).toBeNull();
    expect(await unsealSession("", SECRET, T0)).toBeNull();
    expect(await unsealSession("garbage", SECRET, T0)).toBeNull();
    expect(await unsealSession(tampered, SECRET, T0)).toBeNull();
    expect(await unsealSession(seal, OTHER_SECRET, T0)).toBeNull();
  });

  it("expires 30 days after it was issued", async () => {
    vi.useFakeTimers({ now: T0 });
    const seal = await sealSession(SECRET, T0);

    const almost = T0 + TTL_MS - 60_000;
    vi.setSystemTime(almost);
    expect(await unsealSession(seal, SECRET, almost)).toEqual({
      issuedAt: T0,
    });

    const after = T0 + TTL_MS;
    vi.setSystemTime(after);
    expect(await unsealSession(seal, SECRET, after)).toBeNull();
  });

  it("rejects a session issued in the future", async () => {
    const seal = await sealSession(SECRET, T0 + DAY_MS);

    expect(await unsealSession(seal, SECRET, T0)).toBeNull();
  });

  it("slides: a day-old session is re-issued and then lives 30 more days", async () => {
    vi.useFakeTimers({ now: T0 });
    const first = await sealSession(SECRET, T0);
    const firstSession = await unsealSession(first, SECRET, T0);
    expect(firstSession).not.toBeNull();
    expect(shouldRefreshSession(firstSession!, T0 + DAY_MS - 1)).toBe(false);
    expect(shouldRefreshSession(firstSession!, T0 + DAY_MS)).toBe(true);
    expect(SESSION_REFRESH_AFTER_MS).toBe(DAY_MS);

    const refreshedAt = T0 + 20 * DAY_MS;
    vi.setSystemTime(refreshedAt);
    const second = await sealSession(SECRET, refreshedAt);

    const later = T0 + 40 * DAY_MS;
    vi.setSystemTime(later);
    expect(await unsealSession(first, SECRET, later)).toBeNull();
    expect(await unsealSession(second, SECRET, later)).toEqual({
      issuedAt: refreshedAt,
    });
  });

  it("uses an httpOnly, sameSite=lax cookie that lasts 30 days", () => {
    expect(sessionCookieOptions("production")).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    expect(sessionCookieOptions("development").secure).toBe(false);
  });
});

describe("login backoff", () => {
  it("allows five failures, then makes each attempt wait longer", () => {
    const throttle = new LoginThrottle();
    let now = T0;

    for (let i = 0; i < 5; i += 1) {
      expect(throttle.retryAfterMs(now)).toBe(0);
      throttle.recordFailure(now);
    }
    expect(throttle.failures).toBe(5);
    expect(throttle.retryAfterMs(now)).toBe(1000);
    expect(throttle.retryAfterMs(now + 400)).toBe(600);
    expect(throttle.retryAfterMs(now + 1000)).toBe(0);

    now += 1000;
    throttle.recordFailure(now);
    expect(throttle.retryAfterMs(now)).toBe(2000);

    now += 2000;
    throttle.recordFailure(now);
    expect(throttle.retryAfterMs(now)).toBe(4000);
  });

  it("caps the delay", () => {
    const throttle = new LoginThrottle({ maxDelayMs: 60_000 });
    for (let i = 0; i < 30; i += 1) throttle.recordFailure(T0);

    expect(throttle.retryAfterMs(T0)).toBe(60_000);
  });

  it("resets after a successful login", () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < 7; i += 1) throttle.recordFailure(T0);
    expect(throttle.retryAfterMs(T0)).toBeGreaterThan(0);

    throttle.recordSuccess();
    expect(throttle.failures).toBe(0);
    expect(throttle.retryAfterMs(T0)).toBe(0);
  });
});
