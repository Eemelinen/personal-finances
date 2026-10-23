import type { RuleAmountSign, RuleMatchField, RuleMatchType } from "./rules";

// The default categories and rules a new installation starts with (F-014).
// `seedDefaults()` writes them once, into an empty `categories` table; after
// that they are the user's to change (F-015).
//
// Merchant rules match the counterparty, which is where Finnish banks put
// the merchant of a card purchase. Short or common names are word-bounded
// regular expressions, so `VR` does not match every `…vr…`.

export type CategoryKind = "expense" | "income" | "transfer";

export interface DefaultCategory {
  name: string;
  kind: CategoryKind;
  color: string;
  children: string[];
}

/** The category own transfers get; created on demand when it is missing. */
export const TRANSFERS_CATEGORY = "Transfers";

/** The category for what no rule matched, for reports and manual picks. */
export const UNCATEGORIZED_CATEGORY = "Uncategorized";

export const DEFAULT_CATEGORIES: readonly DefaultCategory[] = [
  {
    name: "Housing",
    kind: "expense",
    color: "#8b5cf6",
    children: ["Rent & maintenance", "Electricity & heating", "Insurance"],
  },
  {
    name: "Groceries",
    kind: "expense",
    color: "#22c55e",
    children: ["Supermarkets", "Alko"],
  },
  {
    name: "Restaurants & cafés",
    kind: "expense",
    color: "#f97316",
    children: ["Restaurants", "Cafés", "Fast food", "Food delivery"],
  },
  {
    name: "Transport",
    kind: "expense",
    color: "#0ea5e9",
    children: [
      "Public transport",
      "Trains & coaches",
      "Taxi",
      "Fuel",
      "Parking",
    ],
  },
  {
    name: "Shopping",
    kind: "expense",
    color: "#ec4899",
    children: ["Department stores", "Clothing", "Electronics", "Home & DIY"],
  },
  {
    name: "Health",
    kind: "expense",
    color: "#ef4444",
    children: ["Pharmacy", "Healthcare"],
  },
  {
    name: "Subscriptions",
    kind: "expense",
    color: "#6366f1",
    children: ["Streaming", "Phone & internet"],
  },
  {
    name: "Travel",
    kind: "expense",
    color: "#14b8a6",
    children: ["Flights", "Ferries", "Accommodation"],
  },
  {
    name: "Entertainment",
    kind: "expense",
    color: "#eab308",
    children: ["Cinema & events", "Games"],
  },
  {
    name: "Income",
    kind: "income",
    color: "#16a34a",
    children: ["Salary", "Benefits", "Tax refunds"],
  },
  {
    name: "Savings & investments",
    kind: "transfer",
    color: "#0891b2",
    children: ["Investments"],
  },
  {
    name: TRANSFERS_CATEGORY,
    kind: "transfer",
    color: "#64748b",
    children: [],
  },
  {
    name: UNCATEGORIZED_CATEGORY,
    kind: "expense",
    color: "#94a3b8",
    children: [],
  },
];

export interface DefaultRule {
  /** `Parent/Child` or a top-level name. */
  category: string;
  matchField: RuleMatchField;
  matchType: RuleMatchType;
  pattern: string;
  amountSign?: RuleAmountSign;
}

const counterparty = (
  category: string,
  patterns: readonly string[],
  matchType: RuleMatchType = "contains",
): DefaultRule[] =>
  patterns.map((pattern) => ({
    category,
    matchField: "counterparty",
    matchType,
    pattern,
  }));

