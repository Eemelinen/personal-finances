"use client";

import {
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDay, formatMoney } from "@/lib/format";
import type { ColumnMapping, CsvFormat } from "@/server/csv/bank-csv";
import type {
  ImportAccount,
  ImportCounts,
  ImportSummary,
} from "@/server/csv/import-csv";
import { countCsv, importCsv, previewCsv, type CsvPreview } from "./actions";
import { MAX_CSV_BYTES } from "./limits";

// The upload → preview → import flow. The browser keeps the chosen file and
// sends it with each step; the server keeps nothing between them.

const FORMAT_LABELS: Record<CsvFormat | "auto", string> = {
  auto: "Detect automatically",
  nordea: "Nordea",
  "nordea-card": "Nordea credit card",
  "s-pankki": "S-Pankki",
  generic: "Other CSV (choose the columns)",
};

const MAPPING_LABELS: Record<keyof ColumnMapping, string> = {
  bookingDate: "Date column",
  amount: "Amount column",
  counterparty: "Counterparty column",
  description: "Description column",
};

const NEW_ACCOUNT = "new";

const subscribeNothing = () => () => {};

const selectClass =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 h-8 w-full min-w-0 rounded-lg border bg-transparent px-2 text-base outline-none focus-visible:ring-3 md:text-sm";

interface ImportFormProps {
  accounts: ImportAccount[];
}

