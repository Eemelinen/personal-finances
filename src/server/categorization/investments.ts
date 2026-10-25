// Recognises investments (F-037, D-036), pure. While the setting
// `excludeInvestments` is on, categorisation puts a transaction that no
// rule categorises into Savings & investments › Investments when this
// matcher calls it an investment: money moved between the user's cash and
// their own holdings, neither spending nor income.
//
// A transaction is an investment when its counterparty names one of the
// brokers, crypto exchanges or fund companies below, or its description
// has one of the fund subscription or redemption words. Matching ignores
// case and needs whole words (letters and digits on neither side), so
// `Nordea Bank Oyj` (bank fees) or a longer word that only contains a
// name never match. A shop that happens to share a name does match; a
// user rule into its real category wins, because rules are tried first.

/** Brokers and crypto exchanges (and their legal entities), by counterparty. */
export const INVESTMENT_BROKERS: readonly string[] = [
  "Nordnet",
  "Kraken",
  "Payward",
  "Coinbase",
  "Bitstamp",
  "Binance",
  "eToro",
  "Degiro",
  "Interactive Brokers",
  "Lightyear",
  "Trade Republic",
  "Bitpanda",
  "Coinmotion",
  "Northcrypto",
];

/** Fund companies, by counterparty. */
export const INVESTMENT_FUND_COMPANIES: readonly string[] = [
  "Seligson",
  "Evli",
  "OP-Rahastoyhtiö",
  "Danske Invest",
  "Aktia Rahastoyhtiö",
  "S-Pankki Rahastoyhtiö",
  "Nordea Rahastot",
  "Nordea Funds",
];

/** Fund subscriptions and redemptions, by a whole word in the description. */
export const INVESTMENT_DESCRIPTION_WORDS: readonly string[] = [
  "MERKINTÄ",
  "rahastomerkintä",
  "LUNASTUS",
  "rahastolunastus",
];

export interface InvestmentSubject {
  counterparty: string | null;
  description: string | null;
}

/** Any of the names as a whole word; whitespace inside a name is any run. */
function wholeWords(names: readonly string[]): RegExp {
  const alternatives = names.map((name) =>
    name
      .normalize("NFC")
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+"),
  );
  return new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`,
    "iu",
  );
}

const COUNTERPARTIES = wholeWords([
  ...INVESTMENT_BROKERS,
  ...INVESTMENT_FUND_COMPANIES,
]);
const DESCRIPTIONS = wholeWords(INVESTMENT_DESCRIPTION_WORDS);

/** Whether the transaction is a payment into or out of an investment. */
export function isInvestment(subject: InvestmentSubject): boolean {
  const test = (regex: RegExp, text: string | null) =>
    text !== null && regex.test(text.normalize("NFC"));
  return (
    test(COUNTERPARTIES, subject.counterparty) ||
    test(DESCRIPTIONS, subject.description)
  );
}
