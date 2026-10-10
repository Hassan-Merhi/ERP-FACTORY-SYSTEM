import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
import { getPartyBalance } from "../../services/accounting/balances/ledgerBalanceEngine";
import { toMoney } from "../../lib/money";

export async function addCustomerBalanceEntry(entry: schema.InsertCustomerBalance): Promise<schema.CustomerBalance> {
  const debitAmount = entry.debitAmount || "0";
  const creditAmount = entry.creditAmount || "0";
  if (isNaN(Number(debitAmount)) || isNaN(Number(creditAmount))) {
    throw new Error("Invalid debit or credit amount");
  }

  const [latestBalance] = await db
    .select({ balance: schema.customerBalances.balance })
    .from(schema.customerBalances)
    .where(
      and(
        eq(schema.customerBalances.customerId, entry.customerId),
        eq(schema.customerBalances.companyId, entry.companyId)
      )
    )
    .orderBy(desc(schema.customerBalances.id))
    .limit(1);

  const currentBalance = latestBalance?.balance || "0";

  const [created] = await db
    .insert(schema.customerBalances)
    .values({
      ...entry,
      debitAmount,
      creditAmount,
      balance: sql`(${currentBalance}::decimal + ${debitAmount}::decimal - ${creditAmount}::decimal)`,
    })
    .returning();
  return created;
}

/**
 * Signed (Dr positive) balance of a customer: the one balance engine's
 * customer closing (services/accounting/balances/ledgerBalanceEngine.ts) — its
 * opening plus the posted voucher lines the engine attributes to it; 0 when
 * the customer is not in the company.
 * customer_balances is an operational cache and is not the balance: an ERP
 * container sale is both a cache row and a voucher on the customer's ledger,
 * while receipts exist only as vouchers.
 */
export async function getCustomerBalance(customerId: number, companyId: number): Promise<number> {
  const [owned] = await db
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(and(eq(schema.customers.id, customerId), eq(schema.customers.companyId, companyId)));
  if (!owned) return 0;
  const party = await getPartyBalance(db, { companyId, kind: "customer", id: customerId });
  return toMoney(party?.closing).toNumber();
}

export async function getCustomerStatement(
  customerId: number,
  companyId: number,
  startDate?: string,
  endDate?: string
): Promise<schema.CustomerBalance[]> {
  const conditions = [
    eq(schema.customerBalances.customerId, customerId),
    eq(schema.customerBalances.companyId, companyId),
  ];
  if (startDate) conditions.push(sql`${schema.customerBalances.transactionDate} >= ${startDate}`);
  if (endDate) conditions.push(sql`${schema.customerBalances.transactionDate} <= ${endDate}`);
  return await db
    .select()
    .from(schema.customerBalances)
    .where(and(...conditions))
    .orderBy(schema.customerBalances.transactionDate);
}

// ---------------------------------------------------------------------------
// Role Feature Permissions
// ---------------------------------------------------------------------------
