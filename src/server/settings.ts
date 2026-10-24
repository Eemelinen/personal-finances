import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/server/db/client";
import { appSettings } from "@/server/db/schema";

// Typed app settings (F-026) on top of the `app_settings` key/value table.
// Each setting has a zod schema and a default; a missing row is the
// default, so a database without rows behaves as before the setting
// existed. Add a setting by adding it to `SETTINGS`.

const SETTINGS = {
  /**
   * Whether a credit without a category (or in Uncategorized) counts as
   * income in the cash-flow report and on the dashboard (D-029). Off, it
   * is "other money in" and only income-kind categories are income.
   */
  uncategorizedCreditsAsIncome: { schema: z.boolean(), default: true },
} as const;

export type AppSettings = {
  [K in keyof typeof SETTINGS]: z.infer<(typeof SETTINGS)[K]["schema"]>;
};
export type AppSettingKey = keyof AppSettings;

export const APP_SETTING_KEYS = Object.keys(SETTINGS) as AppSettingKey[];

export const DEFAULT_APP_SETTINGS = Object.fromEntries(
  APP_SETTING_KEYS.map((key) => [key, SETTINGS[key].default]),
) as AppSettings;

/** A setting that does not exist or a value of the wrong type. */
export class AppSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppSettingError";
  }
}

function isAppSettingKey(key: string): key is AppSettingKey {
  return Object.hasOwn(SETTINGS, key);
}

/** The value checked against its setting's type; throws `AppSettingError`. */
export function parseAppSetting<K extends AppSettingKey>(
  key: K,
  value: unknown,
): AppSettings[K];
export function parseAppSetting(key: string, value: unknown): unknown;
export function parseAppSetting(key: string, value: unknown): unknown {
  if (!isAppSettingKey(key)) {
    throw new AppSettingError(`Unknown setting ${key}.`);
  }
  const result = SETTINGS[key].schema.safeParse(value);
  if (!result.success) {
    throw new AppSettingError(`Invalid value for the setting ${key}.`);
  }
  return result.data;
}

/**
 * The settings from stored rows: defaults for missing keys, unknown keys
 * ignored, and a stored value of the wrong type (an older format) logged
 * and replaced by the default rather than breaking every page.
 */
export function appSettingsFrom(
  rows: readonly { key: string; value: unknown }[],
): AppSettings {
  const settings: Record<string, unknown> = { ...DEFAULT_APP_SETTINGS };
  for (const row of rows) {
    if (!isAppSettingKey(row.key)) continue;
    try {
      settings[row.key] = parseAppSetting(row.key, row.value);
    } catch (error) {
      if (!(error instanceof AppSettingError)) throw error;
      console.warn(`app settings: ${error.message} Using the default.`);
    }
  }
  return settings as AppSettings;
}

export async function getAppSettings(db: Db = getDb()): Promise<AppSettings> {
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, APP_SETTING_KEYS));
  return appSettingsFrom(rows);
}

export async function setAppSetting<K extends AppSettingKey>(
  key: K,
  value: AppSettings[K],
  db: Db = getDb(),
): Promise<void> {
  const parsed = parseAppSetting(key, value);
  await db
    .insert(appSettings)
    .values({ key, value: parsed })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: parsed, updatedAt: sql`now()` },
    });
}
