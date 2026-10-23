// The rule matcher (F-014, D-012), pure. A rule looks at one text field of
// a transaction (counterparty or description) and optionally at its sign and
// absolute amount; rules run by priority (lower first, then creation order)
// and the first match wins.
//
// `contains` and `equals` compare case-insensitively after collapsing
// whitespace; `regex` is a JavaScript regular expression with the `i` flag
// on the raw text. A pattern that does not compile never matches (F-015
// validates patterns when they are saved).

export type RuleMatchField = "counterparty" | "description";
export type RuleMatchType = "contains" | "equals" | "regex";
export type RuleAmountSign = "debit" | "credit";

export interface CategoryRule {
  id: string;
  categoryId: string;
  matchField: RuleMatchField;
  matchType: RuleMatchType;
  pattern: string;
  priority: number;
  /** Null: either sign. */
  amountSign: RuleAmountSign | null;
  /** Inclusive bounds on the absolute amount (minor units); null: open. */
  amountMinMinor: number | null;
  amountMaxMinor: number | null;
  /** Breaks ties between equal priorities. */
  createdAt: Date;
}

export interface RuleSubject {
  amountMinor: number;
  counterparty: string | null;
  description: string | null;
}

/** Lower-case with runs of whitespace as one space, trimmed. */
export function normalizeText(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

export interface CompiledRule {
  rule: CategoryRule;
  test: (text: string) => boolean;
}

/** Orders the rules (priority, created, id) and compiles their patterns. */
export function compileRules(rules: readonly CategoryRule[]): CompiledRule[] {
  return [...rules]
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    )
    .map((rule) => ({ rule, test: textTest(rule) }));
}

function textTest(rule: CategoryRule): (text: string) => boolean {
  if (rule.matchType === "regex") {
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, "i");
    } catch {
      return () => false;
    }
    return (text) => regex.test(text);
  }
  const pattern = normalizeText(rule.pattern);
  if (pattern === "") return () => false;
  return rule.matchType === "equals"
    ? (text) => normalizeText(text) === pattern
    : (text) => normalizeText(text).includes(pattern);
}

function amountMatches(rule: CategoryRule, amountMinor: number): boolean {
  if (rule.amountSign === "debit" && amountMinor >= 0) return false;
  if (rule.amountSign === "credit" && amountMinor <= 0) return false;
  const absolute = Math.abs(amountMinor);
  if (rule.amountMinMinor !== null && absolute < rule.amountMinMinor) {
    return false;
  }
  if (rule.amountMaxMinor !== null && absolute > rule.amountMaxMinor) {
    return false;
  }
  return true;
}

/** The first rule that matches, or null. */
export function matchRule(
  rules: readonly CompiledRule[],
  subject: RuleSubject,
): CategoryRule | null {
  for (const { rule, test } of rules) {
    const text = subject[rule.matchField];
    if (text === null || text === "") continue;
    if (!amountMatches(rule, subject.amountMinor)) continue;
    if (test(text)) return rule;
  }
  return null;
}

export interface CategorizedSubject extends RuleSubject {
  categoryId: string | null;
  categorySource: "none" | "rule" | "manual";
  transferGroupId: string | null;
}

export type RuleOutcome =
  | { change: false }
  | {
      change: true;
      categoryId: string | null;
      categorySource: "rule" | "none";
    };

/**
 * What the rules make of a stored transaction: a manual category always
 * wins and a transfer keeps its Transfers category (no change); otherwise
 * the first matching rule's category, or none. Unchanged values are no change.
 */
export function ruleOutcome(
  rules: readonly CompiledRule[],
  txn: CategorizedSubject,
): RuleOutcome {
  if (txn.categorySource === "manual" || txn.transferGroupId !== null) {
    return { change: false };
  }
  const rule = matchRule(rules, txn);
  const categoryId = rule?.categoryId ?? null;
  const categorySource = rule ? "rule" : "none";
  if (txn.categoryId === categoryId && txn.categorySource === categorySource) {
    return { change: false };
  }
  return { change: true, categoryId, categorySource };
}
