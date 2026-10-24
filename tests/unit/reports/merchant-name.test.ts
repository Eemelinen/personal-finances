import { describe, expect, it } from "vitest";
import {
  merchantKey,
  merchantName,
  UNKNOWN_MERCHANT,
} from "@/server/reports/merchant-name";

describe("merchantName", () => {
  it("folds a chain's stores into the chain", () => {
    expect(merchantName("K-MARKET KAMPPI")).toBe("K-Market");
    expect(merchantName("K-Market Kamppi 1234")).toBe("K-Market");
    expect(merchantName("K-SUPERMARKET MUSTAPEKKA")).toBe("K-Supermarket");
    expect(merchantName("K-CITYMARKET EASTON")).toBe("K-Citymarket");
    expect(merchantName("PRISMA LAAJASALO")).toBe("Prisma");
    expect(merchantName("S-MARKET SÖRNÄINEN")).toBe("S-Market");
    expect(merchantName("ALEPA-HAKANIEMI")).toBe("Alepa");
    expect(merchantName("Sale 123 Tampere")).toBe("Sale");
    expect(merchantName("LIDL HELSINKI-KAMPPI")).toBe("Lidl");
    expect(merchantName("MCDONALDS 0451 KAMPPI")).toBe("McDonald's");
    expect(merchantName("ROBERTS COFFEE ASEMA")).toBe("Robert's Coffee");
    expect(merchantName("ABC   TOOLO")).toBe("ABC");
  });

  it("does not take a longer word for a chain", () => {
    expect(merchantName("SALES AGENCY OY")).toBe("Sales Agency");
    expect(merchantName("Alkon Kebab")).toBe("Alkon Kebab");
    expect(merchantName("Prismatic Design")).toBe("Prismatic Design");
  });

  it("drops payment processor prefixes", () => {
    expect(merchantName("SUMUP *KAHVILA PIENI")).toBe("Kahvila Pieni");
    expect(merchantName("PAYPAL *SPOTIFY")).toBe("Spotify");
    expect(merchantName("Zettle_*Cafe Regatta")).toBe("Cafe Regatta");
    expect(merchantName("IZ *K-MARKET ITIS")).toBe("K-Market");
  });

  it("drops legal forms and trailing reference numbers", () => {
    expect(merchantName("WOLT OY")).toBe("Wolt");
    expect(merchantName("Foodora AB")).toBe("Foodora");
    expect(merchantName("NETFLIX.COM INC")).toBe("Netflix.com");
    expect(merchantName("HELEN OY 123456")).toBe("Helen");
    expect(merchantName("Telia Finland Oyj")).toBe("Telia Finland");
    expect(merchantName("KAUPPA 42")).toBe("Kauppa");
  });

  it("keeps a merchant's own mixed-case spelling and title-cases capitals", () => {
    expect(merchantName("Verkkokauppa.com")).toBe("Verkkokauppa.com");
    expect(merchantName("eBay Marketplace")).toBe("eBay Marketplace");
    expect(merchantName("ÄITIYSKAUPPA ÖLJY")).toBe("Äitiyskauppa Öljy");
    expect(merchantName("KAHVILA & LEIPOMO")).toBe("Kahvila & Leipomo");
  });

  it("collapses whitespace", () => {
    expect(merchantName("  Kahvila   Pieni  ")).toBe("Kahvila Pieni");
  });

  it("falls back to the description, then to Unknown", () => {
    expect(merchantName(null, "VR VERKKOKAUPPA")).toBe("Vr Verkkokauppa");
    expect(merchantName("  ", "Lidl Kamppi")).toBe("Lidl");
    expect(merchantName(null, null)).toBe(UNKNOWN_MERCHANT);
    expect(merchantName("", "")).toBe(UNKNOWN_MERCHANT);
    expect(merchantName("SUMUP *")).toBe(UNKNOWN_MERCHANT);
  });

  it("keeps a name that is only a number", () => {
    expect(merchantName("123456")).toBe("123456");
  });
});

describe("merchantKey", () => {
  it("is the same for names that differ in case, spacing or punctuation", () => {
    expect(merchantKey("Kahvila Pieni")).toBe(merchantKey("KAHVILA  PIENI"));
    expect(merchantKey("Robert's Coffee")).toBe(merchantKey("Roberts Coffee"));
    expect(merchantKey("Kahvila Pieni")).not.toBe(merchantKey("Kahvila Iso"));
  });
});
