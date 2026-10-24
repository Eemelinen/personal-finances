"use client";

import { useActionState, useId } from "react";
import { NativeSelect } from "@/components/form-controls";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { connectBank } from "./actions";

// Starts a bank connection: the action redirects to the bank, or returns
// why it could not.

export function ConnectForm({ banks }: { banks: string[] }) {
  const id = useId();
  const [result, action, pending] = useActionState(connectBank, null);
  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-xl border p-4"
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`} className="text-lg font-medium">
        Connect a bank
      </h2>
      <p className="text-muted-foreground text-sm">
        You log in at the bank and approve read-only access to your accounts for
        the longest consent the bank allows (180 days). The app can never make
        payments.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-bank`}>Bank</Label>
          <NativeSelect
            id={`${id}-bank`}
            name="bank"
            className="w-48"
            defaultValue={banks[0]}
          >
            {banks.map((bank) => (
              <option key={bank} value={bank}>
                {bank}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Opening the bank…" : "Connect"}
        </Button>
      </div>
      {result && !result.ok && (
        <p role="alert" className="text-destructive text-sm">
          {result.error}
        </p>
      )}
    </form>
  );
}
