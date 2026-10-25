"use server";

import { refresh } from "next/cache";
import { verifySession } from "@/lib/auth/session";
import { reapplyRules } from "@/server/categorization/categorize";
import { setAppSetting } from "@/server/settings";

// /settings/reports (F-026): what the reports count as income, and whether
// recognised investments are left out of spending and income (F-037).
// Saving re-runs categorisation, so the investments setting takes effect on
// stored transactions; the result says how many changed category.

export type SaveResult = { ok: true; recategorized: number } | null;

export async function saveReportSettings(
  _previous: SaveResult,
  form: FormData,
): Promise<SaveResult> {
  await verifySession();
  // An unchecked checkbox is not in the form at all.
  await setAppSetting(
    "uncategorizedCreditsAsIncome",
    form.get("uncategorizedCreditsAsIncome") === "on",
  );
  await setAppSetting(
    "excludeInvestments",
    form.get("excludeInvestments") === "on",
  );
  const { recategorized } = await reapplyRules();
  refresh();
  return { ok: true, recategorized };
}
