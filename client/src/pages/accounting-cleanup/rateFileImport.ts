/**
 * Rates files for the dated-rate import (Owner "Accounting clean-up" page,
 * card 2, and Settings → FX Rates). Pure functions: the file is read, every
 * row checked and classified against the rates already recorded; the server
 * validates again and saves (POST /api/factory/fx-rates/batch,
 * POST /api/exchange-rates/batch).
 *
 * Accepted headers (case and order free):
 *   - currency,date,rate_to_usd[,source]                  factory rate, USD per 1 unit
 *   - from_currency,to_currency,date,rate[,source]        company rate (1 from = rate to)
 *   - the prepared ECB table: date,currency,ecb_fixing_date,…,factory_rate,…
 *     (factory_rate is USD per 1 unit; for company rates it is CURRENCY → USD)
 */

export type RateFileKind = "factory" | "company";
export type RateRowStatus = "new" | "identical" | "conflict";

export interface RateFileRow {
  line: number;
  fromCurrency: string;
  /** "USD" for a factory rate (USD per 1 unit of fromCurrency). */
  toCurrency: string;
  effectiveDate: string;
  rate: string;
  source: string | null;
}

export interface RateFileError {
  line: number;
  reason: "columns" | "currency" | "date" | "future" | "rate" | "duplicate";
}

export interface ParsedRateFile {
  format: "ecb" | "factory" | "company" | null;
  rows: RateFileRow[];
  errors: RateFileError[];
}

export interface RecordedRate {
  fromCurrency: string;
  toCurrency: string;
  effectiveDate: string;
  rate: string;
  /** Higher ids were saved later: the latest manual row of a date is the one in force. */
  id: number;
}

export interface ClassifiedRateRow extends RateFileRow {
  status: RateRowStatus;
  recorded: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DECIMAL = /^\d+(\.\d+)?$/;

/** Splits one CSV line, honouring double-quoted fields. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      fields.push(current);
      current = "";
    } else current += char;
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** A canonical decimal string ("1.153900" → "1.1539", "0.50" → "0.5"), or null. */
export function canonicalDecimal(value: string): string | null {
  const text = value.trim();
  if (!DECIMAL.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const integer = whole.replace(/^0+(?=\d)/, "");
  const decimals = fraction.replace(/0+$/, "");
  return decimals ? `${integer}.${decimals}` : integer;
}

function positiveRate(value: string, scale: number): string | null {
  const canonical = canonicalDecimal(value);
  if (canonical === null || /^0(\.0*)?$/.test(canonical)) return null;
  const decimals = canonical.split(".")[1] ?? "";
  return decimals.length > scale ? null : canonical;
}

function detectFormat(header: string[]): ParsedRateFile["format"] {
  const has = (name: string) => header.includes(name);
  if (has("factory_rate") && has("currency") && has("date")) return "ecb";
  if (has("from_currency") && has("to_currency") && has("date") && has("rate")) return "company";
  if (has("currency") && has("date") && has("rate_to_usd")) return "factory";
  return null;
}

/** Reads a rates file. `today` is the last date a rate may carry (the company's business date). */
export function parseRateFile(text: string, kind: RateFileKind, today: string): ParsedRateFile {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? "").map((name) => name.toLowerCase());
  const format = detectFormat(header);
  if (!format || (kind === "factory" && format === "company")) {
    return { format: null, rows: [], errors: [{ line: 1, reason: "columns" }] };
  }
  const column = (name: string) => header.indexOf(name);
  const scale = kind === "factory" ? 8 : 6;
  const rows: RateFileRow[] = [];
  const errors: RateFileError[] = [];
  const seen = new Set<string>();

  lines.slice(1).forEach((raw, offset) => {
    const line = offset + 2;
    if (!raw.trim()) return;
    const fields = splitCsvLine(raw);
    const field = (name: string) => (column(name) >= 0 ? (fields[column(name)] ?? "") : "");
    const fromCurrency = (format === "company" ? field("from_currency") : field("currency")).toUpperCase();
    const toCurrency = format === "company" ? field("to_currency").toUpperCase() : "USD";
    const effectiveDate = field("date");
    const rateText =
      format === "ecb" ? field("factory_rate") : format === "company" ? field("rate") : field("rate_to_usd");
    const source = format === "ecb" ? `ECB ${field("ecb_fixing_date") || effectiveDate}` : field("source") || null;

    if (
      !CURRENCY.test(fromCurrency) ||
      !CURRENCY.test(toCurrency) ||
      fromCurrency === toCurrency ||
      (kind === "factory" && fromCurrency === "USD")
    ) {
      errors.push({ line, reason: "currency" });
      return;
    }
    if (!isIsoDate(effectiveDate)) {
      errors.push({ line, reason: "date" });
      return;
    }
    if (effectiveDate > today) {
      errors.push({ line, reason: "future" });
      return;
    }
    const rate = positiveRate(rateText, scale);
    if (rate === null) {
      errors.push({ line, reason: "rate" });
      return;
    }
    const key = `${fromCurrency}:${toCurrency}:${effectiveDate}`;
    if (seen.has(key)) {
      errors.push({ line, reason: "duplicate" });
      return;
    }
    seen.add(key);
    rows.push({ line, fromCurrency, toCurrency, effectiveDate, rate, source });
  });

  return { format, rows, errors };
}

/** New, identical or conflicting with the rate already recorded for that pair and date. */
export function classifyRateRows(rows: RateFileRow[], recorded: RecordedRate[]): ClassifiedRateRow[] {
  const inForce = new Map<string, RecordedRate>();
  for (const rate of recorded) {
    const key = `${rate.fromCurrency}:${rate.toCurrency}:${rate.effectiveDate.slice(0, 10)}`;
    const current = inForce.get(key);
    if (!current || rate.id > current.id) inForce.set(key, rate);
  }
  return rows.map((row) => {
    const match = inForce.get(`${row.fromCurrency}:${row.toCurrency}:${row.effectiveDate}`);
    if (!match) return { ...row, status: "new", recorded: null };
    const same = canonicalDecimal(String(match.rate)) === row.rate;
    return { ...row, status: same ? "identical" : "conflict", recorded: canonicalDecimal(String(match.rate)) };
  });
}

export function countByStatus(rows: ClassifiedRateRow[]): Record<RateRowStatus, number> {
  const counts: Record<RateRowStatus, number> = { new: 0, identical: 0, conflict: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}
