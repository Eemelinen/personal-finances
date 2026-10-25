"use server";

import { refresh } from "next/cache";
import { verifySession } from "@/lib/auth/session";
import {
  addNameVariant,
  HouseholdInputError,
  parseHouseholdForm,
  saveHousehold,
  setIgnoreHouseholdTransfers,
  type HouseholdSaveSummary,
} from "@/server/categorization/household";

// /settings/household (F-030): own name variants, household members and the
// toggle that leaves transactions with them out of the reports. Saving the
// lists re-runs categorisation; the result says how many rows changed. A
// suggested name variant (F-035) is added to one person's list the same way.

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

export type VariantResult =
  | ({ ok: true; variant: string } & HouseholdSaveSummary)
  | { ok: false; error: string }
  | null;

/** `target` is `own` or `member:<index>` (the member's place in the list). */
export async function addNameVariantAction(
  _previous: VariantResult,
  form: FormData,
): Promise<VariantResult> {
  await verifySession();
  const variant = text(form.get("variant")).trim();
  const target = text(form.get("target"));
  const member = /^member:(\d+)$/.exec(target);
  try {
    if (variant === "" || (target !== "own" && member === null)) {
      throw new HouseholdInputError("Choose a suggestion.");
    }
    const summary = await addNameVariant(
      variant,
      member ? { kind: "member", index: Number(member[1]) } : { kind: "own" },
    );
    refresh();
    return { ok: true, variant, ...summary };
  } catch (error) {
    if (error instanceof HouseholdInputError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
