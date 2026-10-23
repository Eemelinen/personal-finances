const moneyFormats = new Map<string, Intl.NumberFormat>();

/** Integer minor units as `fi-FI` money for display, e.g. `-1 234,56 €`. */
export function formatMoney(amountMinor: number, currency: string): string {
  let format = moneyFormats.get(currency);
  if (!format) {
    format = new Intl.NumberFormat("fi-FI", { style: "currency", currency });
    moneyFormats.set(currency, format);
  }
  // Display only: the stored value stays integer minor units.
  return format.format(amountMinor / 100);
}

/** A `YYYY-MM-DD` day as `fi-FI` `d.m.yyyy`. */
export function formatDay(date: string): string {
  const [year, month, day] = date.split("-");
  return `${Number(day)}.${Number(month)}.${year}`;
}
