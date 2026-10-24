"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { renewConnectionAction } from "@/lib/connections/actions";

/**
 * Renew (F-011): sends the user to the bank to renew `connectionId`'s
 * consent, or says why that cannot start.
 */
export function RenewButton({
  connectionId,
  institution,
  variant = "default",
}: {
  connectionId: string;
  institution: string;
  variant?: "default" | "outline";
}) {
  const [result, action, pending] = useActionState(renewConnectionAction, null);
  return (
    <form action={action} className="flex flex-col items-start gap-1">
      <input type="hidden" name="connection" value={connectionId} />
      <Button
        type="submit"
        size="sm"
        variant={variant}
        disabled={pending}
        aria-label={`Renew ${institution}`}
      >
        {pending ? "Opening the bank…" : "Renew"}
      </Button>
      {result && !result.ok && (
        <p role="alert" className="text-destructive text-sm">
          {result.error}
        </p>
      )}
    </form>
  );
}
