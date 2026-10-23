/**
 * Phase 3: read-only Rental open items by contract/month. This reuses the
 * Rental subledger and existing POSTED payment allocations, not a second
 * matching table and not new accounting vouchers.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { getDuePeriods, getRentalBillingDay, getRentalPeriodDueDate } from "./rentalPeriodService";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { OpenItemError } from "../accounting/partyOpenItemService";

type RentalOrigin = "ERP" | "FACTORY" | "PROPERTIES";
interface ContractRow extends Record<string, unknown> {
  id: number;
  company_id: number;
  linked_company_id: number | null;
  module: RentalOrigin;
  currency: string | null;
  rental_amount: string;
  start_date: string;
  end_date: string | null;
}
interface RentMonth extends Record<string, unknown> {
  id: number;
  year: number;
  month: number;
  expected_amount: string;
}
interface RentPayment extends Record<string, unknown> {
  id: number;
  for_year: number;
  for_month: number;
  amount: string;
  payment_date: string;
  currency: string | null;
}
const money = (value: unknown) => new Decimal(String(value ?? 0));
const asMoney = (value: Decimal) => value.toFixed(2);
export async function loadRentalOpenItemsTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    contractId: number;
    module: RentalOrigin;
    asOfDate: string;
  }
) {
  if (
    !Number.isSafeInteger(input.companyId) ||
    input.companyId <= 0 ||
    !Number.isSafeInteger(input.contractId) ||
    input.contractId <= 0 ||
    !["ERP", "FACTORY", "PROPERTIES"].includes(input.module)
  )
    throw new OpenItemError("RENTAL_OPEN_ITEMS_INVALID", "Invalid company, module or contract", 400);
  const date = new Date(input.asOfDate + "T00:00:00.000Z");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.asOfDate) ||
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== input.asOfDate
  )
    throw new OpenItemError("RENTAL_OPEN_ITEMS_DATE_INVALID", "Invalid as-of date", 400);
  await assertTransactionCompanyScope(tx, input.companyId);
  const contract = resultRows<ContractRow>(
    await tx.execute(sql`
    SELECT id,company_id,linked_company_id,module,currency,
      rental_amount::text,start_date::text,end_date::text
    FROM property_contracts WHERE id=${input.contractId} AND module=${input.module}
      AND (company_id=${input.companyId} OR linked_company_id=${input.companyId})
    LIMIT 1
  `)
  )[0];
  if (!contract)
    throw new OpenItemError("RENTAL_CONTRACT_NOT_FOUND", "Rental contract does not belong to this company", 404);
  const until = contract.end_date && contract.end_date < input.asOfDate ? contract.end_date : input.asOfDate;
  const start = String(contract.start_date).slice(0, 10);
  const billingDay = getRentalBillingDay(start);
  const due = getDuePeriods(start, billingDay, until);
  const months = resultRows<RentMonth>(
    await tx.execute(sql`
    SELECT id,year,month,expected_amount::text FROM property_monthly_ledger
    WHERE contract_id=${input.contractId} AND module=${input.module}
      AND company_id=${contract.company_id}
  `)
  );
  const payments = resultRows<RentPayment>(
    await tx.execute(sql`
    SELECT id,for_year,for_month,amount::text,payment_date::text,currency
    FROM property_payments
    WHERE company_id=${input.companyId} AND module=${input.module}
      AND contract_id=${input.contractId} AND posting_status='POSTED'
      AND payment_date<=${input.asOfDate}::date
    ORDER BY payment_date,id
  `)
  );
  const key = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;
  const saved = new Map(months.map((r) => [key(r.year, r.month), r]));
  const paid = new Map<string, Decimal>();
  const byMonth = new Map<string, number[]>();
  const currency = (contract.currency ?? "USD").trim().toUpperCase() || "USD";
  for (const p of payments) {
    const pCurrency = (p.currency ?? "USD").trim().toUpperCase();
    if (pCurrency !== currency) {
      throw new OpenItemError(
        "RENTAL_OPEN_ITEMS_CURRENCY_INCONSISTENT",
        "This contract contains payments in a different currency; manual currency reconciliation is required"
      );
    }
    const k = key(p.for_year, p.for_month);
    paid.set(k, (paid.get(k) ?? new Decimal(0)).plus(money(p.amount)));
    byMonth.set(k, [...(byMonth.get(k) ?? []), p.id]);
  }
  let outstanding = new Decimal(0),
    received = new Decimal(0),
    expected = new Decimal(0);
  const items = due.map((period) => {
    const k = key(period.year, period.month);
    const row = saved.get(k);
    const amount = money(
      row?.expected_amount && money(row.expected_amount).gt(0) ? row.expected_amount : contract.rental_amount
    );
    const paidAmount = paid.get(k) ?? new Decimal(0);
    expected = expected.plus(amount);
    received = received.plus(paidAmount);
    const remaining = Decimal.max(new Decimal(0), amount.minus(paidAmount));
    outstanding = outstanding.plus(remaining);
    return {
      contractId: input.contractId,
      ledgerRowId: row?.id ?? null,
      year: period.year,
      month: period.month,
      dueDate: getRentalPeriodDueDate(period.year, period.month, billingDay),
      expectedAmount: asMoney(amount),
      paidAmount: asMoney(paidAmount),
      outstandingAmount: asMoney(remaining),
      paymentIds: byMonth.get(k) ?? [],
      status: remaining.isZero() ? "settled" : paidAmount.gt(0) ? "partial" : "open",
    };
  });
  let prepayments = new Decimal(0);
  for (const [k, value] of paid) {
    if (!items.some((item) => key(item.year, item.month) === k)) prepayments = prepayments.plus(value);
  }
  return {
    companyId: input.companyId,
    module: input.module,
    contractId: input.contractId,
    currency,
    asOfDate: input.asOfDate,
    items,
    totals: {
      expected: asMoney(expected),
      paidAgainstDue: asMoney(received),
      outstanding: asMoney(outstanding),
      advanceForOtherMonths: asMoney(prepayments),
    },
  };
}
