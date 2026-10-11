/**
 * One end-date rule for account statements and balances (wave 17 A).
 *
 * The balance engine reads "no asOf" as everything posted, future-dated
 * vouchers included, and every balance card (supplier, customer, ledger,
 * trial balance) does the same. Statements used to stop at the client's
 * today (X-Client-Date), so a statement opened without an end date footed to
 * a different figure than the balance shown beside it whenever a voucher was
 * dated ahead.
 *
 * The rule, consistent with the engine:
 *   - an explicit endDate cuts the statement there, future or not;
 *   - without an endDate the statement lists everything posted, like the
 *     balance, and each line dated after the server's business date (UTC
 *     today; never the browser's clock) is flagged `futureDated: true`; the
 *     response carries `businessDate` and `futureDatedCount`.
 */
import type { Request } from "express";
import { getClientDate } from "../../lib/dateUtils";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface StatementWindow {
  rawStart: string | undefined;
  /** The requested end date; undefined for everything posted (the engine's rule). */
  effectiveEndDate: string | undefined;
  /** The client's today, kept for display (it no longer cuts the statement). */
  asOfDate: string;
  /** The server's business date: lines after it are flagged `futureDated`. */
  businessDate: string;
}

export function statementWindow(req: Request): StatementWindow {
  const rawStart =
    typeof req.query.startDate === "string" && ISO_DATE.test(req.query.startDate) ? req.query.startDate : undefined;
  const rawEnd =
    typeof req.query.endDate === "string" && ISO_DATE.test(req.query.endDate) ? req.query.endDate : undefined;
  return { rawStart, effectiveEndDate: rawEnd, asOfDate: getClientDate(req), businessDate: serverBusinessDate() };
}

/** The server's business date (UTC today), never the browser's. */
export function serverBusinessDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateKey(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

/** The line's date, when it has one (`voucherDate`). */
function voucherDateOf(row: unknown): unknown {
  return typeof row === "object" && row !== null && "voucherDate" in row ? row.voucherDate : undefined;
}

/** Flags each line dated after `businessDate` (`futureDated: true`) and counts them. */
export function flagFutureDated<T>(rows: T[], businessDate: string): { rows: T[]; futureDatedCount: number } {
  let futureDatedCount = 0;
  const flagged = rows.map((row) => {
    if (dateKey(voucherDateOf(row)) > businessDate) {
      futureDatedCount += 1;
      return { ...row, futureDated: true as const };
    }
    return row;
  });
  return { rows: flagged, futureDatedCount };
}
