import type { CellErrorValue, CellFormulaValue, CellSharedFormulaValue, CellValue } from "exceljs";

/**
 * Typed readers for ExcelJS `CellValue`.
 *
 * `CellValue` is a wide union — plain scalars, rich text, hyperlinks, and formula
 * cells carrying both a `formula` string and a cached `result`. Callers used to
 * cast to `any` and reach for `.result` or `.formula` directly, which quietly
 * covered only the arm the author had in mind. These narrow the union instead, so
 * every arm is accounted for at the point of use.
 */

type AnyFormulaValue = CellFormulaValue | CellSharedFormulaValue;

/** True for a formula cell, whether it stores its own formula or shares one. */
function isFormulaValue(value: CellValue): value is AnyFormulaValue {
  return typeof value === "object" && value !== null && ("formula" in value || "sharedFormula" in value);
}

/** True for an Excel error, e.g. `{ error: "#DIV/0!" }` — the shape a cached error result takes. */
export function isCellErrorValue(value: unknown): value is CellErrorValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string"
  );
}

/**
 * Display text of a cell: plain strings, and formula cells whose cached result is
 * a string. Trimmed, and `""` when the cell carries no readable text.
 */
export function cellText(value: CellValue): string {
  if (typeof value === "string") return value.trim();
  if (isFormulaValue(value) && typeof value.result === "string") return value.result.trim();
  return "";
}

/**
 * Formula source of a cell, preferring an own `formula` over a `sharedFormula`,
 * and `""` when the cell holds no formula at all.
 */
export function cellFormula(value: CellValue): string {
  if (!isFormulaValue(value)) return "";
  const own = "formula" in value ? value.formula : undefined;
  if (typeof own === "string") return own;
  const shared = "sharedFormula" in value ? value.sharedFormula : undefined;
  return typeof shared === "string" ? shared : "";
}

/**
 * Textual result of a cell — a plain string cell, or a formula cell whose cached
 * result is a string. `null` for every other arm.
 *
 * KNOWN GAP, deliberately preserved: an Excel error cached by the writer arrives
 * as the object `{ error: "#DIV/0!" }`, and a cell can also hold that object
 * directly. Neither is text, so both read as `null` here and are invisible to the
 * workbook error scanners built on this function.
 *
 * That gap is not fixed here because closing it changes export behaviour rather
 * than types: the shipped supplier-partner template already carries cached
 * `#DIV/0!` (Ageing!E127:J127) and `#REF!` (Summary-Itemwise!E28,H28) results, so
 * a scanner that could see them would abort every export. `cellErrorText` below
 * is the reader those scanners need once the template is repaired.
 */
export function cellResultText(value: CellValue): string | null {
  if (isFormulaValue(value)) return typeof value.result === "string" ? value.result : null;
  return typeof value === "string" ? value : null;
}

/**
 * Every arm of a cell that can carry an Excel error code, reduced to a string:
 * a plain error cell, a formula whose cached result is an error object, a formula
 * whose cached result is a string, and a plain string cell.
 *
 * This is what the workbook error scanners are documented to do. They cannot use
 * it until the template's own cached errors are repaired — see `cellResultText`.
 */
export function cellErrorText(value: CellValue): string | null {
  if (isCellErrorValue(value)) return value.error;
  if (isFormulaValue(value)) {
    const result = value.result;
    if (isCellErrorValue(result)) return result.error;
    return typeof result === "string" ? result : null;
  }
  return typeof value === "string" ? value : null;
}
