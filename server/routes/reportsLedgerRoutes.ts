import type { Express } from "express";

import { and, eq, ne, sql } from "drizzle-orm";
import { requireAuth } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { sumMoney, toMoney } from "../lib/money";
import { ledgerAccounts, locations, suppliers, voucherEntries } from "@shared/schema";
import { companyBusinessDate } from "../services/accounting/companyBusinessDate";
import {
  engineOpeningAt,
  ledgerOwnership,
  monthEnd,
  monthlyMovements,
  monthsBetween,
} from "../services/accounting/reporting/ledgerMonthlySummary";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

      // Phase 27 (RP-9): on the engine (services/accounting/reporting/ledgerMonthlySummary.ts).
      // Dates are calendar strings; without dates the company's business year.
      const businessYear = (await companyBusinessDate(companyId)).slice(0, 4);
      const start = typeof startDate === "string" && ISO_DATE.test(startDate) ? startDate : `${businessYear}-01-01`;
      const end = typeof endDate === "string" && ISO_DATE.test(endDate) ? endDate : `${businessYear}-12-31`;
      if (start > end) return res.status(400).json({ message: "startDate is after endDate" });
      const owner = await ledgerOwnership(companyId, accountId);
      const [openingDebit, movements] = await Promise.all([
        engineOpeningAt(companyId, owner, start),
        monthlyMovements(companyId, owner, start, end),
      ]);
      // Credit-positive, as this report has always signed it.
      const openingBalance = openingDebit.negated();

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
      const monthlyData: Array<{
        month: number;
        year: number;
        yearMonth: string;
        monthName: string;
        debit: number;
        credit: number;
        closingBalance: number;
      }> = [];
      let runningBalance = openingBalance;
      const monthDebits = [];
      const monthCredits = [];

      for (const yearMonth of monthsBetween(start, end)) {
        const movement = movements.get(yearMonth);
        const debit = movement?.debit ?? toMoney(0);
        const credit = movement?.credit ?? toMoney(0);
        monthDebits.push(debit);
        monthCredits.push(credit);
        runningBalance = runningBalance.plus(credit).minus(debit);
        const month = Number(yearMonth.slice(5, 7));
        monthlyData.push({
          month,
          year: Number(yearMonth.slice(0, 4)),
          yearMonth,
          monthName: monthNames[month - 1],
          debit: debit.toNumber(),
          credit: credit.toNumber(),
          closingBalance: runningBalance.toNumber(),
        });
      }

      res.json({
        account: { id: account.id, code: account.code, name: account.name },
        balanceOwner: { kind: owner.kind, id: owner.id },
        openingBalance: openingBalance.toNumber(),
        months: monthlyData,
        grandTotal: {
          debit: sumMoney(monthDebits).toNumber(),
          credit: sumMoney(monthCredits).toNumber(),
          closingBalance: runningBalance.toNumber(),
        },
        dateRange: { startDate: start, endDate: end },
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
      if (month < 1 || month > 12) return res.status(400).json({ message: "Invalid parameters" });
      // Phase 27 (RP-9): the engine's opening at the month start and its owned lines,
      // booked on COALESCE(effective_date, voucher_date); calendar-string month bounds.
      const yearMonth = `${year}-${String(month).padStart(2, "0")}`;
      const startOfMonth = `${yearMonth}-01`;
      const endOfMonth = monthEnd(yearMonth);
      const owner = await ledgerOwnership(companyId, accountId);
      // Credit-positive, as this report has always signed it.
      const openingBalance = (await engineOpeningAt(companyId, owner, startOfMonth)).negated();

      const lineRows = await db.execute<{
        entry_id: number;
        voucher_id: number;
        voucher_number: string;
        voucher_type: string;
        booked_on: string;
        debit: string | null;
        credit: string | null;
        supplier_id: number | null;
        location_id: number | null;
        narration: string | null;
      }>(sql`
        SELECT ve.id AS entry_id, v.id AS voucher_id, v.voucher_number, v.voucher_type,
               COALESCE(v.effective_date, v.voucher_date)::text AS booked_on,
               ve.debit_amount::text AS debit, ve.credit_amount::text AS credit,
               ve.supplier_id, v.location_id, ve.narration
          FROM voucher_entries ve
          JOIN vouchers v ON v.id = ve.voucher_id
         WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND v.optional = false
           AND COALESCE(v.effective_date, v.voucher_date) BETWEEN ${startOfMonth}::date AND ${endOfMonth}::date
           AND ${owner.lines}
         ORDER BY 5, v.voucher_number, ve.id
      `);
      const voucherEntriesData = lineRows.rows.map((row) => ({
        entryId: row.entry_id,
        voucherId: row.voucher_id,
        voucherNumber: row.voucher_number,
        voucherType: row.voucher_type,
        date: row.booked_on,
        debit: row.debit,
        credit: row.credit,
        supplierId: row.supplier_id,
        locationId: row.location_id,
        narration: row.narration,
      }));

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
