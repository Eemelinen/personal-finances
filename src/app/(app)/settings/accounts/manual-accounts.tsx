"use client";

import {
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { NativeSelect } from "@/components/form-controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BANK_ACCOUNT_TYPES,
  MAX_ACCOUNT_NAME_LENGTH,
  MAX_INSTITUTION_NAME_LENGTH,
  type BankAccountType,
} from "@/server/connections/account-input";
import {
  addManualAccountAction,
  archiveManualAccountAction,
  updateManualAccountAction,
  type ManualAccountResult,
} from "./actions";

// Settings → Accounts (F-029): own accounts outside the bank connections.
// Add one (bank, name, IBAN, checking or savings, optional balance on a
// date), edit name, IBAN and type or give a newer balance, and archive.

export interface ManualAccountView {
  id: string;
  name: string;
  institution: string;
  iban: string | null;
  type: BankAccountType;
  /** The latest balance and its day, already formatted; null when none. */
  balance: string | null;
}

const TYPE_LABELS: Record<BankAccountType, string> = {
  checking: "Checking",
  savings: "Savings",
};

const subscribeNothing = () => () => {};

function savedMessage(what: string, linked: number): string {
  if (linked === 0) return `${what} No transactions were linked as transfers.`;
  return `${what} Linked ${linked} ${linked === 1 ? "transaction" : "transactions"} as own transfers.`;
}

/** Runs an action and keeps its outcome for the status line. */
function useAccountAction() {
  const [result, setResult] = useState<
    (ManualAccountResult & { message?: string }) | null
  >(null);
  const [pending, startTransition] = useTransition();
  const run = (
    action: () => Promise<ManualAccountResult>,
    done: { message: (linked: number) => string; onSuccess?: () => void },
  ) => {
    setResult(null);
    startTransition(async () => {
      const outcome = await action();
      if (outcome.ok) {
        setResult({ ...outcome, message: done.message(outcome.linked) });
        done.onSuccess?.();
      } else {
        setResult(outcome);
      }
    });
  };
  const feedback = result && (
    <p
      role={result.ok ? "status" : "alert"}
      className={result.ok ? "text-sm" : "text-destructive text-sm"}
    >
      {result.ok ? result.message : result.error}
    </p>
  );
  return { run, pending, feedback };
}

export function ManualAccounts({
  accounts,
  today,
}: {
  accounts: ManualAccountView[];
  /** `YYYY-MM-DD`: the latest day a balance may be given for. */
  today: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <AddAccountForm today={today} />
      <section
        aria-labelledby="manual-accounts-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="manual-accounts-heading" className="text-lg font-medium">
          Manual accounts
        </h2>
        {accounts.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No manual accounts yet. Accounts a CSV import creates show here too.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {accounts.map((account) => (
              <AccountItem key={account.id} account={account} today={today} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TypeSelect({
  id,
  defaultValue,
}: {
  id: string;
  defaultValue: BankAccountType;
}) {
  return (
    <NativeSelect id={id} name="type" defaultValue={defaultValue}>
      {BANK_ACCOUNT_TYPES.map((type) => (
        <option key={type} value={type}>
          {TYPE_LABELS[type]}
        </option>
      ))}
    </NativeSelect>
  );
}

function BalanceFields({ ids, today }: { ids: string; today: string }) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${ids}-balance`}>Balance (optional)</Label>
        <Input
          id={`${ids}-balance`}
          name="balance"
          inputMode="decimal"
          placeholder="1 234,56"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${ids}-balance-date`}>Balance date</Label>
        <Input
          id={`${ids}-balance-date`}
          name="balanceDate"
          type="date"
          max={today}
        />
      </div>
    </>
  );
}

function AddAccountForm({ today }: { today: string }) {
  const ids = useId();
  const hydrated = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  const form = useRef<HTMLFormElement>(null);
  const { run, pending, feedback } = useAccountAction();

  // Not a form action: React would clear the fields after an error too.
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    run(() => addManualAccountAction(data), {
      message: (linked) => savedMessage("Account added.", linked),
      onSuccess: () => form.current?.reset(),
    });
  };

  return (
    <section
      aria-labelledby={`${ids}-heading`}
      className="flex flex-col gap-4 rounded-xl border p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${ids}-heading`} className="text-lg font-medium">
          Add an account
        </h2>
        <p className="text-muted-foreground text-sm">
          A savings account the bank consent does not cover, or an account at
          another bank. Money moved between it and a connected account then
          counts as an own transfer, not as income or spending. A balance on a
          date counts in net worth from that day until you give a newer one.
        </p>
      </div>
      <form
        ref={form}
        onSubmit={submit}
        className="grid gap-3 sm:grid-cols-2 sm:items-end lg:grid-cols-3"
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-institution`}>Bank</Label>
          <Input
            id={`${ids}-institution`}
            name="institution"
            placeholder="Nordea"
            required
            maxLength={MAX_INSTITUTION_NAME_LENGTH}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-name`}>Account name</Label>
          <Input
            id={`${ids}-name`}
            name="name"
            placeholder="Savings"
            required
            maxLength={MAX_ACCOUNT_NAME_LENGTH}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-iban`}>IBAN</Label>
          <Input
            id={`${ids}-iban`}
            name="iban"
            placeholder="FI21 1234 5600 0007 85"
            required
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-type`}>Type</Label>
          <TypeSelect id={`${ids}-type`} defaultValue="savings" />
        </div>
        <BalanceFields ids={ids} today={today} />
        <div>
          <Button type="submit" disabled={pending || !hydrated}>
            {pending ? "Saving…" : "Add account"}
          </Button>
        </div>
      </form>
      {feedback}
    </section>
  );
}

