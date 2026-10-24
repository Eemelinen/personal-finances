import { describe, expect, it } from "vitest";
import {
  formatMoney,
  formatMoneyChange,
  formatMoneyRounded,
} from "@/lib/format";

// fi-FI groups thousands with a no-break space (U+00A0), puts a no-break
// space before the euro sign and writes negatives with the minus sign U+2212.
const NBSP = "\u00a0";
const MINUS = "\u2212";

describe("formatMoney", () => {
  it("formats EUR minor units as fi-FI money", () => {
    expect(formatMoney(123_456, "EUR")).toBe(`1${NBSP}234,56${NBSP}€`);
    expect(formatMoney(350_000, "EUR")).toBe(`3${NBSP}500,00${NBSP}€`);
    expect(formatMoney(12_345_678_901, "EUR")).toBe(
      `123${NBSP}456${NBSP}789,01${NBSP}€`,
    );
  });

  it("always shows two decimals, also for cents and whole euros", () => {
    expect(formatMoney(5, "EUR")).toBe(`0,05${NBSP}€`);
    expect(formatMoney(50, "EUR")).toBe(`0,50${NBSP}€`);
    expect(formatMoney(100, "EUR")).toBe(`1,00${NBSP}€`);
    expect(formatMoney(0, "EUR")).toBe(`0,00${NBSP}€`);
  });

  it("writes negative amounts with the minus sign", () => {
    expect(formatMoney(-123_456, "EUR")).toBe(`${MINUS}1${NBSP}234,56${NBSP}€`);
    expect(formatMoney(-1, "EUR")).toBe(`${MINUS}0,01${NBSP}€`);
  });

  it("groups thousands from four integer digits on", () => {
    expect(formatMoney(999_999, "EUR")).toBe(`9${NBSP}999,99${NBSP}€`);
    expect(formatMoney(99_999, "EUR")).toBe(`999,99${NBSP}€`);
  });

  it("names other currencies by their code or symbol", () => {
    expect(formatMoney(123_456, "SEK")).toBe(`1${NBSP}234,56${NBSP}SEK`);
    expect(formatMoney(-5_000, "USD")).toBe(`${MINUS}50,00${NBSP}$`);
  });
});

describe("formatMoneyChange", () => {
  it("signs gains and losses and leaves zero unsigned", () => {
    expect(formatMoneyChange(123_456, "EUR")).toBe(`+1${NBSP}234,56${NBSP}€`);
    expect(formatMoneyChange(-1_050, "EUR")).toBe(`${MINUS}10,50${NBSP}€`);
    expect(formatMoneyChange(0, "EUR")).toBe(`0,00${NBSP}€`);
  });
});

describe("formatMoneyRounded", () => {
  it("rounds to whole euros for chart axes", () => {
    expect(formatMoneyRounded(123_456, "EUR")).toBe("1 235 €");
    expect(formatMoneyRounded(0, "EUR")).toBe("0 €");
    expect(formatMoneyRounded(-50_049, "EUR")).toBe("−500 €");
  });
});
