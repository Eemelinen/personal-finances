import { type NextRequest } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { completeBankConnection } from "@/server/connections/authorization";

// Where the bank sends the user back (`ENABLE_BANKING_REDIRECT_URL`, F-007):
// `?state=…&code=…`, or `?state=…&error=…` when the authorisation did not
// finish. The outcome is shown on /connections.

export async function GET(request: NextRequest) {
  await verifySession();
  const params = request.nextUrl.searchParams;
  const result = await completeBankConnection({
    state: params.get("state"),
    code: params.get("code"),
    error: params.get("error"),
  });
  const outcome = new URLSearchParams(
    result.ok ? { connected: result.connectionId } : { error: result.error },
  );
  // 303: the follow-up is a plain GET, and the callback URL (with its spent
  // code) does not stay in the address bar. A relative Location does not
  // depend on the host the server thinks it has behind a proxy.
  return new Response(null, {
    status: 303,
    headers: { Location: `/connections?${outcome}` },
  });
}
