import { io } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthEnv, getEnv } from "@/server/env";
import {
  SESSION_COOKIE,
  sealSession,
  sessionCookieOptions,
  unsealSession,
  type Session,
} from "@/server/auth/session";
import { LOGIN_PATH } from "./routes";

/**
 * Data access layer for the session. `src/proxy.ts` only redirects
 * optimistically; anything that reads or changes data (Server Components,
 * Server Actions, Route Handlers) calls `verifySession()` itself.
 */
export async function getSession(): Promise<Session | null> {
  // Checking the expiry reads the clock (here and inside iron-session's
  // unseal). `io()` keeps that out of every prerender, including the
  // runtime prefetch where `cookies()` already resolves; during a request
  // it resolves at once.
  await io();
  const seal = (await cookies()).get(SESSION_COOKIE)?.value;
  return unsealSession(seal, getAuthEnv().SESSION_SECRET, Date.now());
}

/** The current session; redirects to the login page when there is none. */
export async function verifySession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect(LOGIN_PATH);
  return session;
}

export async function createSession(): Promise<void> {
  const cookieStore = await cookies();
  const seal = await sealSession(getAuthEnv().SESSION_SECRET, Date.now());
  cookieStore.set(
    SESSION_COOKIE,
    seal,
    sessionCookieOptions(getEnv().NODE_ENV),
  );
}

export async function deleteSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
