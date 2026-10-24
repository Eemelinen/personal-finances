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
import type { NordnetImportSummary } from "@/server/investments/import-nordnet";
import { MAX_CSV_BYTES } from "../import/limits";
import { importNordnet } from "./actions";

// Upload a Nordnet transaction export and show what the import did.

const subscribeNothing = () => () => {};

export function NordnetImportForm() {
  const ids = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const hydrated = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  const [summary, setSummary] = useState<NordnetImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const runImport = () => {
    const file = fileInput.current?.files?.[0];
    if (!file) {
      setError("Choose a Nordnet CSV file.");
      return;
    }
    if (file.size > MAX_CSV_BYTES) {
      setError("The file is larger than 4 MB.");
      return;
    }
    setError(null);
    setSummary(null);
    const data = new FormData();
    data.set("file", file);
    startTransition(async () => {
      const result = await importNordnet(data);
      if (result.ok) setSummary(result.summary);
      else setError(result.error);
    });
  };

  return (
    <section
      aria-labelledby={`${ids}-heading`}
      className="flex flex-col gap-4 rounded-xl border p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${ids}-heading`} className="text-lg font-medium">
          Import from Nordnet
        </h2>
        <p className="text-muted-foreground text-sm">
          In Nordnet: Sivuni → Tapahtumat ja laskelmat → choose the dates → Vie
          CSV-tiedostoon. Transactions already imported are skipped, so an
          export may overlap the previous one.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:max-w-md">
        <Label htmlFor={`${ids}-file`}>Nordnet CSV file</Label>
        <Input
          id={`${ids}-file`}
          ref={fileInput}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          onChange={() => {
            setSummary(null);
            setError(null);
          }}
        />
      </div>
      <div>
        <Button
          type="button"
          onClick={runImport}
          disabled={pending || !hydrated}
        >
          {pending ? "Importing…" : "Import"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {summary && <Summary summary={summary} />}
    </section>
  );
}

function Notes({
  title,
  notes,
}: {
  title: string;
  notes: { row: number; message: string }[];
}) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <h3 className="font-medium">{title}</h3>
      <ul className="text-muted-foreground list-disc pl-5">
        {notes.map((note) => (
          <li key={`${note.row}-${note.message}`}>
            Row {note.row}: {note.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Summary({ summary }: { summary: NordnetImportSummary }) {
  const items: [string, number][] = [
    ["Rows read", summary.rowsRead],
    ["Inserted", summary.inserted],
    ["Skipped as duplicates", summary.duplicates],
    ["Not recorded", summary.skipped.length],
    ["Errors", summary.errors.length],
  ];
  return (
    <div
      role="status"
      data-testid="nordnet-summary"
      className="flex flex-col gap-3"
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-5">
        {items.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-lg font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {summary.accounts.length > 0 && (
        <p className="text-sm">
          Accounts:{" "}
          {summary.accounts
            .map((a) => `${a.name}${a.created ? " (new)" : ""}`)
            .join(", ")}
        </p>
      )}
      {summary.oversold.length > 0 && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          More sold than bought in the imported history:{" "}
          {summary.oversold.join(", ")}. Import an export that starts before
          they were bought.
        </p>
      )}
      {summary.errors.length > 0 && (
        <Notes title="Errors" notes={summary.errors} />
      )}
      {summary.skipped.length > 0 && (
        <Notes title="Not recorded" notes={summary.skipped} />
      )}
    </div>
  );
}
