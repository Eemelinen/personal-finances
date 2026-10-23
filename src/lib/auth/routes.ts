/** Where the proxy sends a visitor without a session. */
export const LOGIN_PATH = "/login";

const HEALTH_PATH = "/api/health";
// Everything else needs a session. Exact matches: `/login/anything` is not public.
const PUBLIC_PATHS = new Set([LOGIN_PATH, HEALTH_PATH]);

function normalize(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(normalize(pathname));
}

/** The health check answers without reading the session or the login secrets. */
export function isHealthPath(pathname: string): boolean {
  return normalize(pathname) === HEALTH_PATH;
}

/** Route handlers answer 401 instead of redirecting to the login page. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export type AccessDecision =
  "allow" | "redirect-to-login" | "unauthorized" | "redirect-to-app";

/** What the proxy does with a request, given whether it carries a valid session. */
export function accessDecision(
  pathname: string,
  hasSession: boolean,
): AccessDecision {
  if (hasSession) {
    return normalize(pathname) === LOGIN_PATH ? "redirect-to-app" : "allow";
  }
  if (isPublicPath(pathname)) return "allow";
  return isApiPath(pathname) ? "unauthorized" : "redirect-to-login";
}
