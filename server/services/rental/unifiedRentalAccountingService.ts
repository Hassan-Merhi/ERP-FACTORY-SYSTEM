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
import type { DbTransaction } from "../../db";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import { fxDay } from "../accounting/monetaryFxRates";
import { getDuePeriods, getRentalBillingDay } from "./rentalPeriodService";
import { listRentalExpenseLinksTx } from "./rentalExpenseAttributionService";
import { RentalAccountingError } from "./rentalExpenseAttributionService";
import type { RentalOriginModule } from "../accounting/unifiedAccountingFoundation";
import {
  d,
  fixed,
  key,
  isModule,
  contractTx,
  perspective,
  paymentsTx,
  monthsTx,
  depositJournalTx,
} from "./unifiedRentalAccountingServiceHelpers";
export { listRentalAccountingContractsTx, type RentalContractRecord } from "./unifiedRentalAccountingServiceHelpers";

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
