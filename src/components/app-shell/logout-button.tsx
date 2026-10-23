import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { logout } from "@/lib/auth/actions";
import { verifySession } from "@/lib/auth/session";

/**
 * Reads the session (the data access layer's check behind the proxy), so it
 * renders behind a Suspense boundary and streams in after the static shell.
 */
export async function LogoutButton() {
  await verifySession();

  return (
    <form action={logout}>
      <Button type="submit" variant="ghost" size="sm">
        <LogOut aria-hidden="true" />
        Log out
      </Button>
    </form>
  );
}
