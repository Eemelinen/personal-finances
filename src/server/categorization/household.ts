import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import { transactions } from "@/server/db/schema";
import { REPORT_CURRENCY } from "@/server/queries/reports";
import { parseIban } from "@/server/iban";
import { getAppSettings, setAppSetting } from "@/server/settings";
import { reapplyRules } from "./categorize";
import { nameVariantParts, normalizeName, type HouseholdMember } from "./names";

// Settings → Household (F-030): the user's own name variants, household
// members (name variants and IBANs) and the toggle that leaves transactions
// with them out of the reports. The lists live in `app_settings`
// (`ownNames`, `householdMembers`); saving them re-runs categorisation over
// every transaction, which links own-name legs as transfers and sets or
// clears `transactions.household`. The toggle changes no transaction: the
// reports read it (`flowParts()`).
//
// Name-variant suggestions (F-035): counterparties of rows nothing has
// claimed yet (not manual, no transfer group, not household) that are a
// saved name written with initials or a joint-holder name of saved names
// (`nameVariantParts()`). Nothing is matched automatically: the user adds
// a suggestion to a person, which saves the lists as above.

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

/** Where a suggested variant can go: the own names or a member's names. */
export type VariantTarget =
  { kind: "own" } | { kind: "member"; index: number; label: string };

export interface NameSuggestion {
  /** The counterparty as the bank writes it most often. */
  counterparty: string;
  /** Rows written this way (any spelling with the same words). */
  rows: number;
  /** Sum of their EUR credits. */
  creditMinor: number;
  /** Sum of their EUR debits: negative or zero. */
  debitMinor: number;
  /** Usually one; a name that fits several people's names lists each. */
  targets: VariantTarget[];
}

const OWN: VariantTarget = { kind: "own" };

function sameTarget(a: VariantTarget, b: VariantTarget): boolean {
  return a.kind === "own"
    ? b.kind === "own"
    : b.kind === "member" && a.index === b.index;
}

function uniqueTargets(targets: VariantTarget[]): VariantTarget[] {
  return targets.filter(
    (target, index) =>
      targets.findIndex((other) => sameTarget(other, target)) === index,
  );
}

/**
 * The suggestions, largest first (credits plus debits). A joint name of
 * two own names goes to the own names; one that involves a member goes to
 * that member.
 */
export async function listNameSuggestions(
  db: Db = getDb(),
): Promise<NameSuggestion[]> {
  const household = await getHousehold(db);
  const owners: { name: string; target: VariantTarget }[] = [
    ...household.ownNames.map((name) => ({ name, target: OWN })),
    ...household.members.flatMap((member, index) =>
      member.names.map((name) => ({
        name,
        target: {
          kind: "member" as const,
          index,
          label: member.names[0],
        },
      })),
    ),
  ];
  if (owners.length === 0) return [];
  const saved = owners.map((owner) => owner.name);

  const rows = await db
    .select({
      counterparty: transactions.counterparty,
      rows: sql<number>`count(*)::int`,
      creditMinor: sql<string>`coalesce(sum(${transactions.amountMinor}) filter (where ${transactions.amountMinor} > 0 and ${transactions.currency} = ${REPORT_CURRENCY}), 0)`,
      debitMinor: sql<string>`coalesce(sum(${transactions.amountMinor}) filter (where ${transactions.amountMinor} < 0 and ${transactions.currency} = ${REPORT_CURRENCY}), 0)`,
    })
    .from(transactions)
    .where(
      and(
        isNotNull(transactions.counterparty),
        ne(transactions.categorySource, "manual"),
        isNull(transactions.transferGroupId),
        eq(transactions.household, false),
      ),
    )
    .groupBy(transactions.counterparty);

  // Spellings with the same words are one suggestion: one variant covers them.
  const byName = new Map<
    string,
    { spellings: { counterparty: string; rows: number }[] } & Omit<
      NameSuggestion,
      "counterparty" | "targets"
    >
  >();
  for (const row of rows) {
    const key = normalizeName(row.counterparty!);
    if (key.length === 0) continue;
    const entry = byName.get(key) ?? {
      spellings: [],
      rows: 0,
      creditMinor: 0,
      debitMinor: 0,
    };
    entry.spellings.push({ counterparty: row.counterparty!, rows: row.rows });
    entry.rows += row.rows;
    entry.creditMinor += Number(row.creditMinor);
    entry.debitMinor += Number(row.debitMinor);
    byName.set(key, entry);
  }

  const suggestions: NameSuggestion[] = [];
  for (const { spellings, ...totals } of byName.values()) {
    spellings.sort(
      (a, b) => b.rows - a.rows || a.counterparty.localeCompare(b.counterparty),
    );
    const counterparty = spellings[0].counterparty;
    const parts = nameVariantParts(counterparty, saved);
    if (parts === null) continue;
    const partTargets = parts.map((names) =>
      uniqueTargets(
        owners
          .filter((owner) => names.includes(owner.name))
          .map((owner) => owner.target),
      ),
    );
    const targets =
      parts.length === 1
        ? partTargets[0]
        : partTargets.every((part) => part.some((t) => t.kind === "own"))
          ? [OWN]
          : uniqueTargets(
              partTargets.flat().filter((t) => t.kind === "member"),
            );
    suggestions.push({ counterparty, ...totals, targets });
  }
  return suggestions.sort(
    (a, b) =>
      b.creditMinor - b.debitMinor - (a.creditMinor - a.debitMinor) ||
      a.counterparty.localeCompare(b.counterparty),
  );
}

/**
 * Appends `variant` to the own names or to member `index`'s names and
 * saves the lists (`saveHousehold()`, which re-runs categorisation).
 * Throws `HouseholdInputError` for a variant the form would refuse or a
 * member that is gone.
 */
export async function addNameVariant(
  variant: string,
  target: { kind: "own" } | { kind: "member"; index: number },
  options: { db?: Db } = {},
): Promise<HouseholdSaveSummary> {
  const db = options.db ?? getDb();
  const household = await getHousehold(db);
  const form: HouseholdForm = {
    ownNames: household.ownNames.join("\n"),
    members: household.members.map((member) => ({
      names: member.names.join("\n"),
      ibans: member.ibans.join("\n"),
    })),
  };
  if (target.kind === "own") {
    form.ownNames = [form.ownNames, variant].join("\n");
  } else {
    const member = form.members[target.index];
    if (!member) {
      throw new HouseholdInputError(
        "That household member is no longer there; reload the page.",
      );
    }
    member.names = [member.names, variant].join("\n");
  }
  return saveHousehold(parseHouseholdForm(form), { db });
}
