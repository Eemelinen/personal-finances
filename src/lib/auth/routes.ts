/** Where the proxy sends a visitor without a session. */
export const LOGIN_PATH = "/login";

// Everything else needs a session. Exact matches: `/login/anything` is not public.
const PUBLIC_PATHS = new Set([LOGIN_PATH, "/api/health"]);

export function isPublicPath(pathname: string): boolean {
  const normalized =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  return PUBLIC_PATHS.has(normalized);
}

/** Route handlers answer 401 instead of redirecting to the login page. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}
