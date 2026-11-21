// Extracted from ./unifiedRentalAccountingService.ts
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { RentalAccountingError } from "./rentalExpenseAttributionService";
import type { RentalOriginModule } from "../accounting/unifiedAccountingFoundation";

export const d = (v: unknown) => new Decimal(String(v ?? "0"));

export const fixed = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export const key = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

export interface RentalContractRecord extends Record<string, unknown> {
  id: number;
  company_id: number;
  unit_id: number;
  module: RentalOriginModule;
  tenant_name: string;
  start_date: string;
  end_date: string | null;
  status: string;
  rental_amount: string;
  guarantee_amount: string;
  guarantee_posted_to_statement: boolean;
  guarantee_posted_amount: string | null;
  is_internal: boolean;
  linked_company_id: number | null;
  currency: string;
  unit_number: string;
  unit_type: string;
  location_group: string;
  active: boolean;
}

interface MonthlyRecord extends Record<string, unknown> {
  id: number;
  year: number;
  month: number;
  expected_amount: string;
  paid_amount: string;
  accrual_voucher_id: number | null;
  accrual_live_id: number | null;
  accrual_date: string | null;
  used_prepaid_account: boolean;
  used_advance_account: boolean;
}

interface PaymentRecord extends Record<string, unknown> {
  id: number;
  for_year: number;
  for_month: number;
  amount: string;
  currency: string;
  exchange_rate: string;
  payment_date: string;
  posting_status: string;
  payment_group_id: string | null;
  voucher_id: number | null;
  actual_voucher_id: number | null;
  voucher_number: string | null;
  note: string | null;
  ledger_row_id: number | null;
}

interface DepositRecord extends Record<string, unknown> {
  id: number;
  voucher_number: string;
  booked_on: string;
  currency: string;
  base_debit: string;
  base_credit: string;
  account_code: string | null;
}

export const isModule = (m: string): m is RentalOriginModule => ["ERP", "FACTORY", "PROPERTIES"].includes(m);

export async function contractTx(tx: DbTransaction, companyId: number, module: RentalOriginModule, contractId: number) {
  if (!Number.isSafeInteger(contractId) || contractId < 1)
    throw new RentalAccountingError("RENTAL_CONTRACT_ID_INVALID", "Invalid rental contract ID", 400);
  await assertTransactionCompanyScope(tx, companyId);
  const row = resultRows<RentalContractRecord>(
    await tx.execute(sql`
 SELECT c.id,c.company_id,c.unit_id,c.module,c.tenant_name,c.start_date::text,
  c.end_date::text,c.status,c.rental_amount::text,c.guarantee_amount::text,
  c.guarantee_posted_to_statement,c.guarantee_posted_amount::text,
  c.is_internal,c.linked_company_id,c.currency,
  u.unit_number,u.unit_type,u.location_group,u.active
 FROM property_contracts c JOIN property_units u ON u.id=c.unit_id
  AND u.company_id=c.company_id AND u.module=c.module
 WHERE c.company_id=${companyId} AND c.module=${module} AND c.id=${contractId}
 LIMIT 1
 `)
  )[0];
  if (!row)
    throw new RentalAccountingError(
      "RENTAL_CONTRACT_NOT_FOUND",
      "Rental contract not found in the selected company/module",
      404
    );
  return row;
}

// Mirror the EXISTING payment writer: shop or shared leases pay rent (tenant),
// warehouse/non-shop leases collect rent (landlord). The module alone does
// not decide the direction: ERP and Factory also rent out warehouses.
export function perspective(contract: Pick<RentalContractRecord, "unit_type" | "linked_company_id">) {
  return contract.unit_type === "SHOP" || contract.linked_company_id !== null
    ? ("TENANT" as const)
    : ("LANDLORD" as const);
}

