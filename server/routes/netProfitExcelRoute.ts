import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { logAudit } from "./_helpers";
import { calculateNetPositionAsOf } from "../helpers/calculateNetPositionAsOf";
import { vouchers, voucherEntries, salesItems } from "@shared/schema";
import { eq, and, inArray, sql, isNull, gte, lte } from "drizzle-orm";
import {
  computeBalancesFromEntries,
  computeStats,
  fmtMonthLabel,
  netProfitSection,
  writeSheet,
  writeSummarySheet,
  type NetProfitBalanceEntry,
  type NetProfitSheetContext,
} from "./netProfitExcelSheets";
import type Decimal from "decimal.js";
import { MoneyDecimal, sumMoney, toMoney } from "../lib/money";
import { ledgerCarriesStock } from "../services/accounting/perpetualInventory/reportBasis";
import { companyStockValue } from "../services/inventory/stockValuation";
import { voucherBookedOnSql } from "../services/accounting/balances/partyLineRules";
import { notFiscalClosingVoucherSql } from "../services/accounting/balances/periodReportRules";

export function registerNetProfitExcelRoute(app: Express) {
  app.get("/api/reports/net-profit-excel", requireAuth, async (req, res) => {
    try {
      const role = req.user?.role;
      const isAdminOrDev = role === "Admin" || role === "Developer";
      const requestedCompanyId = req.query.companyId ? parseInt(req.query.companyId as string) : null;
      const companyId = isAdminOrDev && requestedCompanyId ? requestedCompanyId : req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const allCompanies = await storage.getAllCompanies();
      const company = allCompanies.find((c) => c.id === companyId);
      const companyName = company?.name || "Company";

      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : null;
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : null;
      const periodLabel = (req.query.periodLabel as string) || "All Time";
      // Perpetual inventory (wave 8.5): when the ledger carries the stock as of the
      // period end, cost of sales is in the ledger (COGS) and the periodic opening
      // and closing stock terms, and the computed stock in net position, drop out.
      const ledgerStock = await ledgerCarriesStock(companyId, endDate ? endDate.toISOString().split("T")[0] : null);

      const companyAccounts = await storage.getAllLedgerAccounts(companyId, true);

      // Fetch period vouchers WITH their dates for monthly grouping. The fiscal
      // closing journal is not period profit (wave 17 A).
      const voucherConditions = [
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        eq(vouchers.optional, false),
        notFiscalClosingVoucherSql,
      ];
      // One date basis with the engine (wave 13, R2): a voucher counts from
      // COALESCE(effective_date, voucher_date), for the period and its months.
      if (startDate) voucherConditions.push(gte(voucherBookedOnSql, startDate.toISOString().split("T")[0]));
      if (endDate) voucherConditions.push(lte(voucherBookedOnSql, endDate.toISOString().split("T")[0]));

      const allPeriodVouchers = await db
        .select({ id: vouchers.id, voucherDate: sql`${voucherBookedOnSql}::text`.mapWith(String) })
        .from(vouchers)
        .where(and(...voucherConditions))
        .execute();

      // Group voucher IDs by YYYY-MM
      const vouchersByMonth = new Map<string, number[]>();
      for (const v of allPeriodVouchers) {
        const mk = String(v.voucherDate).slice(0, 7);
        if (!vouchersByMonth.has(mk)) vouchersByMonth.set(mk, []);
        vouchersByMonth.get(mk)!.push(v.id);
      }
      const sortedMonths = Array.from(vouchersByMonth.keys()).sort();

      // Fetch ALL entries for ALL period vouchers at once.
      // COALESCE(base_debit_amount, debit_amount): uses historical USD base when available.
      const allPeriodVoucherIds = allPeriodVouchers.map((v) => v.id);
      const allPeriodEntries =
        allPeriodVoucherIds.length > 0
          ? await db
              .select({
                ledgerAccountId: voucherEntries.ledgerAccountId,
                voucherId: voucherEntries.voucherId,
                debitAmount: sql<string>`COALESCE("voucher_entries"."base_debit_amount", "voucher_entries"."debit_amount")`,
                creditAmount: sql<string>`COALESCE("voucher_entries"."base_credit_amount", "voucher_entries"."credit_amount")`,
              })
              .from(voucherEntries)
              .where(inArray(voucherEntries.voucherId, allPeriodVoucherIds))
              .execute()
          : [];

      // Map entries by voucherId for fast monthly lookup
      const entriesByVoucherId = new Map<number, NetProfitBalanceEntry[]>();
      for (const e of allPeriodEntries) {
        if (!entriesByVoucherId.has(e.voucherId)) entriesByVoucherId.set(e.voucherId, []);
        entriesByVoucherId.get(e.voucherId)!.push(e);
      }

      // Fetch ALL sales with dates for the period
      const salesConditions = [
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        eq(vouchers.optional, false),
      ];
      if (startDate) salesConditions.push(gte(voucherBookedOnSql, startDate.toISOString().split("T")[0]));
      if (endDate) salesConditions.push(lte(voucherBookedOnSql, endDate.toISOString().split("T")[0]));
      const allSalesRows = await db
        .select({ voucherDate: sql`${voucherBookedOnSql}::text`.mapWith(String), total: salesItems.totalSales })
        .from(salesItems)
        .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
        .where(and(...salesConditions))
        .execute();

      // Group POS sales by month
      const ZERO = new MoneyDecimal(0);
      const salesByMonth = new Map<string, Decimal>();
      let totalSalesAll = ZERO;
      for (const s of allSalesRows) {
        const mk = String(s.voucherDate).slice(0, 7);
        const v = toMoney(s.total);
        salesByMonth.set(mk, (salesByMonth.get(mk) ?? ZERO).plus(v));
        totalSalesAll = totalSalesAll.plus(v);
      }

      // ERP voucher-based income: the income accounts read through the sales
      // total (SALES-named and uncategorised income, netProfitSection
      // "salesAccount") that appear in non-POS vouchers. Direct and indirect
      // income have their own sections.
      const importChargesParent = companyAccounts.find((acc) => acc.code === "IMPORT_CHARGES");
      const importChargesIds = new Set<number>();
      if (importChargesParent) {
        importChargesIds.add(importChargesParent.id);
        companyAccounts.forEach((acc) => {
          if (acc.parentId === importChargesParent.id) importChargesIds.add(acc.id);
        });
      }
      const xlsxMissedIncomeAccounts = companyAccounts.filter(
        (acc) => netProfitSection(acc, importChargesIds) === "salesAccount"
      );
      // Re-fetch pos voucher IDs for the period to exclude from ERP income calculation
      const posPeriodVouchersXlsx =
        allPeriodVoucherIds.length > 0 && xlsxMissedIncomeAccounts.length > 0
          ? await db
              .select({ voucherId: salesItems.voucherId })
              .from(salesItems)
              .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
              .where(and(...salesConditions))
              .execute()
          : [];
      const posVIdSetXlsx = new Set(posPeriodVouchersXlsx.map((r) => r.voucherId));
      const nonPosVIdsXlsx = allPeriodVoucherIds.filter((id) => !posVIdSetXlsx.has(id));

      // Map voucherId → voucherDate for nonPosVouchers
      const voucherDateMap = new Map<number, string>();
      for (const v of allPeriodVouchers) voucherDateMap.set(v.id, v.voucherDate as string);

      if (xlsxMissedIncomeAccounts.length > 0 && nonPosVIdsXlsx.length > 0) {
        const missedAccIdsXlsx = xlsxMissedIncomeAccounts.map((a) => a.id);
        const erpIncEntries = await db
          .select({
            ledgerAccountId: voucherEntries.ledgerAccountId,
            voucherId: voucherEntries.voucherId,
            debitAmount: sql<string>`COALESCE("voucher_entries"."base_debit_amount", "voucher_entries"."debit_amount")`,
            creditAmount: sql<string>`COALESCE("voucher_entries"."base_credit_amount", "voucher_entries"."credit_amount")`,
          })
          .from(voucherEntries)
          .where(
            and(
              inArray(voucherEntries.voucherId, nonPosVIdsXlsx),
              inArray(voucherEntries.ledgerAccountId, missedAccIdsXlsx)
            )
          )
          .execute();
        for (const e of erpIncEntries) {
          const net = toMoney(e.creditAmount).minus(toMoney(e.debitAmount));
          if (net.abs().lessThan(0.001)) continue;
          const vDate = voucherDateMap.get(e.voucherId);
          if (!vDate) continue;
          const mk = vDate.slice(0, 7);
          salesByMonth.set(mk, (salesByMonth.get(mk) ?? ZERO).plus(net));
          totalSalesAll = totalSalesAll.plus(net);
        }
      }

      // Opening and closing stock (wave 11): the one stock valuation
      // (stockValuation.ts, SUM(total_value), negative stock not subtracting).
      // With a period start the opening stock is the valuation as of the day
      // before it (replayed from the stored values), not the stock items'
      // opening master data, which is the opening of all time and says nothing
      // about a later period. Without one (all time) the master data is the
      // only opening there is. The closing stock is the valuation as of the
      // period end (live when the period runs to today or later).
      const isoDate = (date: Date) => date.toISOString().split("T")[0];
      const today = isoDate(new Date());
      let openingStockValue = 0;
      if (!ledgerStock) {
        if (startDate) {
          const eve = new Date(startDate.getTime());
          eve.setUTCDate(eve.getUTCDate() - 1);
          openingStockValue = Number(await companyStockValue(db, companyId, isoDate(eve)));
        } else {
          const allStockItems = await storage.getAllStockItems(companyId);
          openingStockValue = sumMoney(allStockItems.map((item) => item.openingValue)).toNumber();
        }
      }
      const closingAsOf = endDate && isoDate(endDate) < today ? isoDate(endDate) : null;
      const closingStockExact = ledgerStock ? ZERO : toMoney(await companyStockValue(db, companyId, closingAsOf));
      const closingStockValue = closingStockExact.toNumber();

      // Net position (wave 13, R5/X4): the one dated net position,
      // calculateNetPositionAsOf as of the period end (today for all time),
      // which takes ledger accounts, banks, customers, suppliers and employees
      // from the balance engine and lists unposted amounts apart. The workbook
      // used to compute its own: it divided USD-base Cash balances by the CFA
      // rate, took the payroll from employees.current_balance and read no bank
      // accounts or customers. The sheets do not print it (their layout is
      // unchanged); it is recorded in the workbook's description.
      const netPositionAsOf = endDate && isoDate(endDate) < today ? isoDate(endDate) : today;
      const netPosition = await calculateNetPositionAsOf(companyId, netPositionAsOf);
      const netPositionValue = netPosition.netPosition;

      // Bundled once and passed to every stats/sheet call; these three were
      // captured from this scope before the sheet code moved out.
      const sheetCtx: NetProfitSheetContext = {
        companyAccounts,
        importChargesIds,
        companyName,
      };

      const ExcelJS = await import("exceljs");
      const workbook = new ExcelJS.default.Workbook();
      workbook.creator = "ERP System";
      workbook.created = new Date();
      workbook.description = `Net position as of ${netPositionAsOf}: ${netPositionValue.toFixed(2)}`;

      if (sortedMonths.length > 1) {
        // Summary sheet first (one column per month + grand total)
        const allBalances = computeBalancesFromEntries(allPeriodEntries);
        const totalStats = computeStats(
          sheetCtx,
          allBalances,
          totalSalesAll.toNumber(),
          openingStockValue,
          closingStockValue,
          false
        );
        const monthStatsList = sortedMonths.map((mk) => {
          const monthVIds = vouchersByMonth.get(mk)!;
          const monthEntries = monthVIds.flatMap((id) => entriesByVoucherId.get(id) || []);
          const monthBalances = computeBalancesFromEntries(monthEntries);
          const monthSales = (salesByMonth.get(mk) ?? ZERO).toNumber();
          return computeStats(sheetCtx, monthBalances, monthSales, 0, 0, true);
        });
        const monthLabels = sortedMonths.map(fmtMonthLabel);

        const summaryWs = workbook.addWorksheet("Summary");
        writeSummarySheet(sheetCtx, summaryWs, monthStatsList, totalStats, monthLabels, netPositionValue);

        // One detail sheet per month
        for (let i = 0; i < sortedMonths.length; i++) {
          const mk = sortedMonths[i];
          const ws = workbook.addWorksheet(fmtMonthLabel(mk));
          writeSheet(sheetCtx, ws, monthStatsList[i], fmtMonthLabel(mk), false, 0);
        }
      } else {
        // Single sheet
        const allBalances = computeBalancesFromEntries(allPeriodEntries);
        const stats = computeStats(
          sheetCtx,
          allBalances,
          totalSalesAll.toNumber(),
          openingStockValue,
          closingStockValue,
          false
        );
        const ws = workbook.addWorksheet("Net Profit Report");
        writeSheet(sheetCtx, ws, stats, periodLabel, false, 0);
      }

      const safeCompanyName = companyName.replace(/[^a-z0-9]/gi, "_");
      const safePeriod = periodLabel.replace(/[^a-z0-9]/gi, "_");
      const xlsBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
      // Non-fatal audit write: must not corrupt the export response if it fails
      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || req.session.userId!,
          companyId: companyId!,
          action: "export",
          tableName: "reports",
          recordId: null,
          recordIdentifier: `Net Profit Excel — ${periodLabel}`,
          changes: { format: { old: null, new: "xlsx" } },
        });
      } catch (auditErr) {
        logger.error("[NetProfitExcel] audit write failed:", { error: auditErr });
      }
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="NetProfit_${safeCompanyName}_${safePeriod}.xlsx"`);
      res.setHeader("Content-Length", xlsBuffer.byteLength);
      res.end(xlsBuffer);
    } catch (error: unknown) {
      logger.error("Net profit Excel export error:", { error: error });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─── Agent Accounts ──────────────────────────────────────────────────────
}
