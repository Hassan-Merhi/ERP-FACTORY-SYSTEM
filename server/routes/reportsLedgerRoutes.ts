import type { Express } from "express";

import { and, eq, gte, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { requireAuth } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
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

      const openingRawMonthly = parseFloat(account.openingBalance || "0");
      const openingBalSideMonthly = (account.openingBalanceSide as string) || "Dr";
      let openingBalance = openingBalSideMonthly === "Cr" ? openingRawMonthly : -openingRawMonthly;
      for (const entry of openingEntries) {
        openingBalance += parseFloat(entry.credit || "0") - parseFloat(entry.debit || "0");
      }

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
      const monthlyData: { month: number; monthName: string; debit: number; credit: number; closingBalance: number }[] = [];
      let runningBalance = openingBalance;

      for (let month = 0; month < 12; month++) {
        const monthEntries = entries.filter((entry) => {
          const date = new Date(entry.date);
          return date.getMonth() === month && date.getFullYear() === start.getFullYear();
        });
        let debit = 0;
        let credit = 0;
        for (const entry of monthEntries) {
          debit += parseFloat(entry.debit || "0");
          credit += parseFloat(entry.credit || "0");
        }
        runningBalance += credit - debit;
        monthlyData.push({ month: month + 1, monthName: monthNames[month], debit, credit, closingBalance: runningBalance });
      }

      res.json({
        account: { id: account.id, code: account.code, name: account.name },
        openingBalance,
        months: monthlyData,
        grandTotal: {
          debit: monthlyData.reduce((sum, month) => sum + month.debit, 0),
          credit: monthlyData.reduce((sum, month) => sum + month.credit, 0),
          closingBalance: runningBalance,
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

      const openingRaw = parseFloat(account.openingBalance || "0");
      const openingBalSide = (account.openingBalanceSide as string) || "Dr";
      let openingBalance = openingBalSide === "Cr" ? openingRaw : -openingRaw;
      for (const entry of openingEntries) {
        openingBalance += parseFloat(entry.credit || "0") - parseFloat(entry.debit || "0");
      }

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
            debit: parseFloat(entry.debit || "0"),
            credit: parseFloat(entry.credit || "0"),
          };
        })
      );

      const totals = {
        debit: vouchersWithDetails.reduce((sum, voucher) => sum + voucher.debit, 0),
        credit: vouchersWithDetails.reduce((sum, voucher) => sum + voucher.credit, 0),
      };
      res.json({
        account: { id: account.id, code: account.code, name: account.name },
        month,
        monthName: monthNames[month],
        year,
        openingBalance,
        vouchers: vouchersWithDetails,
        totals,
        closingBalance: openingBalance + totals.credit - totals.debit,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