export function ImportForm({ accounts }: ImportFormProps) {
  const ids = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  // Read from the input itself: a file chosen before hydration counts too.
  const chosenFile = () => fileInput.current?.files?.[0] ?? null;
  const hydrated = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  const [format, setFormat] = useState<CsvFormat | "auto">("auto");
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [account, setAccount] = useState<string>(
    accounts[0]?.id ?? NEW_ACCOUNT,
  );
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<"checking" | "savings">("checking");
  const [counts, setCounts] = useState<ImportCounts | null>(null);
  const countRequest = useRef(0);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const formData = (resolved: {
    format: CsvFormat | "auto";
    mapping: ColumnMapping | null;
  }) => {
    const data = new FormData();
    data.set("file", chosenFile()!);
    data.set("format", resolved.format);
    if (resolved.format === "generic" && resolved.mapping) {
      for (const [field, column] of Object.entries(resolved.mapping)) {
        data.set(`mapping.${field}`, column ?? "");
      }
    }
    return data;
  };

  const runPreview = (nextMapping: ColumnMapping | null) => {
    const file = chosenFile();
    if (!file) {
      setError("Choose a CSV file.");
      return;
    }
    if (file.size > MAX_CSV_BYTES) {
      setError("The file is larger than 4 MB.");
      return;
    }
    setError(null);
    setSummary(null);
    startTransition(async () => {
      const result = await previewCsv(
        formData({
          format: nextMapping ? "generic" : format,
          mapping: nextMapping,
        }),
      );
      if (!result.ok) {
        setPreview(null);
        setError(result.error);
        return;
      }
      setPreview(result.preview);
      setMapping(result.preview.mapping);
      if (!result.preview.needsMapping) {
        await runCount(result.preview, account);
      }
    });
  };

  // What an import into `target` would do; only the latest answer counts.
  const runCount = async (shown: CsvPreview, target: string) => {
    const request = ++countRequest.current;
    setCounts(null);
    const data = formData({ format: shown.format, mapping: shown.mapping });
    data.set("account", target);
    const result = await countCsv(data);
    if (request !== countRequest.current) return;
    if (result.ok) setCounts(result.counts);
    else setError(result.error);
  };

  const chooseAccount = (target: string) => {
    setAccount(target);
    if (!preview || preview.needsMapping) return;
    startTransition(() => runCount(preview, target));
  };

  const runImport = () => {
    if (!preview) return;
    // What the preview showed, even if the column choice changed since.
    const data = formData({ format: preview.format, mapping: preview.mapping });
    data.set("account", account);
    data.set("newAccountName", newName);
    data.set("newAccountType", newType);
    setError(null);
    startTransition(async () => {
      const result = await importCsv(data);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSummary(result.summary);
      setAccount(result.accountId);
      setNewName("");
      // Imported now: the same file is all in the app.
      await runCount(preview, result.accountId);
    });
  };

  const resetPreview = () => {
    setPreview(null);
    setMapping(null);
    countRequest.current++;
    setCounts(null);
    setSummary(null);
    setError(null);
  };

  const canImport =
    preview !== null &&
    !preview.needsMapping &&
    preview.rowCount > 0 &&
    (account !== NEW_ACCOUNT || newName.trim() !== "");

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby={`${ids}-file`}
        className="flex flex-col gap-4 rounded-xl border p-4"
      >
        <h2 id={`${ids}-file`} className="text-lg font-medium">
          1. Choose the export
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-upload`}>CSV file</Label>
            <Input
              id={`${ids}-upload`}
              ref={fileInput}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              onChange={resetPreview}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-format`}>Format</Label>
            <select
              id={`${ids}-format`}
              className={selectClass}
              value={format}
              onChange={(event) => {
                setFormat(event.target.value as CsvFormat | "auto");
                resetPreview();
              }}
            >
              {Object.entries(FORMAT_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <Button
            type="button"
            onClick={() => runPreview(null)}
            disabled={pending || !hydrated}
          >
            {pending && !preview ? "Reading…" : "Preview"}
          </Button>
        </div>
      </section>

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      {preview && (
        <PreviewSection
          preview={preview}
          mapping={mapping}
          onMappingChange={setMapping}
          onApplyMapping={() => runPreview(mapping)}
          pending={pending}
        />
      )}

      {preview && !preview.needsMapping && (
        <section
          aria-labelledby={`${ids}-target`}
          className="flex flex-col gap-4 rounded-xl border p-4"
        >
          <h2 id={`${ids}-target`} className="text-lg font-medium">
            3. Import into
          </h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-account`}>Account</Label>
              <select
                id={`${ids}-account`}
                className={selectClass}
                value={account}
                onChange={(event) => chooseAccount(event.target.value)}
              >
                {accounts.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.institution} · {option.name}
                    {option.manual ? " (manual)" : ""}
                  </option>
                ))}
                <option value={NEW_ACCOUNT}>New manual account…</option>
              </select>
            </div>
            {account === NEW_ACCOUNT && (
              <>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`${ids}-name`}>New account name</Label>
                  <Input
                    id={`${ids}-name`}
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    maxLength={100}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`${ids}-type`}>Account type</Label>
                  <select
                    id={`${ids}-type`}
                    className={selectClass}
                    value={newType}
                    onChange={(event) =>
                      setNewType(event.target.value as "checking" | "savings")
                    }
                  >
                    <option value="checking">Checking</option>
                    <option value="savings">Savings</option>
                  </select>
                </div>
              </>
            )}
          </div>
          <p className="text-sm" data-testid="csv-match" aria-live="polite">
            {counts
              ? `${counts.present} already in the app, ${counts.new} new, ${counts.errors} ${counts.errors === 1 ? "error" : "errors"}.`
              : "Checking the account…"}
          </p>
          <div>
            <Button
              type="button"
              onClick={runImport}
              disabled={pending || !canImport}
            >
              {pending
                ? "Importing…"
                : `Import ${preview.rowCount} ${preview.rowCount === 1 ? "row" : "rows"}`}
            </Button>
          </div>
        </section>
      )}

      {summary && <SummarySection summary={summary} />}
    </div>
  );
}

interface PreviewSectionProps {
  preview: CsvPreview;
  mapping: ColumnMapping | null;
  onMappingChange: (mapping: ColumnMapping) => void;
  onApplyMapping: () => void;
  pending: boolean;
}

function PreviewSection({
  preview,
  mapping,
  onMappingChange,
  onApplyMapping,
  pending,
}: PreviewSectionProps) {
  const ids = useId();
  const shown = preview.rows.length;
  return (
    <section
      aria-labelledby={`${ids}-preview`}
      className="flex flex-col gap-4 rounded-xl border p-4"
    >
      <h2 id={`${ids}-preview`} className="text-lg font-medium">
        2. Preview
      </h2>
      <p className="text-muted-foreground text-sm" data-testid="csv-detected">
        {preview.fileName}: {FORMAT_LABELS[preview.format]},{" "}
        {preview.encoding === "utf-8"
          ? "UTF-8"
          : preview.encoding === "windows-1252"
            ? "Windows-1252"
            : "UTF-16"}
        , {preview.rowsRead} {preview.rowsRead === 1 ? "row" : "rows"}
        {preview.needsMapping
          ? ""
          : `, ${preview.rowCount} readable, ${preview.errors.length} with errors`}
        {preview.repeated > 0 &&
          `, ${preview.repeated} repeated in the file (read once)`}
        .
      </p>

      {preview.format === "generic" && mapping && (
        <div className="flex flex-col gap-3">
          <div className="grid gap-4 sm:grid-cols-4">
            {(Object.keys(MAPPING_LABELS) as (keyof ColumnMapping)[]).map(
              (field) => (
                <div key={field} className="flex flex-col gap-2">
                  <Label htmlFor={`${ids}-${field}`}>
                    {MAPPING_LABELS[field]}
                  </Label>
                  <select
                    id={`${ids}-${field}`}
                    className={selectClass}
                    value={mapping[field] ?? ""}
                    onChange={(event) =>
                      onMappingChange({
                        ...mapping,
                        [field]: event.target.value || null,
                      })
                    }
                  >
                    <option value="">
                      {field === "bookingDate" || field === "amount"
                        ? "Choose…"
                        : "None"}
                    </option>
                    {preview.headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </div>
              ),
            )}
          </div>
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={onApplyMapping}
              disabled={pending || !mapping.bookingDate || !mapping.amount}
            >
              Update preview
            </Button>
          </div>
          {preview.needsMapping && (
            <p className="text-sm">
              Choose the date and amount columns, then update the preview.
            </p>
          )}
        </div>
      )}

      {preview.errors.length > 0 && <RowErrors errors={preview.errors} />}

      {shown > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="text-muted-foreground mb-2 text-left">
              {shown < preview.rowCount
                ? `The first ${shown} of ${preview.rowCount} rows`
                : `${preview.rowCount} ${preview.rowCount === 1 ? "row" : "rows"}`}
            </caption>
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-1 pr-3 font-medium">
                  Row
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Date
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Counterparty
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Description
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row) => (
                <tr key={row.row} className="border-b last:border-0">
                  <td className="text-muted-foreground py-1 pr-3">{row.row}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {formatDay(row.bookingDate)}
                  </td>
                  <td className="py-1 pr-3">{row.counterparty}</td>
                  <td className="py-1 pr-3">{row.description}</td>
                  <td className="py-1 text-right whitespace-nowrap tabular-nums">
                    {formatMoney(row.amountMinor, row.currency ?? "EUR")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RowErrors({ errors }: { errors: ImportSummary["errors"] }) {
  return (
    <ul className="text-destructive flex flex-col gap-1 text-sm">
      {errors.map((error) => (
        <li key={`${error.row}-${error.message}`}>
          Row {error.row}: {error.message}
        </li>
      ))}
    </ul>
  );
}

function SummarySection({ summary }: { summary: ImportSummary }) {
  const ids = useId();
  const items: [string, number][] = [
    ["Rows read", summary.rowsRead],
    ["Inserted", summary.inserted],
    ["Skipped as duplicates", summary.duplicates],
    ...(summary.repeated > 0
      ? [["Repeated in the file", summary.repeated] as [string, number]]
      : []),
    ["Errors", summary.errors.length],
  ];
  return (
    <section
      aria-labelledby={`${ids}-summary`}
      role="status"
      className="flex flex-col gap-4 rounded-xl border p-4"
      data-testid="import-summary"
    >
      <h2 id={`${ids}-summary`} className="text-lg font-medium">
        Import finished
      </h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        {items.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-lg font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {summary.errors.length > 0 && <RowErrors errors={summary.errors} />}
    </section>
  );
}
