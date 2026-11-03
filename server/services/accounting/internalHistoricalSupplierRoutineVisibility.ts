/**
 * Presentation-only classification of company-12 internal reconciliation
 * journals. Operational Voucher / Daybook browsers use this policy; financial
 * statements, trial balance, accounting engines, source payroll data, formal
 * account statements, audit records and compliance exports MUST NOT.
 *
 * Historical cohorts:
 * - 86 completed supplier catchup journals (38 import + 48 commission).
 * - Worker-advance reconciliations #17122 and #17123 (51.61 USD combined).
 */
export const HISTORICAL_SUPPLIER_ROUTINE_COMPANY_ID = 12;

export interface RoutineHistoricalSupplierVoucher {
  companyId: number;
  voucherNumber: string | null;
  description: string | null;
  createdAt: string | Date | null;
}

export interface RoutineFactoryAdvanceReconciliationVoucher {
  companyId: number;
  id: number;
  voucherNumber: string | null;
  voucherDate: string | Date | null;
  description: string | null;
}

const GOODS = /^FACTORY-IMPORT-[0-9]+(?:-[0-9]+)?$/;
const COMMISSION = /^FACTORY-COMM-[0-9]+(?:-[0-9]+)?$/;
const HISTORICAL_DATE = "2026-10-14";

const ADVANCE_CORRECTIONS = {
  17122: {
    number: "JV-12-2026-000023",
    date: "2026-05-17",
    description: "Historical worker advances GL reconciliation: May 17 paid payroll #672 final cent of advance #131",
  },
  17123: {
    number: "JV-12-2026-000024",
    date: "2026-07-10",
    description: "Historical worker advances GL reconciliation: July 10 audited unsupported opening excess",
  },
} as const;

function createdOn(value: string | Date | null): string {
  if (!value) return "";
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

export function isInternalFactoryAdvanceReconciliation(v: RoutineFactoryAdvanceReconciliationVoucher): boolean {
  if (v.companyId !== HISTORICAL_SUPPLIER_ROUTINE_COMPANY_ID) return false;
  if (v.id !== 17122 && v.id !== 17123) return false;
  const original = ADVANCE_CORRECTIONS[v.id];
  return v.voucherNumber === original.number &&
    createdOn(v.voucherDate) === original.date &&
    v.description === original.description;
}

export function isInternalHistoricalSupplierCatchup(v: RoutineHistoricalSupplierVoucher): boolean {
  if (v.companyId !== HISTORICAL_SUPPLIER_ROUTINE_COMPANY_ID) return false;
  const number = v.voucherNumber ?? "";
  const goods =
    GOODS.test(number) &&
    (v.description ?? "").startsWith("Goods import - container ") &&
    (v.description ?? "").endsWith(" (historical supplier reconciliation)");
  const commission = COMMISSION.test(number) && createdOn(v.createdAt) === HISTORICAL_DATE;
  return goods || commission;
}

/**
 * Shared *operational listing* SQL, applied before count, pagination, export
 * and synthetic Daybook joins. Exact voucher ID+number+date+description prevent
 * hiding unrelated records. Only trusted aliases are accepted.
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
    (COALESCE(${alias}.voucher_number,'') ~ '^FACTORY-IMPORT-[0-9]+(-[0-9]+)?$'
      AND COALESCE(${alias}.description,'') LIKE 'Goods import - container % (historical supplier reconciliation)')
    OR
    (COALESCE(${alias}.voucher_number,'') ~ '^FACTORY-COMM-[0-9]+(-[0-9]+)?$'
      AND ${alias}.created_at >= TIMESTAMP '2026-10-14'
      AND ${alias}.created_at < TIMESTAMP '2026-10-15')
  )`;
}

export function operationalHistoricalSupplierGlobalExclusionSql(
  alias: "v" | "vouchers",
): string {
  return `(${alias}.company_id <> ${HISTORICAL_SUPPLIER_ROUTINE_COMPANY_ID} OR
    ${operationalHistoricalSupplierExclusionSql(HISTORICAL_SUPPLIER_ROUTINE_COMPANY_ID, alias)})`;
}
