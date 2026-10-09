import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
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

export async function getCustomerBalance(customerId: number, companyId: number): Promise<number> {
  const [result] = await db
    .select({
      net: sql<string>`COALESCE(SUM(CAST(${schema.customerBalances.debitAmount} AS numeric) - CAST(${schema.customerBalances.creditAmount} AS numeric)), 0)`,
    })
    .from(schema.customerBalances)
    .where(and(eq(schema.customerBalances.customerId, customerId), eq(schema.customerBalances.companyId, companyId)));
  return result ? toMoney(result.net).toNumber() : 0;
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
