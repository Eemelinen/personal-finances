import { formatDateTime, formatDay, formatMoney } from "@/lib/format";
import type { AccountSummary, BankGroup } from "@/server/queries/dashboard";
import { Sparkline } from "./sparkline";

const TYPE_LABELS: Record<AccountSummary["type"], string> = {
  checking: "Checking",
  savings: "Savings",
  brokerage: "Brokerage",
  crypto: "Crypto",
};

interface AccountListProps {
  banks: BankGroup[];
  timeZone: string;
  sparklineDays: number;
}

function lastSync(account: AccountSummary, timeZone: string): string {
  if (account.manual) return "Manual account (CSV import)";
  if (!account.lastSyncedAt) return "Not synced yet";
  return `Synced ${formatDateTime(account.lastSyncedAt, timeZone)}`;
}

/** Accounts grouped by bank: balance, last sync and a balance sparkline. */
export function AccountList({
  banks,
  timeZone,
  sparklineDays,
}: AccountListProps) {
  return (
    <section aria-labelledby="accounts-heading" className="flex flex-col gap-3">
      <h2 id="accounts-heading" className="text-lg font-medium">
        Accounts
      </h2>
      {banks.map((bank) => (
        <section
          key={bank.name}
          aria-label={bank.name}
          data-testid="bank"
          className="rounded-xl border"
        >
          <h3 className="border-b px-4 py-2 font-medium">{bank.name}</h3>
          <ul className="divide-y">
            {bank.accounts.map((account) => (
              <li
                key={account.id}
                data-testid="account"
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
              >
                <div className="flex min-w-0 flex-1 basis-48 flex-col">
                  <span className="truncate font-medium">{account.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {TYPE_LABELS[account.type]}
                    {account.iban && ` · ${account.iban}`}
                  </span>
                  <span
                    data-testid="account-last-sync"
                    className="text-muted-foreground text-xs"
                  >
                    {lastSync(account, timeZone)}
                  </span>
                </div>
                <Sparkline
                  points={account.sparkline}
                  currency={account.currency}
                  label={`${account.name}: balance, last ${sparklineDays} days`}
                />
                <div className="flex w-36 flex-col items-end">
                  <span
                    data-testid="account-balance"
                    className="font-medium tabular-nums"
                  >
                    {account.balance
                      ? formatMoney(
                          account.balance.amountMinor,
                          account.currency,
                        )
                      : account.holdingsMinor !== null
                        ? formatMoney(account.holdingsMinor, "EUR")
                        : "No balance yet"}
                  </span>
                  {account.balance && (
                    <span className="text-muted-foreground text-xs">
                      on {formatDay(account.balance.date)}
                    </span>
                  )}
                  {account.holdingsMinor !== null && (
                    <span
                      data-testid="account-holdings"
                      className="text-muted-foreground text-xs tabular-nums"
                    >
                      {account.balance
                        ? `+ ${formatMoney(account.holdingsMinor, "EUR")} holdings`
                        : "in holdings"}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
