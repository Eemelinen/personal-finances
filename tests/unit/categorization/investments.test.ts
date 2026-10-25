import { describe, expect, it } from "vitest";
import {
  INVESTMENT_BROKERS,
  INVESTMENT_DESCRIPTION_WORDS,
  INVESTMENT_FUND_COMPANIES,
  isInvestment,
} from "@/server/categorization/investments";

const byCounterparty = (counterparty: string | null) =>
  isInvestment({ counterparty, description: null });
const byDescription = (description: string | null) =>
  isInvestment({ counterparty: null, description });

describe("isInvestment", () => {
  it("lists the brokers, exchanges, fund companies and words of the spec", () => {
    expect(INVESTMENT_BROKERS).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(INVESTMENT_FUND_COMPANIES).toEqual(
      expect.arrayContaining([
        "Seligson",
        "Evli",
        "OP-Rahastoyhtiö",
        "Danske Invest",
        "Aktia Rahastoyhtiö",
        "S-Pankki Rahastoyhtiö",
        "Nordea Rahastot",
        "Nordea Funds",
      ]),
    );
    expect(INVESTMENT_DESCRIPTION_WORDS).toEqual([
      "MERKINTÄ",
      "rahastomerkintä",
      "LUNASTUS",
      "rahastolunastus",
    ]);
  });

  it("matches every listed name as a counterparty", () => {
    for (const name of [...INVESTMENT_BROKERS, ...INVESTMENT_FUND_COMPANIES]) {
      expect(byCounterparty(name), name).toBe(true);
    }
  });

  it("matches brokers and exchange entities inside a longer counterparty", () => {
    expect(byCounterparty("NORDNET BANK AB")).toBe(true);
    expect(byCounterparty("Payward Europe Solutions Ltd")).toBe(true);
    expect(byCounterparty("Coinbase Europe Limited")).toBe(true);
    expect(byCounterparty("Interactive  Brokers Ireland")).toBe(true);
    expect(byCounterparty("trade republic bank gmbh")).toBe(true);
  });

  it("matches fund companies", () => {
    expect(byCounterparty("Seligson & Co Rahastoyhtiö Oyj")).toBe(true);
    expect(byCounterparty("OP-RAHASTOYHTIÖ OY")).toBe(true);
    expect(byCounterparty("Danske Invest Rahastoyhtiö Oy")).toBe(true);
    expect(byCounterparty("Nordea Funds Ltd")).toBe(true);
    expect(byCounterparty("S-Pankki Rahastoyhtiö Oy")).toBe(true);
  });

  it("matches a subscription or redemption word in the description", () => {
    expect(byDescription("MERKINTÄ Synthetic Index Fund A")).toBe(true);
    expect(byDescription("merkintä 2026-10-01")).toBe(true);
    expect(byDescription("Rahastomerkintä 123456")).toBe(true);
    expect(byDescription("LUNASTUS Example Fund")).toBe(true);
    expect(byDescription("rahastolunastus")).toBe(true);
    // Decomposed Ä (NFD) is the same word.
    expect(byDescription("MERKINTÄ Fund")).toBe(true);
  });

  it("looks at the counterparty for names and the description for words", () => {
    expect(byDescription("Nordnet")).toBe(false);
    expect(byCounterparty("MERKINTÄ")).toBe(false);
    expect(
      isInvestment({ counterparty: "Example Fund", description: "MERKINTÄ" }),
    ).toBe(true);
  });

  it("does not match bank fees, shops or a name inside a longer word", () => {
    expect(byCounterparty("Nordea Bank Oyj")).toBe(false);
    expect(byCounterparty("Nordea")).toBe(false);
    expect(byCounterparty("Danske Bank A/S")).toBe(false);
    expect(byCounterparty("K-Citymarket Kamppi")).toBe(false);
    expect(byCounterparty("Krakenkeittiö Oy")).toBe(false);
    expect(byCounterparty("Superevlix")).toBe(false);
    expect(byCounterparty("Nordnetwork Oy")).toBe(false);
    expect(byDescription("Tilausmerkintä korjattu")).toBe(false);
    expect(byDescription("MERKINTÄKULU")).toBe(false);
    expect(byDescription("Ostos K-Market")).toBe(false);
    expect(isInvestment({ counterparty: null, description: null })).toBe(false);
    expect(isInvestment({ counterparty: "", description: "" })).toBe(false);
  });
});
