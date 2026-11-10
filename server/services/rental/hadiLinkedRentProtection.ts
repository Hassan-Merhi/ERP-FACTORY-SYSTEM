/**
 * Read-only HADI L'SHI linked-rent control. A Properties rental receipt belongs
 * to company 13; the linked company's rent expense/payable belong to company 1.
 *
 * This check NEVER posts, adjusts, deletes or reclassifies vouchers. A mismatch
 * needs original-voucher review — never an automatic Dr Expense / Cr owner credit.
 */
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { ledgerAccounts, propertyContracts, propertyMonthlyLedger, propertyPayments, propertyUnits, vouchers } from "@shared/schema";
import { db } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { getRentalBillingDay, getRentalPeriodDueDate } from "./rentalPeriodService";
import { isValidRentalBusinessDate } from "./rentalPaymentClassification";
import { runWithAutoTransferCounterparties } from "./autoTransferScope";
import { HADI_LINKED_RENT, classifyHadiRentDifference, positiveRentalDue } from "./hadiRentLedgerPolicy";
export { HADI_HISTORICAL_ACCRUAL_GUARD, HADI_LINKED_RENT, isHadiHistoricAccrualRepair, classifyHadiRentDifference, positiveRentalDue } from "./hadiRentLedgerPolicy";

export interface HadiLinkedRentControl {
  asOf: string;
  payerCompanyId: number;
  propertiesCompanyId: number;
  linkedContracts: number;
  linkedExpectedAsOf: string;
  linkedPaidAsOf: string;
  linkedOutstanding: string;
  ownedShopOutstanding: string;
  accruedRentPayableCredit: string;
  /** Positive = potentially uncleared linked rents, negative = potentially excessive settlement. */
  difference: string;
  unmatchedPostedPayments: number;
  status: "MATCH" | "REVIEW";
  contracts: Array<{
    contractId: number;
    tenantName: string;
    expectedAsOf: string;
    paidAsOf: string;
    outstanding: string;
  }>;
}

function ymd(date: Date | string): string {
  return date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
}

/**
 * Only Admin/Owner/Developer with access to BOTH companies can request this.
 * Explicitly expands the authorized read scope; it never impersonates
 * the Properties owner or modifies company 13's receipts.
 */
