const moneyFormats = new Map<string, Intl.NumberFormat>();

function moneyFormat(currency: string, signed: boolean): Intl.NumberFormat {
  const key = `${currency}:${signed}`;
  let format = moneyFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat("fi-FI", {
      style: "currency",
      currency,
      signDisplay: signed ? "exceptZero" : "auto",
    });
    moneyFormats.set(key, format);
  }
  return format;
}

/** Integer minor units as `fi-FI` money for display, e.g. `-1 234,56 €`. */
export function formatMoney(amountMinor: number, currency: string): string {
  // Display only: the stored value stays integer minor units.
  return moneyFormat(currency, false).format(amountMinor / 100);
}

/** A change in minor units with its sign, e.g. `+1 234,56 €`; zero unsigned. */
export function formatMoneyChange(
  amountMinor: number,
  currency: string,
): string {
  return moneyFormat(currency, true).format(amountMinor / 100);
}

/** A `YYYY-MM-DD` day as `fi-FI` `d.m.yyyy`. */
export function formatDay(date: string): string {
  const [year, month, day] = date.split("-");
  return `${Number(day)}.${Number(month)}.${year}`;
}

/** A point in time as `fi-FI` `d.m.yyyy klo h.mm` in `timeZone`. */
export function formatDateTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("fi-FI", {
    timeZone,
    dateStyle: "short",
    timeStyle: "short",
  }).format(instant);
}

/** The day of a point in time in `timeZone`, as `fi-FI` `d.m.yyyy`. */
export function formatLocalDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("fi-FI", {
    timeZone,
    dateStyle: "short",
  }).format(instant);
}

/**
 * A duration in milliseconds, e.g. `350 ms`, `1,2 s` or `2 min 5 s`
 * (`fi-FI` decimals).
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) {
    const seconds = new Intl.NumberFormat("fi-FI", {
      maximumFractionDigits: 1,
    }).format(Math.floor(ms / 100) / 10);
    return `${seconds} s`;
  }
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** Money rounded to whole units, for chart axes, e.g. `1 235 €`. */
export function formatMoneyRounded(
  amountMinor: number,
  currency: string,
): string {
  return new Intl.NumberFormat("fi-FI", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(Math.round(amountMinor / 100));
}

const percentFormat = new Intl.NumberFormat("fi-FI", {
  style: "percent",
  maximumFractionDigits: 1,
});

/** A share (0…1) as `fi-FI` percent, e.g. `74,8 %`. */
export function formatPercent(share: number): string {
  return percentFormat.format(share);
}

const monthFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** A `YYYY-MM` month for labels, e.g. `Oct 2026`. */
export function formatMonth(month: string): string {
  return monthFormat.format(new Date(`${month}-01T00:00:00Z`));
}

const quantityFormat = new Intl.NumberFormat("fi-FI", {
  maximumFractionDigits: 6,
});

/** A decimal-string quantity for display, e.g. `1 234,5`. */
export function formatQuantity(quantity: string): string {
  // Display only: up to 6 decimals; the stored value stays exact.
  return quantityFormat.format(Number(quantity));
}

/**
 * A unit price given as a decimal string of minor units, e.g. `12,345 €`:
 * at least 2 and at most 4 decimals.
 */
export function formatUnitPrice(priceMinor: string, currency: string): string {
  return new Intl.NumberFormat("fi-FI", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(Number(priceMinor) / 100);
}
