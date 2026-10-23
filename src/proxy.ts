import { NextResponse, type NextRequest } from "next/server";
import { accessDecision, isHealthPath, LOGIN_PATH } from "@/lib/auth/routes";
import {
  SESSION_COOKIE,
  refreshSession,
  sessionCookieOptions,
  unsealSession,
} from "@/server/auth/session";
import { getAuthEnv, getEnv } from "@/server/env";

/**
 * Optimistic auth check before any route renders: no session → the login
 * page (401 for route handlers); a session on the login page → the
 * dashboard. It also slides the session's 30-day expiry by re-issuing the
 * cookie once a day. Pages and actions still check the session themselves
 * (`verifySession()` in src/lib/auth/session.ts).
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Answers even when the login secrets are missing, so a misconfigured app
  // still reports its database state. Every other path fails fast on them.
  if (isHealthPath(pathname)) return NextResponse.next();

  const { SESSION_SECRET } = getAuthEnv();
  const now = Date.now();
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await unsealSession(cookie, SESSION_SECRET, now);

  let response: NextResponse;
  switch (accessDecision(pathname, session !== null)) {
    case "unauthorized":
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    case "redirect-to-login":
      response = NextResponse.redirect(new URL(LOGIN_PATH, request.url));
      break;
    case "redirect-to-app":
      response = NextResponse.redirect(new URL("/", request.url));
      break;
    case "allow":
      response = NextResponse.next();
      break;
  }

  const cookieOptions = sessionCookieOptions(getEnv().NODE_ENV);
  if (session) {
    const seal = await refreshSession(session, SESSION_SECRET, now);
    if (seal) {
      response.cookies.set(SESSION_COOKIE, seal, cookieOptions);
    }
  } else if (cookie !== undefined) {
    // An expired or forged cookie is of no further use.
    response.cookies.delete(SESSION_COOKIE);
  }
  return response;
}

export const config = {
  // Everything except build assets. Server Actions post to the page they
  // belong to, so they pass through here too.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
