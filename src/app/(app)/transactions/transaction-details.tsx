"use client";

import { useId, useState, useTransition } from "react";
import { Textarea } from "@/components/form-controls";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatDay, formatMoney } from "@/lib/format";
import type { CategoryOption } from "@/server/categorization/manage";
import type { TransactionRow } from "@/server/queries/transactions";
import { RuleForm, type RuleDraft } from "../settings/categories/rule-form";
import {
  excludeAction,
  includeAction,
  markAsTransfer,
  saveNote,
  unlinkTransferAction,
} from "./actions";

// The side sheet of one transaction: its texts and the counterparty's
// account number when the bank gave one (F-028), its note, excluding it from reports or
// including it again, marking it as a (one-sided) transfer or unlinking its
// transfer, and creating a rule from it.

/** As `MAX_NOTE_LENGTH` in transaction-edits.ts (server only). */
const MAX_NOTE_LENGTH = 1_000;

export function transactionTitle(row: TransactionRow): string {
  return row.counterparty || row.description || "(no description)";
}

interface TransactionDetailsProps {
  row: TransactionRow | null;
  categories: CategoryOption[];
  onClose: () => void;
}

export function TransactionDetails({
  row,
  categories,
  onClose,
}: TransactionDetailsProps) {
  return (
    <Sheet open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {row && (
          // Keyed: another transaction starts with fresh forms.
          <DetailsBody key={row.id} row={row} categories={categories} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function DetailsBody({
  row,
  categories,
}: {
  row: TransactionRow;
  categories: CategoryOption[];
}) {
  const ids = useId();
  const field = row.counterparty ? "counterparty" : "description";
  const draft: RuleDraft = {
    categoryId: row.categoryId ?? "",
    matchField: field,
    matchType: "contains",
    pattern: (row[field] ?? "").trim(),
    amountSign: "",
    amountMin: "",
    amountMax: "",
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>{transactionTitle(row)}</SheetTitle>
        <SheetDescription>
          {formatDay(row.bookingDate)} · {row.accountName} ·{" "}
          {formatMoney(row.amountMinor, row.currency)}
          {row.status === "pending" ? " · Pending" : ""}
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-6 px-4 pb-6">
        {row.counterparty && row.description && (
          <p className="text-sm">{row.description}</p>
        )}
        {row.counterpartyIban && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-sm">
            <dt className="text-muted-foreground">Account number</dt>
            <dd data-testid="counterparty-iban">
              {/* Stored without spaces; shown in groups of four. */}
              {row.counterpartyIban.replace(/(.{4})(?=.)/g, "$1 ")}
            </dd>
          </dl>
        )}
        <NoteSection row={row} />
        <ExcludeSection row={row} />
        <TransferSection row={row} />
        <section
          aria-labelledby={`${ids}-rule`}
          className="flex flex-col gap-3"
        >
          <h3 id={`${ids}-rule`} className="font-medium">
            Create a rule
          </h3>
          <p className="text-muted-foreground text-sm">
            The new rule runs before every other rule. Manually set categories
            are never changed.
          </p>
          <RuleForm
            categories={categories}
            initial={draft}
            offerApplyToPast
            submitLabel="Create rule"
          />
        </section>
      </div>
    </>
  );
}

function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (
    action: () => Promise<{ ok: true } | { ok: false; error: string }>,
    done: string,
  ) => {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) setMessage(done);
      else setError(result.error);
    });
  };
  const feedback = (
    <>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </>
  );
  return { run, pending, feedback };
}

function NoteSection({ row }: { row: TransactionRow }) {
  const ids = useId();
  const [note, setNote] = useState(row.note ?? "");
  const { run, pending, feedback } = useAction();
  return (
    <section className="flex flex-col gap-2">
      <Label htmlFor={`${ids}-note`}>Note</Label>
      <Textarea
        id={`${ids}-note`}
        value={note}
        maxLength={MAX_NOTE_LENGTH}
        onChange={(event) => setNote(event.target.value)}
      />
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => run(() => saveNote(row.id, note), "Note saved.")}
        >
          Save note
        </Button>
      </div>
      {feedback}
    </section>
  );
}

function ExcludeSection({ row }: { row: TransactionRow }) {
  const ids = useId();
  const { run, pending, feedback } = useAction();
  return (
    <section aria-labelledby={`${ids}-exclude`} className="flex flex-col gap-2">
      <h3 id={`${ids}-exclude`} className="font-medium">
        Reports
      </h3>
      {row.excluded ? (
        <>
          <p className="text-muted-foreground text-sm">
            This transaction is excluded: it is left out of spending, cash flow
            and the dashboard, but still counts in balances. Including it again
            hands it back to the rules.
          </p>
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() =>
                run(() => includeAction(row.id), "Included in reports again.")
              }
            >
              Include again
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            Leave a transaction that is not everyday income or spending (a loan
            drawdown, a home purchase, a bank correction) out of every report.
            Balances do not change.
          </p>
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() =>
                run(() => excludeAction(row.id), "Excluded from reports.")
              }
            >
              Exclude from reports
            </Button>
          </div>
        </>
      )}
      {feedback}
    </section>
  );
}

function TransferSection({ row }: { row: TransactionRow }) {
  const ids = useId();
  const { run, pending, feedback } = useAction();
  return (
    <section
      aria-labelledby={`${ids}-transfer`}
      className="flex flex-col gap-2"
    >
      <h3 id={`${ids}-transfer`} className="font-medium">
        Transfer
      </h3>
      {row.transferGroupId ? (
        <>
          <p className="text-muted-foreground text-sm">
            This is a transfer between own accounts, left out of spending and
            income. Unlinking it takes every leg out of the transfer and gives
            them their rule category, kept as set by you.
          </p>
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() =>
                run(() => unlinkTransferAction(row.id), "Transfer unlinked.")
              }
            >
              Unlink transfer
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            Mark a payment to or from an own account that is not connected (for
            example a savings account elsewhere) as a transfer.
          </p>
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() =>
                run(() => markAsTransfer(row.id), "Marked as a transfer.")
              }
            >
              Mark as transfer
            </Button>
          </div>
        </>
      )}
      {feedback}
    </section>
  );
}
