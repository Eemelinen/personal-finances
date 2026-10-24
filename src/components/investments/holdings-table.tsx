import { ChartCandlestick } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import {
  formatDay,
  formatMoney,
  formatMoneyChange,
  formatPercent,
  formatQuantity,
  formatUnitPrice,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  HoldingRow,
  InvestmentsOverview,
} from "@/server/queries/investments";

// The /investments holdings table (F-020): one row per account and asset
// with quantity, price, EUR value, gain or loss and portfolio weight.

const CURRENCY = "EUR";

const SOURCE_LABELS: Record<string, string> = {
  twelve_data: "closing price",
  nordnet_trade: "last trade",
};

function gainClass(gainMinor: number | null): string {
  if (gainMinor === null || gainMinor === 0) return "";
  return gainMinor > 0
    ? "text-emerald-700 dark:text-emerald-400"
    : "text-red-700 dark:text-red-400";
}

function Gain({
  minor,
  share,
}: {
  minor: number | null;
  share: number | null;
}) {
  if (minor === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn("flex flex-col items-end", gainClass(minor))}>
      <span>{formatMoneyChange(minor, CURRENCY)}</span>
      {share !== null && (
        <span className="text-xs">
          {share > 0 ? "+" : ""}
          {formatPercent(share)}
        </span>
      )}
    </span>
  );
}

function Price({ holding }: { holding: HoldingRow }) {
  if (!holding.price)
    return <span className="text-muted-foreground">No price</span>;
  const source = SOURCE_LABELS[holding.price.source] ?? holding.price.source;
  return (
    <span className="flex flex-col items-end">
      <span>
        {formatUnitPrice(holding.price.priceMinor, holding.price.currency)}
      </span>
      <span className="text-muted-foreground text-xs">
        {source}, {formatDay(holding.price.date)}
      </span>
    </span>
  );
}

export function HoldingsTable({ overview }: { overview: InvestmentsOverview }) {
  if (overview.holdings.length === 0) {
    return (
      <EmptyState
        icon={ChartCandlestick}
        title="No holdings yet"
        description="Import a Nordnet transaction export below to see your holdings here."
      />
    );
  }
  const showAccount =
    new Set(overview.holdings.map((h) => h.accountId)).size > 1;
  return (
    <section aria-labelledby="holdings-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="holdings-heading" className="text-lg font-medium">
          Holdings
        </h2>
        <p className="text-muted-foreground text-sm">
          Valued on {formatDay(overview.date)}
          {!overview.complete && " · some holdings have no price yet"}
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground border-b text-left">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Asset
              </th>
              {showAccount && (
                <th scope="col" className="px-3 py-2 font-medium">
                  Account
                </th>
              )}
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Quantity
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Price
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Value
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Gain / loss
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Weight
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {overview.holdings.map((holding) => (
              <tr
                key={`${holding.accountId}-${holding.assetId}`}
                data-testid="holding"
                className="tabular-nums"
              >
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <span className="flex flex-col">
                    <span className="font-medium">{holding.symbol}</span>
                    {(holding.name || holding.isin) && (
                      <span className="text-muted-foreground text-xs">
                        {[holding.name, holding.isin]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                  </span>
                </th>
                {showAccount && (
                  <td className="px-3 py-2">{holding.accountName}</td>
                )}
                <td
                  className="px-3 py-2 text-right"
                  data-testid="holding-quantity"
                >
                  {formatQuantity(holding.quantity)}
                </td>
                <td
                  className="px-3 py-2 text-right"
                  data-testid="holding-price"
                >
                  <Price holding={holding} />
                </td>
                <td
                  className="px-3 py-2 text-right"
                  data-testid="holding-value"
                >
                  {holding.valueMinor !== null ? (
                    formatMoney(holding.valueMinor, CURRENCY)
                  ) : (
                    <span className="text-muted-foreground">
                      {holding.missing === "fx_rate" ? "No FX rate" : "—"}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right" data-testid="holding-gain">
                  <Gain minor={holding.gainMinor} share={holding.gainShare} />
                </td>
                <td
                  className="px-3 py-2 text-right"
                  data-testid="holding-weight"
                >
                  {holding.weight !== null
                    ? formatPercent(holding.weight)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t font-medium tabular-nums">
            <tr data-testid="holdings-total">
              <th scope="row" className="px-3 py-2 text-left">
                Total
              </th>
              {showAccount && <td />}
              <td />
              <td />
              <td className="px-3 py-2 text-right" data-testid="total-value">
                {formatMoney(overview.valueMinor, CURRENCY)}
              </td>
              <td className="px-3 py-2 text-right" data-testid="total-gain">
                <Gain
                  minor={overview.costMinor > 0 ? overview.gainMinor : null}
                  share={
                    overview.costMinor > 0
                      ? overview.gainMinor / overview.costMinor
                      : null
                  }
                />
              </td>
              <td className="px-3 py-2 text-right">
                {overview.valueMinor > 0 ? formatPercent(1) : "—"}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
