"use client";

import { useId, useState, useTransition } from "react";
import { NativeSelect } from "@/components/form-controls";
import { RenewButton } from "@/components/connections/renew-button";
import { SyncNowButton } from "@/components/sync/sync-now-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { syncConnectionAction } from "@/lib/sync/actions";
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

// The bank connections on /connections: status, consent expiry, Renew when
// it ends within 14 days or has ended (F-011), last sync, Sync now and the
// sync log (F-010), the accounts (rename, checking or
// savings) and Archive / Remove, each confirmed in place.

export interface ConnectionView {
  id: string;
  institutionName: string;
  status: "active" | "expired" | "revoked" | "archived";
  /** The consent ends within 14 days or has ended (F-011). */
  renewable: boolean;
  /** Already formatted for display. */
  consentExpires: string | null;
  lastSynced: string | null;
  accounts: ConnectionAccount[];
  /** The latest sync runs, newest first. */
  syncLog: SyncRunView[];
}

/** A `sync_runs` row, formatted for display. */
export interface SyncRunView {
  id: string;
  kind: "balances" | "transactions" | "holdings" | null;
  status: "running" | "succeeded" | "failed";
  started: string;
  /** Null while running. */
  duration: string | null;
  accounts: number;
  fetched: number;
  inserted: number;
  updated: number;
  error: string | null;
}

const KIND_LABELS: Record<NonNullable<SyncRunView["kind"]>, string> = {
  balances: "Balances",
  transactions: "Transactions",
  holdings: "Holdings",
};

const RUN_STATUS_LABELS: Record<SyncRunView["status"], string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
};

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
      {(connection.status === "active" || connection.renewable) && (
        <div className="flex flex-wrap items-start gap-2">
          {connection.renewable && (
            <RenewButton
              connectionId={connection.id}
              institution={connection.institutionName}
            />
          )}
          {connection.status === "active" && (
            <SyncNowButton sync={() => syncConnectionAction(connection.id)} />
          )}
        </div>
      )}

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

      <SyncLog runs={connection.syncLog} />

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

function SyncLog({ runs }: { runs: SyncRunView[] }) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-log`} className="flex flex-col gap-2">
      <h3 id={`${id}-log`} className="text-sm font-medium">
        Sync log
      </h3>
      {runs.length === 0 ? (
        <p className="text-muted-foreground text-sm">No syncs yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-labelledby={`${id}-log`}>
            <thead className="text-muted-foreground text-left">
              <tr>
                <th scope="col" className="py-1 pr-3 font-normal">
                  Started
                </th>
                <th scope="col" className="py-1 pr-3 font-normal">
                  Step
                </th>
                <th scope="col" className="py-1 pr-3 font-normal">
                  Status
                </th>
                <th scope="col" className="py-1 pr-3 font-normal">
                  Duration
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-normal">
                  Accounts
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-normal">
                  Fetched
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-normal">
                  New
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-normal">
                  Changed
                </th>
                <th scope="col" className="py-1 font-normal">
                  Error
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {runs.map((run) => (
                <tr key={run.id} data-testid="sync-run">
                  <td className="py-1 pr-3 whitespace-nowrap">{run.started}</td>
                  <td className="py-1 pr-3" data-testid="sync-run-kind">
                    {run.kind ? KIND_LABELS[run.kind] : "—"}
                  </td>
                  <td
                    className={
                      run.status === "failed"
                        ? "text-destructive py-1 pr-3"
                        : "py-1 pr-3"
                    }
                    data-testid="sync-run-status"
                  >
                    {RUN_STATUS_LABELS[run.status]}
                  </td>
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {run.duration ?? "—"}
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums">
                    {run.accounts}
                  </td>
                  <td
                    className="py-1 pr-3 text-right tabular-nums"
                    data-testid="sync-run-fetched"
                  >
                    {run.fetched}
                  </td>
                  <td
                    className="py-1 pr-3 text-right tabular-nums"
                    data-testid="sync-run-inserted"
                  >
                    {run.inserted}
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums">
                    {run.updated}
                  </td>
                  <td className="py-1" data-testid="sync-run-error">
                    {run.error ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
