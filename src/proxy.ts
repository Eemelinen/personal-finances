import { NextResponse, type NextRequest } from "next/server";
import { isApiPath, isPublicPath, LOGIN_PATH } from "@/lib/auth/routes";
import {
  SESSION_COOKIE,
  sealSession,
  sessionCookieOptions,
  shouldRefreshSession,
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
  const { SESSION_SECRET } = getAuthEnv();
  const now = Date.now();
  const session = await unsealSession(
    request.cookies.get(SESSION_COOKIE)?.value,
    SESSION_SECRET,
    now,
  );

  if (!session) {
    if (isPublicPath(pathname)) return NextResponse.next();
    if (isApiPath(pathname)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const response = NextResponse.redirect(new URL(LOGIN_PATH, request.url));
    // An expired or forged cookie is of no further use.
    if (request.cookies.has(SESSION_COOKIE)) {
      response.cookies.delete(SESSION_COOKIE);
    }
    return response;
  }

  const response =
    pathname === LOGIN_PATH
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  if (shouldRefreshSession(session, now)) {
    response.cookies.set(
      SESSION_COOKIE,
      await sealSession(SESSION_SECRET, now),
      sessionCookieOptions(getEnv().NODE_ENV),
    );
  }
  return response;
}

export const config = {
  // Everything except build assets. Server Actions post to the page they
  // belong to, so they pass through here too.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
