"use client";

import { useId, useState, useTransition } from "react";
import { NativeSelect } from "@/components/form-controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BANK_ACCOUNT_TYPES,
  MAX_ACCOUNT_NAME_LENGTH,
} from "@/server/connections/account-input";
import type { ConnectionAccount } from "@/server/connections/manage";
import {
  archiveConnectionAction,
  removeConnectionAction,
  saveAccount,
  type ActionResult,
} from "./actions";

// The bank connections on /connections: status, consent expiry, last sync,
// the accounts (rename, checking or savings) and Archive / Remove, each
// confirmed in place.

export interface ConnectionView {
  id: string;
  institutionName: string;
  status: "active" | "expired" | "revoked" | "archived";
  /** Already formatted for display. */
  consentExpires: string | null;
  lastSynced: string | null;
  accounts: ConnectionAccount[];
}

const STATUS_LABELS: Record<ConnectionView["status"], string> = {
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
  archived: "Archived",
};

const TYPE_LABELS: Record<ConnectionAccount["type"], string> = {
  checking: "Checking",
  savings: "Savings",
  brokerage: "Brokerage",
  crypto: "Crypto",
};

function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (
    action: () => Promise<ActionResult>,
    done: { message?: string; onSuccess?: () => void } = {},
  ) => {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (done.message) setMessage(done.message);
      done.onSuccess?.();
    });
  };
  const feedback = (
    <>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </>
  );
  return { run, pending, feedback };
}

export function ConnectionList({
  connections,
}: {
  connections: ConnectionView[];
}) {
  return (
    <ul className="flex flex-col gap-4">
      {connections.map((connection) => (
        <ConnectionCard key={connection.id} connection={connection} />
      ))}
    </ul>
  );
}

function ConnectionCard({ connection }: { connection: ConnectionView }) {
  const id = useId();
  const [confirm, setConfirm] = useState<"none" | "archive" | "remove">("none");
  const { run, pending, feedback } = useAction();
  const archived = connection.status === "archived";

  return (
    <li
      aria-labelledby={`${id}-name`}
      data-connection-id={connection.id}
      className="flex flex-col gap-4 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${id}-name`} className="text-lg font-medium">
          {connection.institutionName}
        </h2>
        <span
          className={
            connection.status === "active"
              ? "text-sm"
              : "text-muted-foreground text-sm"
          }
        >
          {STATUS_LABELS[connection.status]}
        </span>
      </div>
      <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt>Consent until</dt>
        <dd>{connection.consentExpires ?? "—"}</dd>
        <dt>Last sync</dt>
        <dd>{connection.lastSynced ?? "Not synced yet"}</dd>
      </dl>

      {connection.accounts.length === 0 ? (
        <p className="text-muted-foreground text-sm">No accounts.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {connection.accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              editable={!archived}
            />
          ))}
        </ul>
      )}

      {confirm === "none" ? (
        <div className="flex flex-wrap gap-2">
          {!archived && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirm("archive")}
            >
              Archive
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirm("remove")}
          >
            Remove
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-sm">
            {confirm === "archive"
              ? `Archive ${connection.institutionName}? The consent is ended at the bank and the connection is no longer synced; its accounts and their history stay in reports and transactions.`
              : `Remove ${connection.institutionName}? ${archived ? "Its accounts are" : "The consent is ended at the bank, and its accounts are"} deleted with all their transactions and balances.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={confirm === "remove" ? "destructive" : "default"}
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    confirm === "archive"
                      ? archiveConnectionAction(connection.id)
                      : removeConnectionAction(connection.id),
                  { onSuccess: () => setConfirm("none") },
                )
              }
            >
              {confirm === "archive" ? "Confirm archive" : "Confirm remove"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => setConfirm("none")}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {feedback}
    </li>
  );
}

function AccountRow({
  account,
  editable,
}: {
  account: ConnectionAccount;
  editable: boolean;
}) {
  const id = useId();
  const [name, setName] = useState(account.name);
  const [type, setType] = useState<string>(account.type);
  const { run, pending, feedback } = useAction();
  const bankType = (BANK_ACCOUNT_TYPES as readonly string[]).includes(
    account.type,
  );
  const label = account.iban ?? account.name;
  const changed = name !== account.name || type !== account.type;

  if (!editable || !bankType) {
    return (
      <li className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 text-sm">
        <span className="font-medium">{account.name}</span>
        <span className="text-muted-foreground">
          {TYPE_LABELS[account.type]}
        </span>
        {account.iban && (
          <span className="text-muted-foreground">{account.iban}</span>
        )}
        {account.archived && (
          <span className="text-muted-foreground">Archived</span>
        )}
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-1 py-2">
      <form
        className="flex flex-wrap items-center gap-2"
        aria-label={`Account ${label}`}
        onSubmit={(event) => {
          event.preventDefault();
          run(() => saveAccount(account.id, { name, type }), {
            message: "Account saved.",
          });
        }}
      >
        <Input
          id={`${id}-name`}
          aria-label="Account name"
          value={name}
          maxLength={MAX_ACCOUNT_NAME_LENGTH}
          required
          onChange={(event) => setName(event.target.value)}
          className="w-64"
        />
        <NativeSelect
          aria-label="Account type"
          value={type}
          onChange={(event) => setType(event.target.value)}
          className="w-32"
        >
          {BANK_ACCOUNT_TYPES.map((value) => (
            <option key={value} value={value}>
              {TYPE_LABELS[value]}
            </option>
          ))}
        </NativeSelect>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={pending || !changed}
        >
          Save
        </Button>
        <span className="text-muted-foreground text-sm">
          {account.iban ?? account.currency}
          {account.archived ? " · Archived" : ""}
        </span>
      </form>
      {feedback}
    </li>
  );
}
