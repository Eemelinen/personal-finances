import { sealData, unsealData } from "iron-session";

/**
 * The login session: an iron-session seal (encrypted and signed with
 * `SESSION_SECRET`) in an httpOnly cookie. There is one user, so the session
 * only records when it was issued; it is valid for 30 days after that, and
 * `src/proxy.ts` re-issues it once it is a day old, so the expiry slides with
 * use. Sessions are stateless: logout deletes the cookie, and changing
 * `SESSION_SECRET` signs every browser out.
 */
export const SESSION_COOKIE = "pf_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
// Tolerated clock difference for a session issued "in the future".
const CLOCK_SKEW_MS = 60 * 1000;

export type Session = {
  /** Issue time in epoch milliseconds. */
  issuedAt: number;
};

export function sealSession(secret: string, now: number): Promise<string> {
  const session: Session = { issuedAt: now };
  return sealData(session, { password: secret, ttl: SESSION_TTL_SECONDS });
}

/** The session in a cookie value, or null if it is missing, forged or expired. */
export async function unsealSession(
  seal: string | undefined,
  secret: string,
  now: number,
): Promise<Session | null> {
  if (!seal) return null;
  const data = await unsealData<Partial<Session>>(seal, {
    password: secret,
    ttl: SESSION_TTL_SECONDS,
  });
  const issuedAt = data.issuedAt;
  if (typeof issuedAt !== "number" || !Number.isFinite(issuedAt)) return null;
  if (issuedAt > now + CLOCK_SKEW_MS) return null;
  if (now - issuedAt >= SESSION_TTL_MS) return null;
  return { issuedAt };
}

/** Whether a valid session is old enough to be re-issued with a fresh expiry. */
export function shouldRefreshSession(session: Session, now: number): boolean {
  return now - session.issuedAt >= SESSION_REFRESH_AFTER_MS;
}

/** Attributes for the session cookie; `secure` everywhere but local development. */
export function sessionCookieOptions(nodeEnv: string) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: nodeEnv === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  } as const;
}
