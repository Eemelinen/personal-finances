"use client";

import { useActionState, useId, useState } from "react";
import { Textarea } from "@/components/form-controls";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/format";
import type { NameSuggestion } from "@/server/categorization/household";
import {
  addNameVariantAction,
  saveHouseholdAction,
  saveHouseholdToggleAction,
  type HouseholdResult,
} from "./actions";

// Settings → Household (F-030): the toggle that leaves transactions with
// household members out of the reports, the suggested name variants
// (F-035) and the lists of own name variants and household members (one
// name or IBAN per line). The lists are controlled, so the form keeps what
// was typed after a failed save; when the saved lists change (this form or
// an added suggestion), it shows them.

export function HouseholdToggle({
  ignoreHouseholdTransfers,
}: {
  ignoreHouseholdTransfers: boolean;
}) {
  const id = useId();
  const [result, action, pending] = useActionState(
    saveHouseholdToggleAction,
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-4 rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <input
          id={`${id}-ignore`}
          type="checkbox"
          name="ignoreHouseholdTransfers"
          defaultChecked={ignoreHouseholdTransfers}
          aria-describedby={`${id}-ignore-help`}
          className="mt-0.5"
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-ignore`} className="text-sm font-medium">
            Ignore transfers with household members
          </label>
          <p id={`${id}-ignore-help`} className="text-muted-foreground text-sm">
            On, money a household member sends you (such as contributions to
            shared costs) is not income and money you send them is not spending:
            those transactions are left out of the reports and the dashboard in
            both directions. Card purchases on a joint account still count,
            because their counterparty is the shop.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {result?.ok && !pending && (
          <p role="status" className="text-sm">
            Saved.
          </p>
        )}
      </div>
    </form>
  );
}

interface MemberDraft {
  key: number;
  names: string;
  ibans: string;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function changes(result: { transfers: number; household: number }): string {
  return `${plural(result.transfers, "transaction", "transactions")} linked as own transfers; ${plural(result.household, "transaction", "transactions")} changed household mark.`;
}

function savedMessage(result: Extract<HouseholdResult, { ok: true }>): string {
  return `Saved. ${changes(result)}`;
}

export function NameSuggestions({
  suggestions,
}: {
  suggestions: NameSuggestion[];
}) {
  const id = useId();
  const [result, action, pending] = useActionState(addNameVariantAction, null);
  // Stays after the last suggestion is added, to show what that changed.
  if (suggestions.length === 0 && result === null) return null;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-xl border p-4"
    >
      <h2 id={`${id}-title`} className="text-lg font-medium">
        Possible name variants
      </h2>
      <p className="text-muted-foreground text-sm">
        These counterparties look like one of the names below written with
        initials, or like a joint account’s name made of them. Nothing is
        matched until you add one, so check that it really is that person: a
        relative can share the initials.
      </p>
      {result && !pending && (
        <p
          role={result.ok ? "status" : "alert"}
          className={result.ok ? "text-sm" : "text-destructive text-sm"}
        >
          {result.ok
            ? `Added “${result.variant}”. ${changes(result)}`
            : result.error}
        </p>
      )}
      {suggestions.length === 0 ? (
        <p className="text-muted-foreground text-sm">No more suggestions.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {suggestions.map((suggestion) => (
            <li
              key={suggestion.counterparty}
              data-testid="name-suggestion"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">{suggestion.counterparty}</span>
                <span className="text-muted-foreground text-sm tabular-nums">
                  {[
                    plural(suggestion.rows, "transaction", "transactions"),
                    suggestion.creditMinor !== 0 &&
                      `${formatMoney(suggestion.creditMinor, "EUR")} in`,
                    suggestion.debitMinor !== 0 &&
                      `${formatMoney(suggestion.debitMinor, "EUR")} out`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {suggestion.targets.map((target) => {
                  const value =
                    target.kind === "own" ? "own" : `member:${target.index}`;
                  return (
                    <form key={value} action={action}>
                      <input
                        type="hidden"
                        name="variant"
                        value={suggestion.counterparty}
                      />
                      <input type="hidden" name="target" value={value} />
                      <Button
                        type="submit"
                        variant="outline"
                        disabled={pending}
                      >
                        {target.kind === "own"
                          ? "Add to your names"
                          : `Add to ${target.label}`}
                      </Button>
                    </form>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HouseholdLists({
  ownNames: initialOwnNames,
  members: initialMembers,
}: {
  /** One name per line. */
  ownNames: string;
  members: { names: string; ibans: string }[];
}) {
  const id = useId();
  const [ownNames, setOwnNames] = useState(initialOwnNames);
  const [members, setMembers] = useState<MemberDraft[]>(() =>
    initialMembers.map((member, key) => ({ key, ...member })),
  );
  const [nextKey, setNextKey] = useState(initialMembers.length);
  const [result, action, pending] = useActionState(saveHouseholdAction, null);
  // The saved lists changed (saved here or a suggestion added): show them.
  const saved = JSON.stringify([initialOwnNames, initialMembers]);
  const [shown, setShown] = useState(saved);
  if (shown !== saved) {
    setShown(saved);
    setOwnNames(initialOwnNames);
    setMembers(
      initialMembers.map((member, index) => ({
        key: nextKey + index,
        ...member,
      })),
    );
    setNextKey(nextKey + initialMembers.length);
  }

  const change = (key: number, field: "names" | "ibans", value: string) =>
    setMembers((current) =>
      current.map((member) =>
        member.key === key ? { ...member, [field]: value } : member,
      ),
    );

  return (
    <form action={action} className="flex flex-col gap-6 rounded-xl border p-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-own`}>Your names</Label>
        <p id={`${id}-own-help`} className="text-muted-foreground text-sm">
          One per line, as banks write them (for example “Matti Meikäläinen” and
          “M Meikäläinen”). Case, punctuation and word order do not matter, but
          the whole name must match: a payment from someone else with your
          surname stays as it is. Money from or to one of these names is an own
          transfer.
        </p>
        <Textarea
          id={`${id}-own`}
          name="ownNames"
          value={ownNames}
          onChange={(event) => setOwnNames(event.target.value)}
          aria-describedby={`${id}-own-help`}
        />
      </div>
      <section
        aria-labelledby={`${id}-members`}
        className="flex flex-col gap-3"
      >
        <h2 id={`${id}-members`} className="text-lg font-medium">
          Household members
        </h2>
        <p className="text-muted-foreground text-sm">
          A transaction whose counterparty is one of a member’s names or IBANs
          gets the Household mark; it keeps its category.
        </p>
        {members.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No household members yet.
          </p>
        )}
        <ul className="flex flex-col gap-3">
          {members.map((member, index) => (
            <li
              key={member.key}
              className="flex flex-col gap-3 rounded-lg border p-3"
              data-testid="household-member"
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-${member.key}-names`}>
                  Member {index + 1}: names
                </Label>
                <Textarea
                  id={`${id}-${member.key}-names`}
                  name="memberNames"
                  value={member.names}
                  onChange={(event) =>
                    change(member.key, "names", event.target.value)
                  }
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-${member.key}-ibans`}>
                  Member {index + 1}: IBANs
                </Label>
                <Textarea
                  id={`${id}-${member.key}-ibans`}
                  name="memberIbans"
                  value={member.ibans}
                  onChange={(event) =>
                    change(member.key, "ibans", event.target.value)
                  }
                />
              </div>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setMembers((current) =>
                      current.filter((other) => other.key !== member.key),
                    )
                  }
                >
                  Remove member {index + 1}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setMembers((current) => [
                ...current,
                { key: nextKey, names: "", ibans: "" },
              ]);
              setNextKey(nextKey + 1);
            }}
          >
            Add household member
          </Button>
        </div>
      </section>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save names and members"}
        </Button>
        {result && !pending && (
          <p
            role={result.ok ? "status" : "alert"}
            className={result.ok ? "text-sm" : "text-destructive text-sm"}
          >
            {result.ok ? savedMessage(result) : result.error}
          </p>
        )}
      </div>
    </form>
  );
}
