// A small RFC 4180 reader (F-012): any one-character delimiter, quoted fields
// with `""` escapes and line breaks, CRLF / LF / CR line endings. Each record
// keeps the file line it starts on, which is the row number the import
// summary reports.

export interface CsvRecord {
  /** 1-based line of the file the record starts on. */
  line: number;
  cells: string[];
}

export class CsvSyntaxError extends Error {
  override readonly name = "CsvSyntaxError";

  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`Line ${line}: ${message}`);
  }
}

/** The delimiters bank exports use, in the order ties are broken. */
export const CSV_DELIMITERS = [";", "\t", ","] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

/** Splits `text` into records; blank lines are dropped. */
export function parseCsv(text: string, delimiter: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let line = 1;
  let recordLine = 1;
  let quoted = false;
  let quoteLine = 1;
  // Whether the current cell started with a quote and that quote closed.
  let afterQuote = false;

  const endCell = () => {
    cells.push(cell);
    cell = "";
    afterQuote = false;
  };
  const endRecord = () => {
    endCell();
    if (cells.some((value) => value.trim() !== "")) {
      records.push({ line: recordLine, cells });
    }
    cells = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        if (char === "\n" || (char === "\r" && text[i + 1] !== "\n")) line++;
        cell += char;
      }
      continue;
    }
    if (char === delimiter) {
      endCell();
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else if (char === '"' && cell.trim() === "" && !afterQuote) {
      quoted = true;
      quoteLine = line;
      cell = "";
    } else if (afterQuote) {
      // `"a"b`: text after a closing quote. Excel writes none; keep it.
      if (char.trim() !== "") cell += char;
    } else {
      cell += char;
    }
  }
  if (quoted) throw new CsvSyntaxError("unterminated quoted field", quoteLine);
  if (cell !== "" || cells.length > 0) endRecord();
  return records;
}

/**
 * The column count most records have (more than one; the wider one on a
 * tie) and how many have it.
 */
export function modalWidth(records: readonly CsvRecord[]): {
  width: number;
  count: number;
} {
  const counts = new Map<number, number>();
  for (const { cells } of records) {
    if (cells.length > 1) {
      counts.set(cells.length, (counts.get(cells.length) ?? 0) + 1);
    }
  }
  let best = { width: 0, count: 0 };
  for (const [width, count] of counts) {
    if (count > best.count || (count === best.count && width > best.width)) {
      best = { width, count };
    }
  }
  return best;
}

/**
 * The delimiter under which the most records share one column count (more
 * than one column). Preamble lines, such as an account number above the
 * header, have their own count and lose.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  let best: { delimiter: CsvDelimiter; score: number } = {
    delimiter: CSV_DELIMITERS[0],
    score: 0,
  };
  for (const delimiter of CSV_DELIMITERS) {
    let records: CsvRecord[];
    try {
      records = parseCsv(text, delimiter);
    } catch {
      continue;
    }
    const score = modalWidth(records).count;
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

/** The column count without trailing empty cells (a trailing delimiter). */
export function trimmedWidth(cells: readonly string[]): number {
  let width = cells.length;
  while (width > 0 && cells[width - 1].trim() === "") width--;
  return width;
}
