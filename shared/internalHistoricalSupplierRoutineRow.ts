/**
 * Presentation-only identity of the 86 company-12 October-14 supplier
 * catchup vouchers and two November-03 worker-advance GL corrections.
 * Never apply this helper to GL postings,
 * account totals, balance engines, statements exported for audit or P&L.
 */
export interface InternalHistoricalSupplierRow {
  companyId?: number | null;
  voucherId?: number | null;
  voucherDate?: string | Date | null;
  voucherNumber?: string | null;
  voucherDescription?: string | null;
  createdAt?: string | Date | null;
}

const GOODS_RE = /^FACTORY-IMPORT-[0-9]+(?:-[0-9]+)?$/;
const COMM_RE = /^FACTORY-COMM-[0-9]+(?:-[0-9]+)?$/;

export function isInternalHistoricalSupplierRoutineRow(row: InternalHistoricalSupplierRow): boolean {
  if (row.companyId !== 12) return false;
  const number = row.voucherNumber ?? "";
  const description = row.voucherDescription ?? "";
  // Two exact completed worker-advance GL backfills are operational
  // system reconciliations, not manual journals. Restrict the display-only
  // match to the verified company, ID, number, date, and description.
  // NEVER apply this helper before accounting/running-balance calculations.
  const date =
    row.voucherDate instanceof Date
      ? row.voucherDate.toISOString().slice(0, 10)
      : String(row.voucherDate ?? "").slice(0, 10);
  if (
    row.voucherId === 17122 &&
    number === "JV-12-2026-000023" &&
    date === "2026-05-17" &&
    description === "Historical worker advances GL reconciliation: May 17 paid payroll #672 final cent of advance #131"
  )
    return true;
  if (
    row.voucherId === 17123 &&
    number === "JV-12-2026-000024" &&
    date === "2026-07-10" &&
    description === "Historical worker advances GL reconciliation: July 10 audited unsupported opening excess"
  )
    return true;
  if (
    GOODS_RE.test(number) &&
    description.startsWith("Goods import - container ") &&
    description.endsWith(" (historical supplier reconciliation)")
  )
    return true;
  if (COMM_RE.test(number) && row.createdAt != null) {
    const created =
      row.createdAt instanceof Date ? row.createdAt.toISOString().slice(0, 10) : String(row.createdAt).slice(0, 10);
    return created === "2026-10-14";
  }
  return false;
}