/** In seed order; seeded priorities step by 10 so rules fit between. */
export const DEFAULT_RULES: readonly DefaultRule[] = [
  // Groceries
  ...counterparty("Groceries/Supermarkets", [
    "S-Market",
    "Prisma",
    "K-Market",
    "K-Supermarket",
    "K-Citymarket",
    "Lidl",
    "Alepa",
    "Minimani",
    "Lähikauppa",
  ]),
  ...counterparty("Groceries/Supermarkets", ["\\bSale\\b"], "regex"),
  ...counterparty("Groceries/Alko", ["\\bAlko\\b"], "regex"),
  // Restaurants & cafés
  ...counterparty("Restaurants & cafés/Food delivery", ["Wolt", "Foodora"]),
  ...counterparty("Restaurants & cafés/Fast food", [
    "McDonald",
    "Hesburger",
    "Burger King",
    "Subway",
  ]),
  ...counterparty("Restaurants & cafés/Cafés", [
    "Robert's Coffee",
    "Espresso House",
    "Starbucks",
    "Fazer Café",
  ]),
  ...counterparty("Restaurants & cafés/Restaurants", ["Ravintola"]),
  // Transport
  ...counterparty(
    "Transport/Public transport",
    ["\\bHSL\\b", "\\bNysse\\b", "\\bFöli\\b"],
    "regex",
  ),
  ...counterparty("Transport/Trains & coaches", ["\\bVR\\b"], "regex"),
  ...counterparty("Transport/Trains & coaches", ["Matkahuolto", "OnniBus"]),
  ...counterparty("Transport/Taxi", ["Uber", "Taksi", "Yango"]),
  ...counterparty("Transport/Taxi", ["\\bBolt\\b"], "regex"),
  ...counterparty(
    "Transport/Fuel",
    ["Neste", "Teboil", "\\bSt1\\b", "\\bABC\\b"],
    "regex",
  ),
  ...counterparty("Transport/Parking", ["EasyPark", "ParkMan", "Aimo Park"]),
  // Shopping
  ...counterparty("Shopping/Department stores", [
    "Stockmann",
    "Tokmanni",
    "Clas Ohlson",
    "Halpa-Halli",
    "Puuilo",
  ]),
  ...counterparty("Shopping/Clothing", ["Zalando", "H&M", "Lindex", "KappAhl"]),
  ...counterparty("Shopping/Electronics", [
    "Verkkokauppa.com",
    "Gigantti",
    "Power.fi",
    "Jimm's",
  ]),
  ...counterparty("Shopping/Home & DIY", [
    "IKEA",
    "Bauhaus",
    "K-Rauta",
    "Motonet",
    "Biltema",
  ]),
  // Health
  ...counterparty("Health/Pharmacy", ["Apteekki"]),
  ...counterparty("Health/Healthcare", [
    "Terveystalo",
    "Mehiläinen",
    "Pihlajalinna",
  ]),
  ...counterparty("Health/Healthcare", ["\\bAava\\b"], "regex"),
  // Subscriptions
  ...counterparty("Subscriptions/Streaming", [
    "Netflix",
    "Spotify",
    "Disney",
    "HBO",
    "Viaplay",
  ]),
  ...counterparty("Subscriptions/Phone & internet", ["Elisa Oyj", "Telia"]),
  ...counterparty("Subscriptions/Phone & internet", ["\\bDNA\\b"], "regex"),
  // Travel
  ...counterparty("Travel/Flights", ["Finnair", "Norwegian", "Ryanair"]),
  ...counterparty("Travel/Ferries", ["Viking Line", "Tallink", "Eckerö"]),
  ...counterparty("Travel/Accommodation", ["Airbnb", "Booking.com", "Scandic"]),
  // Entertainment
  ...counterparty("Entertainment/Cinema & events", [
    "Finnkino",
    "Lippupiste",
    "Ticketmaster",
    "Tiketti",
  ]),
  ...counterparty("Entertainment/Games", ["Steam", "PlayStation", "Nintendo"]),
  // Housing
  ...counterparty("Housing/Electricity & heating", [
    "Helen Oy",
    "Fortum",
    "Vattenfall",
    "Oomi",
  ]),
  ...counterparty("Housing/Insurance", [
    "If Vahinkovakuutus",
    "LähiTapiola",
    "Pohjola Vakuutus",
    "Fennia",
  ]),
  ...counterparty("Housing/Insurance", ["\\bTurva\\b"], "regex"),
  {
    category: "Housing/Rent & maintenance",
    matchField: "description",
    matchType: "regex",
    pattern: "vuokra|vastike|\\brent\\b",
    amountSign: "debit",
  },
  // Income
  {
    category: "Income/Salary",
    matchField: "description",
    matchType: "regex",
    pattern: "palkka|\\bsalary\\b",
    amountSign: "credit",
  },
  {
    category: "Income/Benefits",
    matchField: "counterparty",
    matchType: "regex",
    pattern: "\\bKela\\b|Kansaneläkelaitos",
    amountSign: "credit",
  },
  {
    category: "Income/Tax refunds",
    matchField: "counterparty",
    matchType: "contains",
    pattern: "Verohallinto",
    amountSign: "credit",
  },
  // Savings & investments
  ...counterparty("Savings & investments/Investments", ["Nordnet"]),
];
