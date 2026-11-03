/**
 * Presentation-only classification of already-posted company-12 internal
 * reconciliations: 2026-10-14 historical supplier catchup (38+48 vouchers)
 * and two 2026-11-03 posted worker-advance GL backfills (#17122/#17123).
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

/**
 * The two ALREADY POSTED, immutable company-12 worker-advance accounting
 * corrections. These are internal system reconciliations, not operator-created
 * Journal Vouchers. Routine voucher browsers / daybooks can omit them, but the
 * posted ledger, formal statements, account balances, audited exports, payroll
 * source data, and restricted audit access MUST continue to include them.
 *
 * Match the exact database IDs AND the historical number, date, description.
 * A future entry sharing a narration, company, amount, or account must not
 * accidentally be suppressed.
 */
export interface RoutineFactoryAdvanceReconciliationVoucher {
  companyId: number;
  id: number;
  voucherNumber: string | null;
  voucherDate: Date | string | null;
  description: string | null;
}

const FACTORY_ADVANCE_RECONCILIATION: Readonly<Record<number, {
  voucherNumber: string;
  date: string;
  description: string;
}>> = {
  17122: {
    voucherNumber: "JV-12-2026-000023",
    date: "2026-05-17",
    description: "Historical worker advances GL reconciliation: May 17 paid payroll #672 final cent of advance #131",
  },
  17123: {
    voucherNumber: "JV-12-2026-000024",
    date: "2026-07-10",
    description: "Historical worker advances GL reconciliation: July 10 audited unsupported opening excess",
  },
};

export function isInternalFactoryAdvanceReconciliation(v: RoutineFactoryAdvanceReconciliationVoucher): boolean {
  if (v.companyId !== HISTORICAL_SUPPLIER_ROUTINE_COMPANY_ID) return false;
  const original = FACTORY_ADVANCE_RECONCILIATION[v.id];
  return original != null
    && v.voucherNumber === original.voucherNumber
    && createdOn(v.voucherDate) === original.date
    && v.description === original.description;
}

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
    (${alias}.id = 17122
      AND ${alias}.voucher_number = 'JV-12-2026-000023'
      AND ${alias}.voucher_date = DATE '2026-05-17'
      AND ${alias}.description = 'Historical worker advances GL reconciliation: May 17 paid payroll #672 final cent of advance #131')
    OR
    (${alias}.id = 17123
      AND ${alias}.voucher_number = 'JV-12-2026-000024'
      AND ${alias}.voucher_date = DATE '2026-07-10'
      AND ${alias}.description = 'Historical worker advances GL reconciliation: July 10 audited unsupported opening excess')
    OR
    (COALESCE(${alias}.voucher_number,'') ~ '^FACTORY-IMPORT-[0-9]+(-[0-9]+)?
      AND COALESCE(${alias}.description,'') LIKE 'Goods import - container % (historical supplier reconciliation)')
    OR
    (COALESCE(${alias}.voucher_number,'') ~ '^FACTORY-COMM-[0-9]+(-[0-9]+)?$'
      AND ${alias}.created_at >= TIMESTAMP '2026-10-14'
      AND ${alias}.created_at < TIMESTAMP '2026-10-15')
  )`;
}

// Global Transaction Journal can combine several companies in one result.
// Scope the same presentation filter to company 12 *per row*, never assume
// all requested companies are the selected company.
export function operationalHistoricalSupplierGlobalExclusionSql(
  alias: "v" | "vouchers",
): string {
  return `(${alias}.company_id <> ${HISTORICAL_SUPPLIER_ROUTINE_COMPANY_ID} OR
    ${operationalHistoricalSupplierExclusionSql(HISTORICAL_SUPPLIER_ROUTINE_COMPANY_ID, alias)})`;
}

      AND COALESCE(${alias}.description,'') LIKE 'Goods import - container % (historical supplier reconciliation)')
    OR
    (COALESCE(${alias}.voucher_number,'') ~ '^FACTORY-COMM-[0-9]+(-[0-9]+)?$'
      AND ${alias}.created_at >= TIMESTAMP '2026-10-14'
      AND ${alias}.created_at < TIMESTAMP '2026-10-15')
  )`;
}

// Global Transaction Journal can combine several companies in one result.
// Scope the same presentation filter to company 12 *per row*, never assume
// all requested companies are the selected company.
export function operationalHistoricalSupplierGlobalExclusionSql(
  alias: "v" | "vouchers",
): string {
  return `(${alias}.company_id <> ${HISTORICAL_SUPPLIER_ROUTINE_COMPANY_ID} OR
    ${operationalHistoricalSupplierExclusionSql(HISTORICAL_SUPPLIER_ROUTINE_COMPANY_ID, alias)})`;
}
