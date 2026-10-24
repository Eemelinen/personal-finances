"use server";

import { refresh } from "next/cache";
import { verifySession } from "@/lib/auth/session";
import {
  HouseholdInputError,
  parseHouseholdForm,
  saveHousehold,
  setIgnoreHouseholdTransfers,
  type HouseholdSaveSummary,
} from "@/server/categorization/household";

// /settings/household (F-030): own name variants, household members and the
// toggle that leaves transactions with them out of the reports. Saving the
// lists re-runs categorisation; the result says how many rows changed.

export type HouseholdResult =
  ({ ok: true } & HouseholdSaveSummary) | { ok: false; error: string } | null;

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

export async function saveHouseholdAction(
  _previous: HouseholdResult,
  form: FormData,
): Promise<HouseholdResult> {
  await verifySession();
  // One names and one IBANs field per member, in the same order.
  const names = form.getAll("memberNames").map(text);
  const ibans = form.getAll("memberIbans").map(text);
  try {
    const household = parseHouseholdForm({
      ownNames: text(form.get("ownNames")),
      members: names.map((memberNames, index) => ({
        names: memberNames,
        ibans: ibans[index] ?? "",
      })),
    });
    const summary = await saveHousehold(household);
    refresh();
    return { ok: true, ...summary };
  } catch (error) {
    if (error instanceof HouseholdInputError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

export type ToggleResult = { ok: true } | null;

export async function saveHouseholdToggleAction(
  _previous: ToggleResult,
  form: FormData,
): Promise<ToggleResult> {
  await verifySession();
  // An unchecked checkbox is not in the form at all.
  await setIgnoreHouseholdTransfers(
    form.get("ignoreHouseholdTransfers") === "on",
  );
  refresh();
  return { ok: true };
}
