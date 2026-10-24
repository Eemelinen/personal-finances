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
