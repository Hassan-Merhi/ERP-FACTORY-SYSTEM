/**
 * Presentation-only identity of the 86 company-12 October-14 historical
 * supplier-reconciliation vouchers. Never apply this helper to GL postings,
 * account totals, balance engines, statements exported for audit or P&L.
 */
export interface InternalHistoricalSupplierRow {
  companyId: number | null | undefined;
  voucherNumber?: string | null;
  voucherDescription?: string | null;
  createdAt?: string | Date | null;
}

const GOODS_RE = /^FACTORY-IMPORT-[0-9]+(?:-[0-9]+)?$/;
const COMM_RE = /^FACTORY-COMM-[0-9]+(?:-[0-9]+)?$/;

export function isInternalHistoricalSupplierRoutineRow(
  row: InternalHistoricalSupplierRow,
): boolean {
  if (row.companyId !== 12) return false;
  const number = row.voucherNumber ?? "";
  const description = row.voucherDescription ?? "";
  if (GOODS_RE.test(number)
    && description.startsWith("Goods import - container ")
    && description.endsWith(" (historical supplier reconciliation)")) return true;
  if (COMM_RE.test(number) && row.createdAt != null) {
    const created = row.createdAt instanceof Date
      ? row.createdAt.toISOString().slice(0, 10)
      : String(row.createdAt).slice(0, 10);
    return created === "2026-10-14";
  }
  return false;
}
