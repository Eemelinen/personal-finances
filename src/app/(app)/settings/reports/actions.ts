"use server";

import { refresh } from "next/cache";
import { verifySession } from "@/lib/auth/session";
import { setAppSetting } from "@/server/settings";

// /settings/reports (F-026): what the reports count as income.

export type SaveResult = { ok: true } | null;

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
  refresh();
  return { ok: true };
}
