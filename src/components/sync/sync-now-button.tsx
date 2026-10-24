"use client";

import { RefreshCw } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { SyncNowResult } from "@/lib/sync/summary";

/**
 * Sync now (F-010): runs `sync` (a Server Action) with a pending state, then
 * says how it went. The page refreshes with the new balances and log.
 */
export function SyncNowButton({
  sync,
}: {
  sync: () => Promise<SyncNowResult>;
}) {
  const [result, setResult] = useState<SyncNowResult | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        aria-busy={pending}
        onClick={() => {
          setResult(null);
          startTransition(async () => setResult(await sync()));
        }}
      >
        <RefreshCw
          aria-hidden="true"
          className={pending ? "animate-spin" : undefined}
        />
        {pending ? "Syncing…" : "Sync now"}
      </Button>
      {result && (
        <p
          role={result.ok ? "status" : "alert"}
          className={result.ok ? "text-sm" : "text-destructive text-sm"}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
