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

/**
 * Whether the proxy may re-issue a day-old session on this request: only on
 * a page load, a GET or HEAD the browser sends as a top-level navigation
 * (`Sec-Fetch-Mode: navigate`), and not a speculative one (`Sec-Purpose:
 * prefetch`, e.g. a prerender). A page load replaces the page, so its
 * response cannot arrive after a logout made from that page.
 *
 * Everything else is a fetch from a page that may log out meanwhile: the
 * router's link prefetches, client navigations and refreshes, and Server
 * Action calls (which may set or delete the cookie themselves, as logout
 * does). Their responses can land after logout's deletion, and a fresh
 * cookie in one would log the browser back in, so they keep the cookie as
 * it is (D-021). Next strips its own router headers (`rsc`,
 * `next-router-prefetch`) from the request the proxy sees, so the browser's
 * Fetch Metadata headers decide. A browser that sends none never re-issues:
 * its session then ends 30 days after login.
 */
export function mayReissueSession(
  method: string,
  headers: Pick<Headers, "get">,
): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (headers.get("sec-fetch-mode") !== "navigate") return false;
  const purpose = headers.get("sec-purpose") ?? headers.get("purpose") ?? "";
  return !purpose.toLowerCase().includes("prefetch");
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