function AccountItem({
  account,
  today,
}: {
  account: ManualAccountView;
  today: string;
}) {
  const ids = useId();
  const [mode, setMode] = useState<"view" | "edit" | "archive">("view");
  const { run, pending, feedback } = useAccountAction();

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    run(() => updateManualAccountAction(account.id, data), {
      message: (linked) => savedMessage("Account saved.", linked),
      onSuccess: () => setMode("view"),
    });
  };

  return (
    <li
      aria-labelledby={`${ids}-name`}
      data-testid="manual-account"
      className="flex flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`${ids}-name`} className="font-medium">
          {account.name}
        </h3>
        <span className="text-muted-foreground text-sm">
          {account.institution}
        </span>
      </div>
      <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt>IBAN</dt>
        <dd>{account.iban ?? "—"}</dd>
        <dt>Type</dt>
        <dd>{TYPE_LABELS[account.type]}</dd>
        <dt>Balance</dt>
        <dd data-testid="manual-account-balance">{account.balance ?? "—"}</dd>
      </dl>

      {mode === "edit" && (
        <form
          onSubmit={submit}
          aria-label={`Edit ${account.name}`}
          className="grid gap-3 sm:grid-cols-2 sm:items-end lg:grid-cols-3"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-edit-name`}>Account name</Label>
            <Input
              id={`${ids}-edit-name`}
              name="name"
              defaultValue={account.name}
              required
              maxLength={MAX_ACCOUNT_NAME_LENGTH}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-edit-iban`}>IBAN</Label>
            <Input
              id={`${ids}-edit-iban`}
              name="iban"
              defaultValue={account.iban ?? ""}
              required={account.iban !== null}
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-edit-type`}>Type</Label>
            <TypeSelect id={`${ids}-edit-type`} defaultValue={account.type} />
          </div>
          <BalanceFields ids={`${ids}-edit`} today={today} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => setMode("view")}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {mode === "archive" && (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-sm">
            Archive {account.name}? It leaves the dashboard and net worth; its
            transactions stay, and its IBAN still marks own transfers.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                run(() => archiveManualAccountAction(account.id), {
                  message: () => "Account archived.",
                })
              }
            >
              Confirm archive
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => setMode("view")}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mode === "view" && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setMode("edit")}
          >
            Edit
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setMode("archive")}
          >
            Archive
          </Button>
        </div>
      )}
      {feedback}
    </li>
  );
}
