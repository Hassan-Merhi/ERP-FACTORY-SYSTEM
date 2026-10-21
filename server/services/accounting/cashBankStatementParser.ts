/**
 * Strict customer-supplied bank/cash statements. No guessing currencies, no
 * lossy float math, no header-name dependence on one particular bank.
 *
 * CSV columns (case-insensitive): Date, Description, Reference, Amount
 * (positive = money in; negative = money out), optionally Balance.
 * Alternatively: Date, Debit, Credit (both positive), Description, Reference.
 * XLSX first sheet accepts the same columns.
 *
 * Deliberately accepts ISO or explicit day-first dates only; ambiguous US
 * month-first formats must be converted by the user.
 */
import Decimal from "decimal.js";
import { readExcel, sheetToJson } from "../../excelHelper";

export interface ParsedStatementLine {
  rowNumber: number;
  transactionDate: string;
  signedAmount: string;
  reference: string | null;
  description: string | null;
  runningBalance: string | null;
}

export class BankStatementParseError extends Error {
  constructor(
    message: string,
    public readonly code = "BANK_STATEMENT_INVALID"
  ) {
    super(message);
    this.name = "BankStatementParseError";
  }
}

function normalizeDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const s = String(value ?? "").trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  const dayFirst = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  const d = iso ?? (dayFirst ? `${dayFirst[3]}-${dayFirst[2]}-${dayFirst[1]}` : "");
  if (
    !d ||
    !Number.isFinite(Date.parse(d + "T00:00:00.000Z")) ||
    new Date(d + "T00:00:00.000Z").toISOString().slice(0, 10) !== d
  )
    throw new BankStatementParseError(`Invalid date "${s}"; use YYYY-MM-DD or DD/MM/YYYY`);
  return d;
}
export function statementDate(value: unknown): string {
  return normalizeDate(value);
}

function amt(value: unknown, allowEmpty = false): Decimal | null {
  if (value === null || value === undefined || String(value).trim() === "") {
    if (allowEmpty) return null;
    throw new BankStatementParseError("A nonempty numeric amount is required");
  }
  const raw = String(value).trim().replace(/,/g, "");
  const inParens = /^\(([0-9]+(?:\.[0-9]{1,6})?)\)$/.exec(raw);
  const sanitized = inParens ? "-" + inParens[1] : raw;
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(sanitized)) throw new BankStatementParseError(`Invalid amount "${String(value)}"`);
  const n = new Decimal(sanitized);
  if (!n.isFinite() || n.abs().gte("100000000000000"))
    throw new BankStatementParseError("Amount exceeds supported currency precision");
  return n;
}
function csvRows(buffer: Buffer): unknown[][] {
  const input = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      if (quotes && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (!quotes && cell === "") quotes = true;
      else if (quotes) quotes = false;
      else throw new BankStatementParseError("Malformed CSV quoting");
    } else if (ch === "," && !quotes) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quotes) {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (quotes) throw new BankStatementParseError("Unclosed quoted CSV cell");
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}
function key(k: string): string {
  return k
    .toLowerCase()
    .replace(/[\s_-]/g, "")
    .trim();
}
function csvObjects(data: unknown[][]): Array<Record<string, unknown>> {
  if (data.length < 2) throw new BankStatementParseError("Statement requires a header and at least one data row");
  const headers = data[0].map((h) => String(h ?? ""));
  return data.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
}
export async function parseCashBankStatement(
  file: { buffer: Buffer; originalname: string },
  periodStart: string,
  periodEnd: string
): Promise<ParsedStatementLine[]> {
  const name = file.originalname.toLowerCase();
  let objects: Array<Record<string, unknown>>;
  if (name.endsWith(".csv")) objects = csvObjects(csvRows(file.buffer));
  else if (name.endsWith(".xlsx")) {
    const book = await readExcel(file.buffer);
    if (!book.SheetNames.length) throw new BankStatementParseError("Excel workbook has no worksheets");
    objects = sheetToJson(book.Sheets[book.SheetNames[0]]);
  } else throw new BankStatementParseError("Upload a CSV or XLSX statement");
  if (!objects.length || objects.length > 5000)
    throw new BankStatementParseError("Statement must contain 1 to 5,000 transaction rows");
  const normalized = objects.map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [key(k), v])));
  const headerNames = Object.keys(normalized[0]);
  if (!headerNames.includes("date") && !headerNames.includes("transactiondate"))
    throw new BankStatementParseError("Missing Date column");
  const hasAmount = headerNames.includes("amount");
  if (!hasAmount && !headerNames.includes("debit") && !headerNames.includes("credit"))
    throw new BankStatementParseError("Missing Amount or Debit/Credit columns");
  const result: ParsedStatementLine[] = [];
  for (let idx = 0; idx < normalized.length; idx++) {
    const row = normalized[idx];
    const n = idx + 2;
    const date = normalizeDate(row.date ?? row.transactiondate);
    if (date < periodStart || date > periodEnd)
      throw new BankStatementParseError(`Row ${n}: date is outside the selected statement period`);
    let value: Decimal;
    if (hasAmount) {
      const parsed = amt(row.amount);
      if (!parsed) throw new BankStatementParseError(`Row ${n}: no amount`);
      value = parsed;
    } else {
      const credit = amt(row.credit, true) ?? new Decimal(0);
      const debit = amt(row.debit, true) ?? new Decimal(0);
      if (credit.lt(0) || debit.lt(0) || (credit.gt(0) && debit.gt(0)))
        throw new BankStatementParseError(`Row ${n}: Debit/Credit must be nonnegative and exclusive`);
      value = credit.minus(debit);
    }
    if (value.isZero()) throw new BankStatementParseError(`Row ${n}: zero transactions cannot be imported`);
    const balance = amt(row.balance ?? row.runningbalance, true);
    result.push({
      rowNumber: idx + 1,
      transactionDate: date,
      signedAmount: value.toFixed(6),
      reference:
        String(row.reference ?? row.ref ?? "")
          .trim()
          .slice(0, 500) || null,
      description:
        String(row.description ?? row.details ?? row.narration ?? "")
          .trim()
          .slice(0, 1500) || null,
      runningBalance: balance?.toFixed(6) ?? null,
    });
  }
  return result;
}
