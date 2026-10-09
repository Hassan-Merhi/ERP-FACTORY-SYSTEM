import type { Express } from "express";

import { and, eq, gte, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { requireAuth } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { debitMinusCredit, signedOpeningBalance, sumMoney, toMoney } from "../lib/money";
import { ledgerAccounts, locations, suppliers, voucherEntries, vouchers } from "@shared/schema";

export function registerReportsLedgerRoutes(app: Express) {
  app.get("/api/reports/ledger-monthly-summary/:accountId", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const accountId = parseInt(req.params.accountId);
      if (isNaN(accountId)) return res.status(400).json({ message: "Invalid account ID" });
      const { startDate, endDate } = req.query;

      const account = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)))
        .execute()
        .then((rows) => rows[0]);
      if (!account) return res.status(404).json({ message: "Account not found" });

      const start = startDate ? new Date(startDate as string) : new Date(new Date().getFullYear(), 0, 1);
      const end = endDate ? new Date(endDate as string) : new Date(new Date().getFullYear(), 11, 31);

      const openingEntries = await db
        .select({
          debit: sql<string>`COALESCE("voucher_entries"."base_debit_amount", "voucher_entries"."debit_amount")`,
          credit: sql<string>`COALESCE("voucher_entries"."base_credit_amount", "voucher_entries"."credit_amount")`,
        })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
        .where(
          and(
            eq(voucherEntries.ledgerAccountId, accountId),
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            eq(vouchers.optional, false),
            lt(vouchers.voucherDate, start.toISOString().split("T")[0])
          )
        )
        .execute();

      const openingBalSideMonthly = (account.openingBalanceSide as string) || "Dr";
      // Credit-positive, as this report has always signed it.
      const openingBalance = toMoney(0)
        .minus(signedOpeningBalance(account.openingBalance, openingBalSideMonthly))
        .minus(debitMinusCredit(openingEntries.map((e) => ({ debitAmount: e.debit, creditAmount: e.credit }))));

      const entries = await db
        .select({
          voucherId: vouchers.id,
          date: vouchers.voucherDate,
          debit: sql<string>`COALESCE("voucher_entries"."base_debit_amount", "voucher_entries"."debit_amount")`,
          credit: sql<string>`COALESCE("voucher_entries"."base_credit_amount", "voucher_entries"."credit_amount")`,
        })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
        .where(
          and(
            eq(voucherEntries.ledgerAccountId, accountId),
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            eq(vouchers.optional, false),
            gte(vouchers.voucherDate, start.toISOString().split("T")[0]),
            lte(vouchers.voucherDate, end.toISOString().split("T")[0])
          )
        )
        .execute();

      const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      const monthlyData: { month: number; monthName: string; debit: number; credit: number; closingBalance: number }[] =
        [];
      let runningBalance = openingBalance;
      const monthDebits = [];
      const monthCredits = [];

      for (let month = 0; month < 12; month++) {
        const monthEntries = entries.filter((entry) => {
          const date = new Date(entry.date);
          return date.getMonth() === month && date.getFullYear() === start.getFullYear();
        });
        const debit = sumMoney(monthEntries.map((entry) => entry.debit));
        const credit = sumMoney(monthEntries.map((entry) => entry.credit));
        monthDebits.push(debit);
        monthCredits.push(credit);
        runningBalance = runningBalance.plus(credit).minus(debit);
        monthlyData.push({
          month: month + 1,
          monthName: monthNames[month],
          debit: debit.toNumber(),
          credit: credit.toNumber(),
          closingBalance: runningBalance.toNumber(),
        });
      }

      res.json({
        account: { id: account.id, code: account.code, name: account.name },
        openingBalance: openingBalance.toNumber(),
        months: monthlyData,
        grandTotal: {
          debit: sumMoney(monthDebits).toNumber(),
          credit: sumMoney(monthCredits).toNumber(),
          closingBalance: runningBalance.toNumber(),
        },
        dateRange: {
          startDate: start.toISOString().split("T")[0],
          endDate: end.toISOString().split("T")[0],
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/reports/ledger-vouchers/:accountId/:year/:month", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const accountId = parseInt(req.params.accountId);
      const year = parseInt(req.params.year);
      const month = parseInt(req.params.month);
      if (isNaN(accountId) || isNaN(year) || isNaN(month)) {
        return res.status(400).json({ message: "Invalid parameters" });
      }

      const account = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)))
        .execute()
        .then((rows) => rows[0]);
      if (!account) return res.status(404).json({ message: "Account not found" });

      const monthNames = [
        "",
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      const startOfMonth = new Date(year, month - 1, 1);
      const endOfMonth = new Date(year, month, 0);

      const openingEntries = await db
        .select({ debit: voucherEntries.debitAmount, credit: voucherEntries.creditAmount })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
        .where(
          and(
            eq(voucherEntries.ledgerAccountId, accountId),
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            eq(vouchers.optional, false),
            lt(vouchers.voucherDate, startOfMonth.toISOString().split("T")[0])
          )
        )
        .execute();

      const openingBalSide = (account.openingBalanceSide as string) || "Dr";
      // Credit-positive, as this report has always signed it.
      const openingBalance = toMoney(0)
        .minus(signedOpeningBalance(account.openingBalance, openingBalSide))
        .minus(debitMinusCredit(openingEntries.map((e) => ({ debitAmount: e.debit, creditAmount: e.credit }))));

      const voucherEntriesData = await db
        .select({
          entryId: voucherEntries.id,
          voucherId: vouchers.id,
          voucherNumber: vouchers.voucherNumber,
          voucherType: vouchers.voucherType,
          date: vouchers.voucherDate,
          debit: voucherEntries.debitAmount,
          credit: voucherEntries.creditAmount,
          supplierId: voucherEntries.supplierId,
          locationId: vouchers.locationId,
          narration: voucherEntries.narration,
        })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
        .where(
          and(
            eq(voucherEntries.ledgerAccountId, accountId),
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            eq(vouchers.optional, false),
            gte(vouchers.voucherDate, startOfMonth.toISOString().split("T")[0]),
            lte(vouchers.voucherDate, endOfMonth.toISOString().split("T")[0])
          )
        )
        .orderBy(vouchers.voucherDate, vouchers.voucherNumber)
        .execute();

      const vouchersWithDetails = await Promise.all(
        voucherEntriesData.map(async (entry) => {
          let particulars: string;
          if (entry.supplierId) {
            const supplier = await db
              .select({ legalName: suppliers.legalName })
              .from(suppliers)
              .where(eq(suppliers.id, entry.supplierId))
              .execute()
              .then((rows) => rows[0]);
            particulars = supplier?.legalName || "Unknown Supplier";
          } else if (entry.locationId) {
            const location = await db
              .select({ name: locations.name })
              .from(locations)
              .where(eq(locations.id, entry.locationId))
              .execute()
              .then((rows) => rows[0]);
            particulars = location?.name || "Unknown Location";
          } else if (entry.narration) {
            particulars = entry.narration.substring(0, 50);
          } else {
            const contraEntries = await db
              .select({ accountName: ledgerAccounts.name })
              .from(voucherEntries)
              .innerJoin(ledgerAccounts, eq(voucherEntries.ledgerAccountId, ledgerAccounts.id))
              .where(and(eq(voucherEntries.voucherId, entry.voucherId), ne(voucherEntries.ledgerAccountId, accountId)))
              .execute();
            particulars = contraEntries[0]?.accountName || "Multiple Accounts";
          }
          return {
            id: entry.entryId,
            voucherId: entry.voucherId,
            date: entry.date,
            particulars,
            voucherType: entry.voucherType,
            voucherNumber: entry.voucherNumber,
            debit: toMoney(entry.debit).toNumber(),
            credit: toMoney(entry.credit).toNumber(),
          };
        })
      );

      const totalDebit = sumMoney(voucherEntriesData.map((entry) => entry.debit));
      const totalCredit = sumMoney(voucherEntriesData.map((entry) => entry.credit));
      const totals = { debit: totalDebit.toNumber(), credit: totalCredit.toNumber() };
      res.json({
        account: { id: account.id, code: account.code, name: account.name },
        month,
        monthName: monthNames[month],
        year,
        openingBalance: openingBalance.toNumber(),
        vouchers: vouchersWithDetails,
        totals,
        closingBalance: openingBalance.plus(totalCredit).minus(totalDebit).toNumber(),
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
