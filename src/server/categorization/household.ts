import { getDb, type Db } from "@/server/db/client";
import { parseIban } from "@/server/iban";
import { getAppSettings, setAppSetting } from "@/server/settings";
import { reapplyRules } from "./categorize";
import { normalizeName, type HouseholdMember } from "./names";

// Settings → Household (F-030): the user's own name variants, household
// members (name variants and IBANs) and the toggle that leaves transactions
// with them out of the reports. The lists live in `app_settings`
// (`ownNames`, `householdMembers`); saving them re-runs categorisation over
// every transaction, which links own-name legs as transfers and sets or
// clears `transactions.household`. The toggle changes no transaction: the
// reports read it (`flowParts()`).

export const MAX_NAME_LENGTH = 200;
export const MAX_NAMES = 50;
export const MAX_MEMBERS = 20;

/** Input the user can fix; its message is shown as is. */
export class HouseholdInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HouseholdInputError";
  }
}

export interface Household {
  ownNames: string[];
  members: HouseholdMember[];
}

/** The raw form: each list is text with one entry per line. */
export interface HouseholdForm {
  ownNames: string;
  members: { names: string; ibans: string }[];
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0);
}

/** Trimmed name variants; duplicates (after normalising) dropped. */
function parseNames(text: string, whose: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of lines(text)) {
    if (name.length > MAX_NAME_LENGTH) {
      throw new HouseholdInputError(
        `${whose}: a name may be at most ${MAX_NAME_LENGTH} characters.`,
      );
    }
    const normalized = normalizeName(name);
    if (normalized.length === 0) {
      throw new HouseholdInputError(`${whose}: “${name}” is not a name.`);
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    names.push(name);
  }
  if (names.length > MAX_NAMES) {
    throw new HouseholdInputError(
      `${whose}: at most ${MAX_NAMES} name variants.`,
    );
  }
  return names;
}

/** Valid IBANs, normalised; one per line (commas also separate them). */
function parseIbans(text: string, whose: string): string[] {
  const ibans = new Set<string>();
  for (const line of lines(text.replace(/[,;]/g, "\n"))) {
    const iban = parseIban(line);
    if (iban === null) {
      throw new HouseholdInputError(
        `${whose}: “${line}” is not a valid IBAN (check the country code and check digits).`,
      );
    }
    ibans.add(iban);
  }
  if (ibans.size > MAX_NAMES) {
    throw new HouseholdInputError(`${whose}: at most ${MAX_NAMES} IBANs.`);
  }
  return [...ibans];
}

/**
 * The form checked and normalised; throws `HouseholdInputError`. A member
 * with neither names nor IBANs is dropped (an empty row of the form).
 */
export function parseHouseholdForm(form: HouseholdForm): Household {
  const ownNames = parseNames(form.ownNames, "Your names");
  const members: HouseholdMember[] = [];
  form.members.forEach((raw, index) => {
    const whose = `Household member ${index + 1}`;
    const member = {
      names: parseNames(raw.names, whose),
      ibans: parseIbans(raw.ibans, whose),
    };
    if (member.names.length > 0 || member.ibans.length > 0) {
      members.push(member);
    }
  });
  if (members.length > MAX_MEMBERS) {
    throw new HouseholdInputError(`At most ${MAX_MEMBERS} household members.`);
  }
  const own = new Set(ownNames.map(normalizeName));
  const shared = members
    .flatMap((member) => member.names)
    .find((name) => own.has(normalizeName(name)));
  if (shared !== undefined) {
    throw new HouseholdInputError(
      `“${shared}” is both your name and a household member’s.`,
    );
  }
  return { ownNames, members };
}

export async function getHousehold(
  db: Db = getDb(),
): Promise<Household & { ignoreHouseholdTransfers: boolean }> {
  const settings = await getAppSettings(db);
  return {
    ownNames: settings.ownNames,
    members: settings.householdMembers,
    ignoreHouseholdTransfers: settings.ignoreHouseholdTransfers,
  };
}

export interface HouseholdSaveSummary {
  /** Transactions newly linked as own transfers. */
  transfers: number;
  /** Transactions whose household mark changed. */
  household: number;
}

/**
 * Stores the lists, then re-runs categorisation over every transaction
 * (as saving an own account does, D-032), so rows a sync categorised with
 * the old lists meanwhile are brought up to date too.
 */
export async function saveHousehold(
  household: Household,
  options: { db?: Db } = {},
): Promise<HouseholdSaveSummary> {
  const db = options.db ?? getDb();
  await db.transaction(async (tx) => {
    await setAppSetting("ownNames", household.ownNames, tx);
    await setAppSetting("householdMembers", household.members, tx);
  });
  const { transfers, household: marked } = await reapplyRules({ db });
  return { transfers, household: marked };
}

export async function setIgnoreHouseholdTransfers(
  ignore: boolean,
  options: { db?: Db } = {},
): Promise<void> {
  await setAppSetting("ignoreHouseholdTransfers", ignore, options.db);
}
