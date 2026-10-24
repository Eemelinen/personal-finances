// Merchant names for the top-merchants report (F-017). Bank texts of card
// purchases carry the store, a location, a terminal or reference number, a
// payment processor's prefix and shouty capitals: `K-MARKET KAMPPI 1234`,
// `SUMUP *KAHVILA PIENI`, `WOLT OY`. `merchantName()` turns them into one
// display name per merchant so their purchases add up. Pure.

/**
 * Chains whose store texts add a location or store name after the brand
 * (`PRISMA LAAJASALO`, `ALEPA-HAKANIEMI`). Longer names first where one
 * starts with another.
 */
export const MERCHANT_CHAINS: readonly string[] = [
  "K-Citymarket",
  "K-Supermarket",
  "K-Market",
  "K-Rauta",
  "S-Market",
  "Prisma",
  "Alepa",
  "Sale",
  "Lidl",
  "Alko",
  "Minimani",
  "Tokmanni",
  "Stockmann",
  "Clas Ohlson",
  "Halpa-Halli",
  "Puuilo",
  "Gigantti",
  "Motonet",
  "Biltema",
  "Bauhaus",
  "IKEA",
  "Hesburger",
  "McDonald's",
  "Burger King",
  "Subway",
  "Robert's Coffee",
  "Espresso House",
  "Starbucks",
  "R-Kioski",
  "Neste",
  "ABC",
  "St1",
  "Teboil",
  "Shell",
  "Terveystalo",
  "Mehiläinen",
  "Pihlajalinna",
  "Yliopiston Apteekki",
  "Finnkino",
];

/** Shown when a transaction has neither counterparty nor description. */
export const UNKNOWN_MERCHANT = "Unknown";

// `SUMUP *KAHVILA`, `PAYPAL *SPOTIFY`, `ZETTLE_*CAFE`, `IZ *SHOP`, `SQ *BAR`.
const PROCESSOR_PREFIX =
  /^(?:paypal|sumup|zettle|izettle|iz|sq|vivawallet|viva|nets|klarna|mobilepay)\s*[_*]+\s*/i;

// Legal forms at the end: `WOLT OY`, `FOODORA AB`, `NETFLIX.COM INC`.
const LEGAL_SUFFIX =
  /[\s,]+(?:oyj|oy|ab|abp|ky|tmi|ltd|limited|inc|gmbh|as|aps|bv|llc)\.?$/i;

/** Lower case, apostrophes and dots dropped, every other separator a space. */
function comparable(text: string): string {
  return text
    .toLocaleLowerCase("fi-FI")
    .replace(/['’`.]/g, "")
    .replace(/[\s_\-/]+/g, " ")
    .trim();
}

const CHAINS = MERCHANT_CHAINS.map((name) => ({
  name,
  key: comparable(name),
}));

/** Upper-case words in title case: `KAHVILA PIENI` → `Kahvila Pieni`. */
function titleCase(text: string): string {
  return text
    .toLocaleLowerCase("fi-FI")
    .replace(
      /(^|[\s\-/&(])(\p{L})/gu,
      (_, before: string, letter: string) =>
        before + letter.toLocaleUpperCase("fi-FI"),
    );
}

/** A word that is a store, terminal or reference number: it has a digit. */
const hasDigit = (word: string) => /\d/.test(word);

/**
 * One display name per merchant for a transaction's counterparty (or its
 * description when the counterparty is empty).
 */
export function merchantName(
  counterparty: string | null | undefined,
  description?: string | null,
): string {
  const raw = (counterparty?.trim() ? counterparty : description)?.trim() ?? "";
  let text = raw.replace(/\s+/g, " ").replace(PROCESSOR_PREFIX, "").trim();
  if (text === "") return UNKNOWN_MERCHANT;

  const key = comparable(text);
  for (const chain of CHAINS) {
    if (key === chain.key || key.startsWith(`${chain.key} `)) {
      return chain.name;
    }
  }

  // Trailing store or reference numbers, then a legal form (`… OY 1234`).
  const words = text.split(" ");
  while (words.length > 1 && hasDigit(words[words.length - 1])) words.pop();
  text = words.join(" ");
  let previous;
  do {
    previous = text;
    text = text.replace(LEGAL_SUFFIX, "").trim();
  } while (text !== previous && text !== "");
  text = text.replace(/[\s,*#:-]+$/, "").trim() || raw.trim();

  // Mixed case is the merchant's own spelling; all capitals are not.
  return text === text.toLocaleUpperCase("fi-FI") ? titleCase(text) : text;
}

/** Grouping key: merchants that differ only in case or spacing are one. */
export function merchantKey(name: string): string {
  return comparable(name);
}