export async function listRentalAccountingContractsTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    module: RentalOriginModule;
  }
) {
  if (!isModule(input.module)) throw new RentalAccountingError("RENTAL_MODULE_INVALID", "Invalid rental module", 400);
  await assertTransactionCompanyScope(tx, input.companyId);
  const rows = resultRows<RentalContractRecord>(
    await tx.execute(sql`
 SELECT c.id,c.company_id,c.unit_id,c.module,c.tenant_name,c.start_date::text,
  c.end_date::text,c.status,c.rental_amount::text,c.guarantee_amount::text,
  c.guarantee_posted_to_statement,c.guarantee_posted_amount::text,
  c.is_internal,c.linked_company_id,c.currency,
  u.unit_number,u.unit_type,u.location_group,u.active
 FROM property_contracts c JOIN property_units u ON u.id=c.unit_id
  AND u.company_id=c.company_id AND u.module=c.module
 WHERE c.company_id=${input.companyId} AND c.module=${input.module}
 ORDER BY CASE WHEN c.status='ACTIVE' THEN 0 ELSE 1 END,u.location_group,u.unit_number,c.id DESC
 LIMIT 500
 `)
  );
  return {
    companyId: input.companyId,
    module: input.module,
    perspective: "MIXED_BY_CONTRACT" as const,
    limitedTo: 500,
    contracts: rows.map((c) => ({
      perspective: perspective(c),
      id: Number(c.id),
      unitId: Number(c.unit_id),
      unitNumber: c.unit_number,
      unitType: c.unit_type,
      locationGroup: c.location_group,
      tenantName: c.tenant_name,
      status: c.status,
      currency: String(c.currency ?? "USD").toUpperCase(),
      monthlyRent: fixed(d(c.rental_amount)),
      startDate: c.start_date,
      endDate: c.end_date,
      internal: c.is_internal,
      linkedCompanyId: c.linked_company_id,
    })),
  };
}

export async function paymentsTx(
  tx: DbTransaction,
  companyId: number,
  module: RentalOriginModule,
  contractId: number,
  asOf: string
) {
  return resultRows<PaymentRecord>(
    await tx.execute(sql`
  SELECT p.id,p.for_year,p.for_month,p.amount::text,p.currency,
    p.exchange_rate::text,p.payment_date::text,p.posting_status,p.payment_group_id,
    p.voucher_id,v.id AS actual_voucher_id,v.voucher_number,
    p.notes AS note,p.ledger_row_id
  FROM property_payments p
  LEFT JOIN vouchers v ON v.id=p.voucher_id AND v.company_id=p.company_id
    AND v.deleted_at IS NULL AND v.optional=false
  WHERE p.company_id=${companyId} AND p.module=${module}
    AND p.contract_id=${contractId} AND (p.payment_date<=${asOf}::date OR p.posting_status='SCHEDULED')
  ORDER BY p.payment_date,p.id LIMIT 3000
 `)
  );
}

export async function monthsTx(tx: DbTransaction, companyId: number, module: RentalOriginModule, contractId: number) {
  return resultRows<MonthlyRecord>(
    await tx.execute(sql`
  SELECT m.id,m.year,m.month,m.expected_amount::text,m.paid_amount::text,
    m.accrual_voucher_id, v.id AS accrual_live_id,
    COALESCE(v.effective_date,v.voucher_date)::text AS accrual_date,
    m.used_prepaid_account,m.used_advance_account
  FROM property_monthly_ledger m
  LEFT JOIN vouchers v ON v.id=m.accrual_voucher_id
    AND v.company_id=m.company_id AND v.deleted_at IS NULL AND v.optional=false
  WHERE m.company_id=${companyId} AND m.module=${module}
   AND m.contract_id=${contractId}
  ORDER BY m.year,m.month
 `)
  );
}

export async function depositJournalTx(tx: DbTransaction, companyId: number, contractId: number, asOf: string) {
  // No broad narration match. The GUAR number format is contract-scoped in
  // rental/shared/guarantee-number.ts. Rows are actual posted GL lines, not
  // the contract's editable guaranteePosted flag or guarantee amount.
  const pattern = `^GUAR(-CASH|-RENT|-REFUND)?-[0-9]+-${contractId}$`;
  return resultRows<DepositRecord>(
    await tx.execute(sql`
  SELECT v.id,v.voucher_number,COALESCE(v.effective_date,v.voucher_date)::text AS booked_on,
   v.currency,la.code AS account_code,
   COALESCE(e.base_debit_amount,e.debit_amount,0)::text AS base_debit,
   COALESCE(e.base_credit_amount,e.credit_amount,0)::text AS base_credit
  FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id
    JOIN ledger_accounts la ON la.id=e.ledger_account_id AND la.company_id=v.company_id
  WHERE v.company_id=${companyId} AND v.deleted_at IS NULL AND v.optional=false
    AND COALESCE(v.effective_date,v.voucher_date)<=${asOf}::date
    AND v.voucher_number ~ ${pattern}
    AND (UPPER(la.code)='TENANT-DEP' OR UPPER(la.code) LIKE 'TENANT-DEP-%'
      OR UPPER(la.code)='SEC-DEP-PAID' OR UPPER(la.code) LIKE 'SEC-DEP-PAID-%')
  ORDER BY COALESCE(v.effective_date,v.voucher_date),v.id,e.id LIMIT 1000
 `)
  );
}
