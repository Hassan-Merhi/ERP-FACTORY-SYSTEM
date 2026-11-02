/**
 * Presentation-only classification of the already-posted company-12 2026-10-14
 * historical supplier catch-up batch. 38 goods + 48 commission journals.
 *
 * Routine /api/vouchers and /api/daybook screens are operational journals,
 * not the official general ledger. Do not apply this predicate to accounts,
 * supplier statements, cash, stock, financial statements, trial balance,
 * audited exports, event logs, direct-voucher audit, or settlement logic.
 * No voucher row is edited, deleted, made optional, or unposted.
 */
export const HISTORICAL_SUPPLIER_ROUTINE_COMPANY_ID = 12;

export interface RoutineHistoricalSupplierVoucher {
  companyId: number;
  voucherNumber: string | null;
  description: string | null;
  createdAt: string | Date | null;
}

const GOODS = /^FACTORY-IMPORT-[0-9]+(?:-[0-9]+)?$/;
const COMMISSION = /^FACTORY-COMM-[0-9]+(?:-[0-9]+)?$/;
const HISTORICAL_DATE = "2026-10-14";

function createdOn(value: string | Date | null): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** Exact legacy source identity; never match ordinary recent container journals. */
export function isInternalHistoricalSupplierCatchup(v: RoutineHistoricalSupplierVoucher): boolean {
  if (v.companyId !== HISTORICAL_SUPPLIER_ROUTINE_COMPANY_ID) return false;
  const number = v.voucherNumber ?? "";
  const goods = GOODS.test(number) &&
    (v.description ?? "").startsWith("Goods import - container ") &&
    (v.description ?? "").endsWith(" (historical supplier reconciliation)");
  const commission = COMMISSION.test(number) && createdOn(v.createdAt) === HISTORICAL_DATE;
  return goods || commission;
}

/**
 * Identical SQL predicate for the paginated routine SQL readers, using a
 * fixed trusted SQL alias. Only the two known legacy source signatures match.
 */
export function operationalHistoricalSupplierExclusionSql(
  companyId: number,
  alias: "v" | "vouchers",
): string {
  if (companyId !== HISTORICAL_SUPPLIER_ROUTINE_COMPANY_ID) return "TRUE";
  return `NOT (
    (COALESCE(${alias}.voucher_number,'') ~ '^FACTORY-IMPORT-[0-9]+(-[0-9]+)?$'
      AND COALESCE(${alias}.description,'') LIKE 'Goods import - container % (historical supplier reconciliation)')
    OR
    (COALESCE(${alias}.voucher_number,'') ~ '^FACTORY-COMM-[0-9]+(-[0-9]+)?$'
      AND ${alias}.created_at >= TIMESTAMP '2026-10-14'
      AND ${alias}.created_at < TIMESTAMP '2026-10-15')
  )`;
}
