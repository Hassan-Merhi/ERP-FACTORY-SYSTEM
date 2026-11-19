// Extracted from ./registerTransporterStatementRoutesPart1.ts

/**
 * Voucher-entry rows behind the transporter statement.
 *
 * These are raw projections, so the columns keep their database names and the
 * `numeric` amounts arrive as decimal strings. Nullability follows the schema:
 * `voucher_date`, `voucher_number` and `voucher_type` are NOT NULL, while the
 * narration, description and the LEFT JOINed due date are not.
 */
export interface TransporterSummaryRow {
  id: number;
  debit_amount: string | null;
  credit_amount: string | null;
  voucher_date: string;
}

export interface TransporterStatementRow extends TransporterSummaryRow {
  voucher_id: number;
  narration: string | null;
  voucher_description: string | null;
  voucher_number: string;
  voucher_type: string;
  manual_due_date: string | null;
}

/** Allocated payment total per credit entry; `SUM(numeric)` returns a string. */
export interface AllocationTotalRow {
  credit_entry_id: number | string | null;
  paid_amount: string | null;
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Extract a container number (4 letters + 7 digits) from free text
export function extractContainerNumber(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/\b([A-Z]{4}[0-9]{7})\b/);
  return m ? m[1] : null;
}
