import type { Express } from "express";

import { and, eq, gte, inArray, isNull, lt, lte, ne } from "drizzle-orm";
import { requireAuth } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { debitMinusCredit, signedOpeningBalance, sumMoney, toMoney } from "../lib/money";
import { ledgerAccounts, locations, suppliers, voucherEntries, vouchers } from "@shared/schema";
import { monthlyStatementAccountIds } from "./reportsLedgerRoutesMonthlyStatementAccountIds";
import { registerReportsLedgerRoutesPart1 } from "./registerReportsLedgerRoutesPart1";

export function registerReportsLedgerRoutes(app: Express) {
  registerReportsLedgerRoutesPart1(app);

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
      const statementAccountIds = await monthlyStatementAccountIds(companyId, accountId);

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
            inArray(voucherEntries.ledgerAccountId, statementAccountIds),
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
          voucherDescription: vouchers.description,
          createdAt: vouchers.createdAt,
          companyId: vouchers.companyId,
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
            inArray(voucherEntries.ledgerAccountId, statementAccountIds),
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
            voucherDescription: entry.voucherDescription,
            createdAt: entry.createdAt,
            companyId: entry.companyId,
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
