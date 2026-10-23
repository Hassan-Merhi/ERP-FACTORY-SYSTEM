/**
 * Phase 8: unified rental accounting view — ERP / Factory / Properties.
 *
 * Operational rent AR/AP (contract-month due minus actual posted allocations)
 * is kept separate from GL balances. We do not infer individual contract AR/AP
 * from an aggregated accrual journal or a shared ledger account.
 *
 * Existing voucher journals remain authoritative. A per-contract guarantee
 * voucher family and new expense-link metadata provide supporting evidence.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import { fxDay } from "../accounting/monetaryFxRates";
import { getDuePeriods, getRentalBillingDay } from "./rentalPeriodService";
import { listRentalExpenseLinksTx } from "./rentalExpenseAttributionService";
import { RentalAccountingError } from "./rentalExpenseAttributionService";
import type { RentalOriginModule } from "../accounting/unifiedAccountingFoundation";

const d = (v: unknown) => new Decimal(String(v ?? "0"));
const fixed = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const key = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
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
const isModule = (m: string): m is RentalOriginModule => ["ERP", "FACTORY", "PROPERTIES"].includes(m);
async function contractTx(tx: DbTransaction, companyId: number, module: RentalOriginModule, contractId: number) {
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
function perspective(contract: Pick<RentalContractRecord, "unit_type" | "linked_company_id">) {
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
async function paymentsTx(
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
async function monthsTx(tx: DbTransaction, companyId: number, module: RentalOriginModule, contractId: number) {
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
async function depositJournalTx(tx: DbTransaction, companyId: number, contractId: number, asOf: string) {
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
export async function rentalContractAccountingTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    module: RentalOriginModule;
    contractId: number;
    asOfDate?: string;
  }
) {
  if (!isModule(input.module)) throw new RentalAccountingError("RENTAL_MODULE_INVALID", "Invalid rental module", 400);
  const contract = await contractTx(tx, input.companyId, input.module, input.contractId);
  const date = fxDay(input.asOfDate ?? (await companyBusinessDate(input.companyId, tx)));
  const native = String(contract.currency ?? "USD")
    .trim()
    .toUpperCase();
  const until = contract.end_date && contract.end_date < date ? contract.end_date : date;
  const billDay = getRentalBillingDay(contract.start_date);
  const allDue = until < contract.start_date ? [] : getDuePeriods(contract.start_date, billDay, until);
  const [saved, payments, deposits, expenses] = await Promise.all([
    monthsTx(tx, input.companyId, input.module, input.contractId),
    paymentsTx(tx, input.companyId, input.module, input.contractId, date),
    depositJournalTx(tx, input.companyId, input.contractId, date),
    listRentalExpenseLinksTx(tx, {
      companyId: input.companyId,
      module: input.module,
      contractId: input.contractId,
      asOfDate: date,
    }),
  ]);
  const monthly = new Map(saved.map((m) => [key(Number(m.year), Number(m.month)), m]));
  const posted = new Map<string, Decimal>();
  const scheduled = new Map<string, Decimal>();
  const paymentIds = new Map<string, number[]>();
  const warnings: string[] = [];
  let postedWithoutVoucher = 0,
    foreignCurrencyRows = 0;
  for (const p of payments) {
    // A guarantee action is recorded with a null monthly ledger target and
    // must not be treated as paid rent even if its for_year/for_month match.
    if (p.ledger_row_id === null) continue;
    const c = String(p.currency || "USD")
      .trim()
      .toUpperCase();
    if (c !== native) {
      foreignCurrencyRows++;
      continue;
    }
    const k = key(p.for_year, p.for_month);
    if (p.posting_status === "POSTED" && p.payment_date <= date) {
      if (p.actual_voucher_id === null) postedWithoutVoucher++;
      posted.set(k, (posted.get(k) ?? new Decimal(0)).plus(d(p.amount)));
      paymentIds.set(k, [...(paymentIds.get(k) ?? []), Number(p.id)]);
    } else if (p.posting_status === "SCHEDULED") {
      scheduled.set(k, (scheduled.get(k) ?? new Decimal(0)).plus(d(p.amount)));
    }
  }
  const periods = allDue.map((period) => {
    const k = key(period.year, period.month);
    const stored = monthly.get(k);
    // Expected amount 0 in a pre-created advance month means not billed yet;
    // use the contract's *current* rate as a provisional fallback, flagging
    // that the contract history may have changed.
    const amount = stored && d(stored.expected_amount).gt(0) ? d(stored.expected_amount) : d(contract.rental_amount);
    const paid = posted.get(k) ?? new Decimal(0);
    const due = Decimal.max(new Decimal(0), amount.minus(paid));
    const booked = stored?.accrual_live_id !== null && stored?.accrual_live_id !== undefined;
    return {
      ledgerRowId: stored?.id ?? null,
      year: period.year,
      month: period.month,
      dueDate: period.dueDate,
      expected: fixed(amount),
      paid: fixed(paid),
      outstanding: fixed(due),
      overpayment: fixed(Decimal.max(new Decimal(0), paid.minus(amount))),
      scheduled: fixed(scheduled.get(k) ?? new Decimal(0)),
      postedPaymentIds: paymentIds.get(k) ?? [],
      accrualVoucherId: booked ? Number(stored?.accrual_live_id) : null,
      accrualStale: !!stored?.accrual_voucher_id && !booked,
      usedPrepaidAccount: !!stored?.used_prepaid_account,
      usedAdvanceAccount: !!stored?.used_advance_account,
      cachedPaid: stored?.paid_amount ?? null,
      cacheDifference: stored ? fixed(d(stored.paid_amount).minus(paid)) : null,
      status: due.isZero() ? "settled" : paid.gt(0) ? "partial" : "overdue",
    };
  });
  const dueKeys = new Set(periods.map((p) => key(p.year, p.month)));
  const advance = Array.from(posted.entries()).reduce(
    (sum, [k, amount]) => (dueKeys.has(k) ? sum : sum.plus(amount)),
    new Decimal(0)
  );
  const overpaidDue = periods.reduce((sum, p) => sum.plus(p.overpayment), new Decimal(0));
  const expected = periods.reduce((sum, p) => sum.plus(p.expected), new Decimal(0));
  const received = periods.reduce((sum, p) => sum.plus(p.paid), new Decimal(0));
  const outstanding = periods.reduce((sum, p) => sum.plus(p.outstanding), new Decimal(0));
  const scheduledPending = Array.from(scheduled.values()).reduce((a, b) => a.plus(b), new Decimal(0));
  const allocated = expenses
    .filter((e) => e.source_status === "active")
    .reduce((sum, e) => sum.plus(d(e.allocated_usd)), new Decimal(0));
  const depositSigned = deposits.reduce((sum, p) => {
    const code = String(p.account_code || "").toUpperCase();
    const liability = code === "TENANT-DEP" || code.startsWith("TENANT-DEP-");
    return sum.plus(liability ? d(p.base_credit).minus(p.base_debit) : d(p.base_debit).minus(p.base_credit));
  }, new Decimal(0));
  if (postedWithoutVoucher)
    warnings.push(
      `${postedWithoutVoucher} posted payment allocation(s) reference missing or retired vouchers; review their underlying posting.`
    );
  if (foreignCurrencyRows)
    warnings.push(
      `${foreignCurrencyRows} payment row(s) have a different currency from the contract and are excluded from native-currency rent totals.`
    );
  if (expenses.some((e) => e.source_status !== "active"))
    warnings.push(
      "Some expense attribution vouchers were retired, reversed or made optional; their amounts are not included in the current maintenance total."
    );
  if (periods.some((p) => p.accrualStale))
    warnings.push("At least one period has an accrual link to a missing or retired voucher.");
  if (periods.some((p) => p.cacheDifference !== null && !d(p.cacheDifference).isZero()))
    warnings.push(
      "Stored paid_amount cache differs from effective posted payments; this page uses posted payment rows and does not repair the cache."
    );
  if (date !== (await companyBusinessDate(input.companyId, tx)))
    warnings.push(
      "The contract's current rent, unit ownership and status are not historical snapshots. Posted payments are date-filtered; past contract terms may differ."
    );
  if (contract.linked_company_id)
    warnings.push(
      "Shared/intercompany rental: this report covers only the owning company's postings. Linked-company cash/accrual entries must be reconciled separately."
    );
  if (
    perspective(contract) === "TENANT" &&
    deposits.some((row) => {
      const code = String(row.account_code ?? "").toUpperCase();
      return code === "TENANT-DEP" || code.startsWith("TENANT-DEP-");
    })
  )
    warnings.push(
      "This tenant-side lease has deposit postings to a landlord liability account; review the original guarantee accounting before relying on the balance."
    );
  if (
    perspective(contract) === "LANDLORD" &&
    deposits.some((row) => {
      const code = String(row.account_code ?? "").toUpperCase();
      return code === "SEC-DEP-PAID" || code.startsWith("SEC-DEP-PAID-");
    })
  )
    warnings.push(
      "This landlord-side lease has deposit postings to a tenant deposit-asset account; review the original guarantee accounting before relying on the balance."
    );
  const depositPledge = fixed(d(contract.guarantee_amount));
  const depositEvidence = deposits.map((e) => ({
    voucherId: Number(e.id),
    voucherNumber: e.voucher_number,
    date: e.booked_on,
    currency: e.currency,
    accountCode: e.account_code,
    signedUsd: fixed(
      String(e.account_code).toUpperCase().startsWith("TENANT-DEP")
        ? d(e.base_credit).minus(e.base_debit)
        : d(e.base_debit).minus(e.base_credit)
    ),
  }));
  const rentalPayments = payments.map((p) => ({
    id: Number(p.id),
    date: p.payment_date,
    period: key(p.for_year, p.for_month),
    status: p.posting_status,
    amount: fixed(d(p.amount)),
    currency: p.currency,
    historicalRate: p.exchange_rate,
    voucherId: p.actual_voucher_id ? Number(p.actual_voucher_id) : null,
    voucherNumber: p.voucher_number,
    groupId: p.payment_group_id,
    isGuaranteeActivity: p.ledger_row_id === null,
    ledgerRowId: p.ledger_row_id,
  }));
  return {
    companyId: input.companyId,
    module: input.module,
    perspective: perspective(contract),
    asOfDate: date,
    contract: {
      id: Number(contract.id),
      unitId: Number(contract.unit_id),
      unitNumber: contract.unit_number,
      unitType: contract.unit_type,
      locationGroup: contract.location_group,
      tenantName: contract.tenant_name,
      status: contract.status,
      startDate: contract.start_date,
      endDate: contract.end_date,
      currency: native,
      monthlyRent: fixed(d(contract.rental_amount)),
      internal: contract.is_internal,
      linkedCompanyId: contract.linked_company_id,
    },
    totals: {
      expectedDue: fixed(expected),
      postedAgainstDue: fixed(received),
      outstanding: fixed(outstanding),
      advanceFuturePeriods: fixed(advance.plus(overpaidDue)),
      scheduledNotPosted: fixed(scheduledPending),
      maintenanceExpensesBaseUsd: fixed(allocated),
      depositPledgeNative: depositPledge,
      depositBalanceEvidenceUsd: fixed(depositSigned),
    },
    periods,
    payments: rentalPayments,
    guarantee: {
      contractPledgeNative: depositPledge,
      statementFlag: contract.guarantee_posted_to_statement,
      statedPostedNative: contract.guarantee_posted_amount,
      ledgerEvidenceUsd: fixed(depositSigned),
      vouchers: depositEvidence,
    },
    expenses: expenses.map((e) => ({
      id: Number(e.id),
      voucherId: Number(e.voucher_id),
      voucherNumber: e.voucher_number,
      category: e.category,
      amountUsd: fixed(d(e.allocated_usd)),
      note: e.note,
      sourceStatus: e.source_status ?? "active",
    })),
    warnings,
    limitations: {
      outstandingType: perspective(contract) === "LANDLORD" ? "OPERATING_RENT_AR" : "OPERATING_RENT_AP",
      notAGlBalance:
        "Outstanding rent is contract-month expected less POSTED rent payment allocations, not a reconstructed per-contract general-ledger balance. Shared accrual vouchers are linked to periods but may aggregate contracts.",
      deposit:
        "Deposit balance evidence is from contract-scoped GUAR vouchers on deposit asset/liability accounts. Native pledge and USD book balance are displayed separately; do not sum across currencies.",
      maintenance:
        "Maintenance/expense links are references to USD base debits on live posted vouchers, not extra expenses or a second accounting journal.",
      historical:
        "No reconstruction of mutable historic contract rent, edited past monthly rows or missing ledger FX; Phase 10 handles formal historical snapshot accounting.",
      cash: "Scheduled future payments do not affect paid rent or cash/bank balances; only POSTED allocations dated on/before as-of are considered.",
      guarantees:
        "Guarantee release, application and refund belong to the existing GUAR voucher lifecycle and never count as a rent payment merely because guarantee activities share the payments log.",
    },
  };
}
