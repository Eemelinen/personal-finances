import { z } from "zod";
import { parseCsvAmount } from "@/server/csv/values";
import { regexError, type RuleAmountSign } from "./rules";

// Checks a rule the user enters (F-015), pure: the settings page and
// "create a rule from a transaction" send the same fields. Amount bounds
// are euros as typed (`12,50`, `12.50`, `12`) and become minor units.
// The length limits are shared with the client forms' `maxLength`.

export const MAX_PATTERN_LENGTH = 200;
/** Checked by `manage.ts` when a category is created or renamed. */
export const MAX_CATEGORY_NAME_LENGTH = 60;

export interface RuleInput {
  categoryId: string;
  matchField: "counterparty" | "description";
  matchType: "contains" | "equals" | "regex";
  pattern: string;
  amountSign: RuleAmountSign | null;
  amountMinMinor: number | null;
  amountMaxMinor: number | null;
}

export type RuleInputResult =
  { ok: true; rule: RuleInput } | { ok: false; error: string };

const fields = z.object({
  categoryId: z.uuid({ error: "Choose a category." }),
  matchField: z.enum(["counterparty", "description"], {
    error: "Choose the field to match.",
  }),
  matchType: z.enum(["contains", "equals", "regex"], {
    error: "Choose how to match.",
  }),
  pattern: z
    .string()
    .trim()
    .min(1, { error: "Enter the text to match." })
    .max(MAX_PATTERN_LENGTH, {
      error: `The pattern is longer than ${MAX_PATTERN_LENGTH} characters.`,
    }),
  amountSign: z.enum(["", "debit", "credit"]).default(""),
  amountMin: z.string().trim().default(""),
  amountMax: z.string().trim().default(""),
});

function bound(value: string, label: string): number | null | string {
  if (value === "") return null;
  let minor: number;
  try {
    minor = parseCsvAmount(value);
  } catch {
    return `The ${label} amount is not a number of euros.`;
  }
  if (minor < 0) return `The ${label} amount must not be negative.`;
  return minor;
}

export function parseRuleInput(raw: Record<string, unknown>): RuleInputResult {
  const parsed = fields.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const input = parsed.data;
  if (input.matchType === "regex") {
    const error = regexError(input.pattern);
    if (error)
      return { ok: false, error: `Invalid regular expression: ${error}` };
  }
  const min = bound(input.amountMin, "minimum");
  if (typeof min === "string") return { ok: false, error: min };
  const max = bound(input.amountMax, "maximum");
  if (typeof max === "string") return { ok: false, error: max };
  if (min !== null && max !== null && min > max) {
    return {
      ok: false,
      error: "The minimum amount is larger than the maximum.",
    };
  }
  return {
    ok: true,
    rule: {
      categoryId: input.categoryId.toLowerCase(),
      matchField: input.matchField,
      matchType: input.matchType,
      pattern: input.pattern,
      amountSign: input.amountSign === "" ? null : input.amountSign,
      amountMinMinor: min,
      amountMaxMinor: max,
    },
  };
}

export type MovePlace = "before" | "after";

/**
 * `ids` (in rule order) with `id` moved to just before or after `targetId`;
 * unchanged when either is missing or they are the same.
 */
export function moveRuleIds(
  ids: readonly string[],
  id: string,
  targetId: string,
  place: MovePlace,
): string[] {
  if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) {
    return [...ids];
  }
  const rest = ids.filter((value) => value !== id);
  const index = rest.indexOf(targetId) + (place === "after" ? 1 : 0);
  return [...rest.slice(0, index), id, ...rest.slice(index)];
}
