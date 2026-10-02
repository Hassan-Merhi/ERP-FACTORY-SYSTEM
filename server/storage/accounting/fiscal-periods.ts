import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../../services/accounting/infrastructureVoucherIdentity";
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
import { CLOSED_PERIOD_LOCK_NAMESPACE } from "../../services/accounting/closedPeriodGuard";

export async function closeFiscalPeriod(
  companyId: number,
  periodStartDate: string,
  periodEndDate: string,
  retainedEarningsAccountId: number,
  closedByUserId: string,
  notes?: string
): Promise<schema.FiscalPeriodClosure> {
  return await db.transaction(async (tx) => {
    // Exclusive per-company lock: voucher writes hold the shared side (see
    // closedPeriodGuard), so no write can land in the period while its
    // balances are being totalled and closed.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${CLOSED_PERIOD_LOCK_NAMESPACE}, ${companyId})`);
    const existingClosure = await tx
      .select()
      .from(schema.fiscalPeriodClosures)
      .where(
        and(
          eq(schema.fiscalPeriodClosures.companyId, companyId),
          eq(schema.fiscalPeriodClosures.periodEndDate, periodEndDate)
        )
      );
    if (existingClosure.length > 0) {
      throw new Error(`Fiscal period ending ${periodEndDate} has already been closed`);
    }

    const accounts = await tx
      .select()
      .from(schema.ledgerAccounts)
      .where(
        and(
          eq(schema.ledgerAccounts.companyId, companyId),
          or(eq(schema.ledgerAccounts.accountType, "Income"), eq(schema.ledgerAccounts.accountType, "Expense"))
        )
      );
    if (accounts.length === 0) throw new Error("No Income or Expense accounts found for this company");

    interface AccountBalance {
      accountId: number;
      accountCode: string;
      accountName: string;
      accountType: string;
      balance: number;
    }
    const accountBalances: AccountBalance[] = [];
    let totalIncome = 0;
    let totalExpense = 0;

    for (const account of accounts) {
      const openingBalance = parseFloat(account.openingBalance || "0");
      const openingSide = account.openingBalanceSide || "Dr";
      let balance = openingSide === "Dr" ? openingBalance : -openingBalance;

      const entries = await tx
        .select()
        .from(schema.voucherEntries)
        .innerJoin(schema.vouchers, eq(schema.voucherEntries.voucherId, schema.vouchers.id))
        .where(
          and(
            eq(schema.voucherEntries.ledgerAccountId, account.id),
            sql`${schema.vouchers.voucherDate} >= ${periodStartDate}`,
            sql`${schema.vouchers.voucherDate} <= ${periodEndDate}`,
            eq(schema.vouchers.companyId, companyId),
            eq(schema.vouchers.optional, false),
            isNull(schema.vouchers.deletedAt)
          )
        );

      for (const entry of entries) {
        const debit = parseFloat(entry.voucher_entries.debitAmount || "0");
        const credit = parseFloat(entry.voucher_entries.creditAmount || "0");
        balance += debit - credit;
      }

      if (account.accountType === "Income") {
        totalIncome += -balance;
        accountBalances.push({
          accountId: account.id,
          accountCode: account.code,
          accountName: account.name,
          accountType: account.accountType,
          balance: -balance,
        });
      } else {
        totalExpense += balance;
        accountBalances.push({
          accountId: account.id,
          accountCode: account.code,
          accountName: account.name,
          accountType: account.accountType,
          balance,
        });
      }
    }

    const netIncome = totalIncome - totalExpense;
    const voucherNumber = `FISCAL-CLOSE-${periodEndDate}-${Date.now()}`;
    const { voucher: closingVoucher } = await insertInfrastructureVoucherTx(
      tx,
      {
        companyId,
        voucherNumber,
        voucherType: "Journal",
        voucherDate: periodEndDate,
        description: `Fiscal Period Close: ${periodStartDate} to ${periodEndDate}${notes ? ` - ${notes}` : ""}`,
        totalAmount: Math.abs(netIncome).toFixed(2),
        optional: false,
      },
      infrastructurePostingIdentity("fiscal-period", `${companyId}:${periodStartDate}:${periodEndDate}`, "close"),
      { retainedEarningsAccountId, accountBalances, netIncome }
    );

    for (const account of accountBalances) {
      if (account.balance === 0) continue;
      if (account.accountType === "Income") {
        await tx.insert(schema.voucherEntries).values({
          voucherId: closingVoucher.id,
          ledgerAccountId: account.accountId,
          debitAmount: account.balance.toFixed(2),
          creditAmount: "0",
          narration: `Close ${account.accountName} for period ending ${periodEndDate}`,
        });
      } else {
        await tx.insert(schema.voucherEntries).values({
          voucherId: closingVoucher.id,
          ledgerAccountId: account.accountId,
          debitAmount: "0",
          creditAmount: account.balance.toFixed(2),
          narration: `Close ${account.accountName} for period ending ${periodEndDate}`,
        });
      }
    }

    if (netIncome !== 0) {
      if (netIncome > 0) {
        await tx.insert(schema.voucherEntries).values({
          voucherId: closingVoucher.id,
          ledgerAccountId: retainedEarningsAccountId,
          debitAmount: "0",
          creditAmount: netIncome.toFixed(2),
          narration: `Net Income for period ending ${periodEndDate}`,
        });
      } else {
        await tx.insert(schema.voucherEntries).values({
          voucherId: closingVoucher.id,
          ledgerAccountId: retainedEarningsAccountId,
          debitAmount: Math.abs(netIncome).toFixed(2),
          creditAmount: "0",
          narration: `Net Loss for period ending ${periodEndDate}`,
        });
      }
    }

    const [closure] = await tx
      .insert(schema.fiscalPeriodClosures)
      .values({
        companyId,
        periodStartDate,
        periodEndDate,
        closedByUserId,
        closingVoucherId: closingVoucher.id,
        retainedEarningsAccountId,
        totalIncome: totalIncome.toFixed(2),
        totalExpense: totalExpense.toFixed(2),
        netIncome: netIncome.toFixed(2),
        status: "CLOSED",
        notes: notes || null,
      })
      .returning();

    for (const account of accountBalances) {
      await tx
        .update(schema.ledgerAccounts)
        .set({ openingBalance: "0", openingBalanceSide: "Dr" })
        .where(eq(schema.ledgerAccounts.id, account.accountId));
    }

    return closure;
  });
}

export async function getFiscalPeriodClosures(companyId: number): Promise<schema.FiscalPeriodClosure[]> {
  return await db
    .select()
    .from(schema.fiscalPeriodClosures)
    .where(eq(schema.fiscalPeriodClosures.companyId, companyId))
    .orderBy(sql`${schema.fiscalPeriodClosures.periodEndDate} DESC`);
}

// ---------------------------------------------------------------------------
// Exchange Rates
// ---------------------------------------------------------------------------
