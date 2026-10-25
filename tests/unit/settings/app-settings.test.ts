import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppSettingError,
  appSettingsFrom,
  DEFAULT_APP_SETTINGS,
  parseAppSetting,
} from "@/server/settings";

describe("appSettingsFrom", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives the defaults without rows", () => {
    expect(appSettingsFrom([])).toEqual({
      uncategorizedCreditsAsIncome: true,
      ownNames: [],
      householdMembers: [],
      ignoreHouseholdTransfers: false,
      excludeInvestments: false,
    });
    expect(DEFAULT_APP_SETTINGS.uncategorizedCreditsAsIncome).toBe(true);
    expect(DEFAULT_APP_SETTINGS.excludeInvestments).toBe(false);
  });

  it("reads stored values over the defaults and ignores unknown keys", () => {
    expect(
      appSettingsFrom([
        { key: "uncategorizedCreditsAsIncome", value: false },
        { key: "somethingElse", value: 42 },
      ]),
    ).toEqual({
      ...DEFAULT_APP_SETTINGS,
      uncategorizedCreditsAsIncome: false,
    });
  });

  it("falls back to the default for a stored value of the wrong type", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      appSettingsFrom([{ key: "uncategorizedCreditsAsIncome", value: "no" }]),
    ).toEqual(DEFAULT_APP_SETTINGS);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("uncategorizedCreditsAsIncome"),
    );
  });
});

describe("parseAppSetting", () => {
  it("returns a value of the setting's type", () => {
    expect(parseAppSetting("uncategorizedCreditsAsIncome", false)).toBe(false);
    expect(parseAppSetting("uncategorizedCreditsAsIncome", true)).toBe(true);
  });

  it("rejects a value of the wrong type", () => {
    for (const value of ["false", 0, null, undefined, {}]) {
      expect(() =>
        parseAppSetting("uncategorizedCreditsAsIncome", value),
      ).toThrow(AppSettingError);
    }
  });

  it("types excludeInvestments as a boolean", () => {
    expect(parseAppSetting("excludeInvestments", true)).toBe(true);
    for (const value of ["true", 1, null]) {
      expect(() => parseAppSetting("excludeInvestments", value)).toThrow(
        AppSettingError,
      );
    }
  });

  it("rejects an unknown setting", () => {
    expect(() => parseAppSetting("noSuchSetting", true)).toThrow(
      /Unknown setting noSuchSetting/,
    );
    expect(() => parseAppSetting("toString", true)).toThrow(AppSettingError);
  });
});
