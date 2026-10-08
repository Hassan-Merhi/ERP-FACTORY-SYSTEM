import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type Decimal from "decimal.js";
import * as schema from "@shared/schema";

import { db } from "../../db";
import { MoneyDecimal, signedOpeningBalance, toMoney } from "../../lib/money";

/**
 * Ledger rules for a customer's balance, shared by every customer-balance reader.
 *
 * - The opening balance is owned by the customer record (counted once; the
 *   linked ledger account's own opening is never added on top).
 * - A voucher line belongs to its voucher's company (vouchers.company_id), and
 *   only posted vouchers count: not soft-deleted, not optional.
 * - A voucher counts from COALESCE(effective_date, voucher_date).
 * - A line belongs to a linked customer when it is on the customer's linked
 *   ledger, or when it is tagged with the customer and carries no ledger at all
 *   (no other target). A customer-tagged line posted to some other ledger is
 *   that ledger's line, not the customer's. An unlinked customer owns every
 *   line tagged with it.
 * - A line's effect is debit minus credit (a line carrying both is netted).
 */
export type CustomerLedgerIdentity = { id: number; ledgerAccountId: number | null };

const ve = schema.voucherEntries;
const v = schema.vouchers;

/** COALESCE(effective_date, voucher_date) — the date a voucher counts from. */
export const voucherBalanceDateSql = sql`COALESCE(${v.effectiveDate}, ${v.voucherDate})`;

/** The voucher is posted in this company: not deleted, not optional. */
export function postedVoucherInCompany(companyId: number): SQL {
  return and(eq(v.companyId, companyId), eq(v.optional, false), isNull(v.deletedAt)) as SQL;
}

/** The voucher-entry lines that belong to one customer. */
export function customerVoucherLineFilter(customer: CustomerLedgerIdentity): SQL {
  if (customer.ledgerAccountId) {
    return or(
      eq(ve.ledgerAccountId, customer.ledgerAccountId),
      and(eq(ve.customerId, customer.id), isNull(ve.ledgerAccountId))
    ) as SQL;
  }
  return eq(ve.customerId, customer.id);
}

const netSql = sql<string>`COALESCE(SUM(CAST(${ve.debitAmount} AS numeric) - CAST(${ve.creditAmount} AS numeric)), 0)`;
const baseNetSql = sql<string>`COALESCE(SUM(
  COALESCE(CAST(${ve.baseDebitAmount} AS numeric), CAST(${ve.debitAmount} AS numeric), 0)
  - COALESCE(CAST(${ve.baseCreditAmount} AS numeric), CAST(${ve.creditAmount} AS numeric), 0)
), 0)`;

type Aggregate = { key: number | null; net: string | null; baseNet: string | null };
type Movement = { net: Decimal; base: Decimal };

export type CustomerLedgerBalanceOptions = {
  /** Count only vouchers dated on or before this day (YYYY-MM-DD). */
  asOfDate?: string;
  /** Count only vouchers dated strictly before this day (YYYY-MM-DD). */
  beforeDate?: string;
};

export type CustomerLedgerBalance = {
  /** Signed balance, Dr positive: opening + movements. */
  signed: Decimal;
  /** Signed opening balance (customer record). */
  opening: Decimal;
  /** Signed historical base balance (opening + base movements). */
  historicalBase: Decimal;
};

/**
 * Balances for the given customers of one company, from the ledger rules above.
 * The customers must belong to companyId; callers pass the rows they loaded.
 */
export async function computeCustomerLedgerBalances(
  companyId: number,
  customers: Array<CustomerLedgerIdentity & { openingBalance?: string | null; openingBalanceSide?: string | null }>,
  options: CustomerLedgerBalanceOptions = {}
): Promise<Map<number, CustomerLedgerBalance>> {
  const result = new Map<number, CustomerLedgerBalance>();
  if (customers.length === 0) return result;

  const ledgerIds = customers.filter((c) => c.ledgerAccountId).map((c) => c.ledgerAccountId as number);
  const unlinkedIds = customers.filter((c) => !c.ledgerAccountId).map((c) => c.id);
  const customerIds = customers.map((c) => c.id);

  const dateConditions: SQL[] = [];
  if (options.asOfDate) dateConditions.push(sql`${voucherBalanceDateSql} <= ${options.asOfDate}`);
  if (options.beforeDate) dateConditions.push(sql`${voucherBalanceDateSql} < ${options.beforeDate}`);
  const voucherConditions = and(postedVoucherInCompany(companyId), ...dateConditions);

  // Customer-tagged lines: with no ledger for any customer, on any ledger for
  // an unlinked customer.
  const customerLineScope =
    unlinkedIds.length > 0
      ? or(isNull(ve.ledgerAccountId), inArray(ve.customerId, unlinkedIds))
      : isNull(ve.ledgerAccountId);

  const [ledgerRows, customerRows] = await Promise.all([
    ledgerIds.length > 0
      ? db
          .select({ key: ve.ledgerAccountId, net: netSql, baseNet: baseNetSql })
          .from(ve)
          .innerJoin(v, eq(ve.voucherId, v.id))
          .where(and(voucherConditions, isNotNull(ve.ledgerAccountId), inArray(ve.ledgerAccountId, ledgerIds)))
          .groupBy(ve.ledgerAccountId)
      : Promise.resolve([] as Aggregate[]),
    db
      .select({ key: ve.customerId, net: netSql, baseNet: baseNetSql })
      .from(ve)
      .innerJoin(v, eq(ve.voucherId, v.id))
      .where(and(voucherConditions, inArray(ve.customerId, customerIds), customerLineScope))
      .groupBy(ve.customerId),
  ]);

  const toMap = (rows: Aggregate[]) => {
    const map = new Map<number, Movement>();
    for (const row of rows) {
      if (row.key) map.set(row.key, { net: toMoney(row.net), base: toMoney(row.baseNet) });
    }
    return map;
  };
  const byLedger = toMap(ledgerRows as Aggregate[]);
  const byCustomer = toMap(customerRows as Aggregate[]);
  const zero = new MoneyDecimal(0);

  for (const customer of customers) {
    const opening = signedOpeningBalance(customer.openingBalance, customer.openingBalanceSide || "Dr");
    const ledgerMove = customer.ledgerAccountId ? byLedger.get(customer.ledgerAccountId) : undefined;
    const customerMove = byCustomer.get(customer.id);
    result.set(customer.id, {
      opening,
      signed: opening.plus(ledgerMove?.net ?? zero).plus(customerMove?.net ?? zero),
      historicalBase: opening.plus(ledgerMove?.base ?? zero).plus(customerMove?.base ?? zero),
    });
  }
  return result;
}

/** Signed (Dr positive) ledger balance of one customer of companyId; 0 when not found. */
export async function getCustomerLedgerBalance(customerId: number, companyId: number): Promise<Decimal> {
  const [customer] = await db
    .select({
      id: schema.customers.id,
      ledgerAccountId: schema.customers.ledgerAccountId,
      openingBalance: schema.customers.openingBalance,
      openingBalanceSide: schema.customers.openingBalanceSide,
    })
    .from(schema.customers)
    .where(and(eq(schema.customers.id, customerId), eq(schema.customers.companyId, companyId)));
  if (!customer) return new MoneyDecimal(0);
  const balances = await computeCustomerLedgerBalances(companyId, [customer]);
  return balances.get(customer.id)?.signed ?? new MoneyDecimal(0);
}
