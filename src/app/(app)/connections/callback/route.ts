import { type NextRequest } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { completeBankConnection } from "@/server/connections/authorization";
import { syncBankConnections } from "@/server/sync/bank-sync";

// Where the bank sends the user back (`ENABLE_BANKING_REDIRECT_URL`, F-007):
// `?state=…&code=…`, or `?state=…&error=…` when the authorisation did not
// finish. A new connection is synced right away (F-010), so /connections
// shows its balances and sync log; a failed first sync is in the log and is
// retried by the worker. The outcome is shown on /connections.

export async function GET(request: NextRequest) {
  await verifySession();
  const params = request.nextUrl.searchParams;
  const result = await completeBankConnection({
    state: params.get("state"),
    code: params.get("code"),
    error: params.get("error"),
  });
  if (result.ok) {
    const [sync] = await syncBankConnections({
      connectionIds: [result.connectionId],
    });
    if (sync?.errorKind === "internal") {
      console.error("[connections] the first sync failed:", sync.cause);
    }
  }
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
