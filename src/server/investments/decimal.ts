// Exact decimal arithmetic for quantities, unit prices and FX rates (D-016).
// Postgres `numeric(38, 18)` columns come back as strings; they are parsed
// into BigInt fixed-point values with 18 decimals, never into JS numbers.
// (`tsconfig.json` targets ES2017, so BigInt literals like `0n` are out.)

/** Decimals stored for quantities, unit prices and FX rates. */
export const DECIMAL_SCALE = 18;

const ZERO = BigInt(0);
const TWO = BigInt(2);

/** 10^exponent as a BigInt. */
export function pow10(exponent: number): bigint {
  return BigInt(10) ** BigInt(exponent);
}

/** 10^18: one unit in fixed-point form. */
export const SCALE_FACTOR = pow10(DECIMAL_SCALE);

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d*))?$|^([+-]?)\.(\d+)$/;

/**
 * Parses a decimal string (`"12"`, `"-0.5"`, `"1.234500000000000000"`) into
 * units of 10^-18. Throws on anything else, including more than 18 decimals
 * (except trailing zeros) and exponent notation.
 */
export function parseDecimal(value: string): bigint {
  const match = DECIMAL.exec(value.trim());
  if (!match) {
    throw new RangeError(`Not a decimal: ${JSON.stringify(value)}`);
  }
  const sign = match[1] ?? match[4] ?? "";
  const whole = match[2] ?? "0";
  const fraction = (match[3] ?? match[5] ?? "").replace(/0+$/, "");
  if (fraction.length > DECIMAL_SCALE) {
    throw new RangeError(
      `More than ${DECIMAL_SCALE} decimals: ${JSON.stringify(value)}`,
    );
  }
  const units =
    BigInt(whole) * SCALE_FACTOR +
    BigInt(fraction.padEnd(DECIMAL_SCALE, "0") || "0");
  return sign === "-" ? -units : units;
}

/** Formats units of 10^-18 as a decimal string without trailing zeros. */
export function formatDecimal(units: bigint): string {
  const negative = units < ZERO;
  const absolute = negative ? -units : units;
  const whole = absolute / SCALE_FACTOR;
  const fraction = (absolute % SCALE_FACTOR)
    .toString()
    .padStart(DECIMAL_SCALE, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** `numerator / denominator` rounded half away from zero (denominator > 0). */
export function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= ZERO) throw new RangeError("Denominator must be positive");
  const negative = numerator < ZERO;
  const absolute = negative ? -numerator : numerator;
  const rounded = (TWO * absolute + denominator) / (TWO * denominator);
  return negative ? -rounded : rounded;
}

/** Minor-unit digits of an ISO-4217 currency: 2 for EUR, 0 for JPY, 3 for KWD. */
export function currencyExponent(currency: string): number {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
  }).resolvedOptions().maximumFractionDigits!;
}