export async function getHadiLinkedRentControl(companyId: number, asOf: string): Promise<HadiLinkedRentControl> {
  if (companyId !== HADI_LINKED_RENT.payerCompanyId) {
    throw new Error("HADI_LINKED_RENT_WRONG_COMPANY");
  }
  if (!isValidRentalBusinessDate(asOf)) {
    throw new Error("HADI_LINKED_RENT_INVALID_AS_OF_DATE");
  }
  return runWithAutoTransferCounterparties([HADI_LINKED_RENT.propertiesCompanyId], async () => {
    const linked = await db
      .select({
        id: propertyContracts.id,
        tenantName: propertyContracts.tenantName,
        startDate: propertyContracts.startDate,
      })
      .from(propertyContracts)
      .where(and(
        eq(propertyContracts.companyId, HADI_LINKED_RENT.propertiesCompanyId),
        eq(propertyContracts.linkedCompanyId, companyId),
        eq(propertyContracts.module, "PROPERTIES"),
        eq(propertyContracts.status, "ACTIVE")
      ));

    const owned = await db
      .select({ id: propertyContracts.id, startDate: propertyContracts.startDate })
      .from(propertyContracts)
      .innerJoin(propertyUnits, eq(propertyUnits.id, propertyContracts.unitId))
      .where(and(
        eq(propertyContracts.companyId, companyId),
        eq(propertyContracts.module, "ERP"),
        eq(propertyContracts.status, "ACTIVE"),
        eq(propertyUnits.unitType, "SHOP")
      ));

    const linkedIds = linked.map(c => c.id);
    const ownedIds = owned.map(c => c.id);
    const contractIds = [...linkedIds, ...ownedIds];
    const monthly = contractIds.length
      ? await db.select({
          id: propertyMonthlyLedger.id,
          contractId: propertyMonthlyLedger.contractId,
          companyId: propertyMonthlyLedger.companyId,
          year: propertyMonthlyLedger.year,
          month: propertyMonthlyLedger.month,
          expected: propertyMonthlyLedger.expectedAmount,
        }).from(propertyMonthlyLedger).where(inArray(propertyMonthlyLedger.contractId, contractIds))
      : [];

    const contractInfo = new Map<number, { companyId: number; startDate: string | Date }>();
    for (const c of linked) {
      contractInfo.set(c.id, { companyId: HADI_LINKED_RENT.propertiesCompanyId, startDate: c.startDate });
    }
    for (const c of owned) {
      contractInfo.set(c.id, { companyId, startDate: c.startDate });
    }
    const dueRows = monthly.filter(row => {
      const contract = contractInfo.get(row.contractId);
      return contract !== undefined
        && row.companyId === contract.companyId
        && getRentalPeriodDueDate(row.year, row.month, getRentalBillingDay(ymd(contract.startDate))) <= asOf;
    });
    const dueIds = dueRows.map(row => row.id);
    const posted = dueIds.length
      ? await db.select({
          ledgerRowId: propertyPayments.ledgerRowId,
          companyId: propertyPayments.companyId,
          amount: propertyPayments.amount,
        })
        .from(propertyPayments)
        .innerJoin(vouchers, and(
          eq(vouchers.id, propertyPayments.voucherId),
          eq(vouchers.companyId, propertyPayments.companyId),
          isNull(vouchers.deletedAt),
          eq(vouchers.optional, false)
        ))
        .where(and(
          inArray(propertyPayments.ledgerRowId, dueIds),
          eq(propertyPayments.postingStatus, "POSTED"),
          lte(propertyPayments.paymentDate, asOf)
        ))
      : [];

    // Missing/deleted vouchers are never counted as paid rent; flag them
    // separately so the operational arrears cannot be hidden by a stale cache.
    const allPosted = dueIds.length
      ? await db.select({
          id: propertyPayments.id,
          voucherId: propertyPayments.voucherId,
          companyId: propertyPayments.companyId,
          voucherCompanyId: vouchers.companyId,
        })
        .from(propertyPayments)
        .leftJoin(vouchers, and(
          eq(vouchers.id, propertyPayments.voucherId),
          eq(vouchers.companyId, propertyPayments.companyId),
          isNull(vouchers.deletedAt),
          eq(vouchers.optional, false)
        ))
        .where(and(
          inArray(propertyPayments.ledgerRowId, dueIds),
          eq(propertyPayments.postingStatus, "POSTED"),
          lte(propertyPayments.paymentDate, asOf)
        ))
      : [];
    const unmatchedPostedPayments = allPosted.filter(p => !p.voucherCompanyId).length;

    const postedByMonth = new Map<number, MoneyDecimal>();
    for (const p of posted) {
      if (p.ledgerRowId === null) continue;
      postedByMonth.set(p.ledgerRowId,
        (postedByMonth.get(p.ledgerRowId) ?? new MoneyDecimal(0)).plus(toMoney(p.amount)));
    }

    const byContract = new Map<number, { expected: MoneyDecimal; paid: MoneyDecimal; due: MoneyDecimal }>();
    let linkedOutstanding = new MoneyDecimal(0);
    let ownedOutstanding = new MoneyDecimal(0);
    for (const row of dueRows) {
      const old = byContract.get(row.contractId) ?? {
        expected: new MoneyDecimal(0),
        paid: new MoneyDecimal(0),
        due: new MoneyDecimal(0),
      };
      const expected = toMoney(row.expected);
      const paid = postedByMonth.get(row.id) ?? new MoneyDecimal(0);
      const due = positiveRentalDue(expected.toFixed(2), paid.toFixed(2));
      old.expected = old.expected.plus(expected);
      old.paid = old.paid.plus(paid);
      old.due = old.due.plus(due);
      byContract.set(row.contractId, old);
      if (row.companyId === HADI_LINKED_RENT.propertiesCompanyId) linkedOutstanding = linkedOutstanding.plus(due);
      else ownedOutstanding = ownedOutstanding.plus(due);
    }

    const [control] = await db.select({
      id: ledgerAccounts.id,
      name: ledgerAccounts.name,
      accountType: ledgerAccounts.accountType,
      openingBalance: ledgerAccounts.openingBalance,
      openingBalanceSide: ledgerAccounts.openingBalanceSide,
      active: ledgerAccounts.active,
      deletedAt: ledgerAccounts.deletedAt,
    }).from(ledgerAccounts).where(and(
      eq(ledgerAccounts.id, HADI_LINKED_RENT.payableLedgerId),
      eq(ledgerAccounts.companyId, companyId)
    ));
    if (!control || control.name !== "Accrued Rent Payable" ||
        control.accountType !== "Liability" || !control.active || control.deletedAt) {
      throw new Error("HADI_RENT_PAYABLE_CONTROL_CHANGED");
    }

    const result = await db.execute(sql`
      SELECT COALESCE(SUM(e.credit_amount::numeric-e.debit_amount::numeric),0) AS credit
      FROM voucher_entries e
      JOIN vouchers v ON v.id=e.voucher_id AND v.company_id=e.company_id
      WHERE e.company_id=${companyId}
        AND e.ledger_account_id=${control.id}
        AND v.deleted_at IS NULL AND v.optional=false
        AND v.voucher_date <= ${asOf}::date
    `);
    const journalCredit = toMoney(String(result.rows[0]?.credit ?? "0"));
    const opening = toMoney(control.openingBalance ?? 0);
    const payableCredit = journalCredit.plus(control.openingBalanceSide === "Cr" ? opening : opening.negated());
    const delta = classifyHadiRentDifference(
      payableCredit.toFixed(2),
      linkedOutstanding.toFixed(2),
      ownedOutstanding.toFixed(2),
      unmatchedPostedPayments
    );

    return {
      asOf, payerCompanyId: companyId, propertiesCompanyId: HADI_LINKED_RENT.propertiesCompanyId,
      linkedContracts: linked.length,
      linkedExpectedAsOf: linked.reduce((sum, c) => sum.plus(byContract.get(c.id)?.expected ?? 0), new MoneyDecimal(0)).toFixed(2),
      linkedPaidAsOf: linked.reduce((sum, c) => sum.plus(byContract.get(c.id)?.paid ?? 0), new MoneyDecimal(0)).toFixed(2),
      linkedOutstanding: linkedOutstanding.toFixed(2),
      ownedShopOutstanding: ownedOutstanding.toFixed(2),
      accruedRentPayableCredit: payableCredit.toFixed(2),
      difference: delta.difference,
      unmatchedPostedPayments,
      status: delta.status,
      contracts: linked.map(c => ({
        contractId: c.id, tenantName: c.tenantName ?? "",
        expectedAsOf: (byContract.get(c.id)?.expected ?? new MoneyDecimal(0)).toFixed(2),
        paidAsOf: (byContract.get(c.id)?.paid ?? new MoneyDecimal(0)).toFixed(2),
        outstanding: (byContract.get(c.id)?.due ?? new MoneyDecimal(0)).toFixed(2),
      })),
    };
  });
}
