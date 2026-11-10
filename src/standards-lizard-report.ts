import type { ComplexityFinding } from "./check-standards.js";

interface Field {
  value: string;
  next: number;
}

function quotedField(csv: string, start: number): Field | null {
  let cursor = start + 1;
  let value = "";
  for (;;) {
    const quote = csv.indexOf('"', cursor);
    if (quote === -1) return null;
    value += csv.slice(cursor, quote);
    if (csv[quote + 1] !== '"') return { value, next: quote + 1 };
    value += '"';
    cursor = quote + 2;
  }
}

function field(csv: string, start: number): Field | null {
  if (csv[start] === '"') return quotedField(csv, start);
  let next = start;
  while (next < csv.length && !",\r\n".includes(csv[next])) {
    if (csv[next] === '"') return null;
    next++;
  }
  return { value: csv.slice(start, next), next };
}

/** Read complete CSV records, including quoted commas, quotes and line breaks. */
function records(csv: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let cursor = 0;
  while (cursor < csv.length) {
    const cell = field(csv, cursor);
    if (!cell) return null;
    row.push(cell.value);
    cursor = cell.next;
    const separator = csv[cursor];
    if (separator === ",") {
      cursor++;
      if (cursor === csv.length) row.push("");
      continue;
    }
    if (separator !== undefined && separator !== "\r" && separator !== "\n") return null;
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    cursor += separator === "\r" && csv[cursor + 1] === "\n" ? 2 : 1;
  }
  if (row.length) rows.push(row);
  return rows;
}

function integer(value: string, minimum: number): boolean {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= minimum;
}

function measurement(cols: string[]): ComplexityFinding | null {
  if (cols.length !== 11) return null;
  const numeric = [0, 1, 2, 3, 4, 9, 10];
  if (!numeric.every((index) => integer(cols[index], 0))) return null;
  if (![1, 4, 9, 10].every((index) => Number(cols[index]) >= 1)) return null;
  if (![5, 6, 7, 8].every((index) => cols[index].length > 0)) return null;
  const length = Number(cols[4]);
  if (length !== Number(cols[10]) - Number(cols[9]) + 1) return null;
  return { file: cols[6], fn: cols[7], ccn: Number(cols[1]), length };
}

/** Invalid evidence rejects the whole report instead of silently dropping a function. */
export function readLizardReport(csv: string): ComplexityFinding[] | null {
  const rows = records(csv);
  if (!rows) return null;
  const findings: ComplexityFinding[] = [];
  for (const row of rows) {
    const finding = measurement(row);
    if (!finding) return null;
    findings.push(finding);
  }
  return findings;
}
