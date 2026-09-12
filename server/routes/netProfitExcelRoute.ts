import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { logAudit } from "./_helpers";
import {
  inventory,
  containers,
  vouchers,
  voucherEntries,
  salesItems,
  suppliers,
  locations,
  employees,
  exchangeRates,
} from "@shared/schema";
import { eq, and, desc, inArray, sql, isNull, gte, lte } from "drizzle-orm";
import {
  computeBalancesFromEntries,
  computeStats,
  fmtMonthLabel,
  writeSheet,
  writeSummarySheet,
  type NetProfitBalanceEntry,
  type NetProfitSheetContext,
} from "./netProfitExcelSheets";

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

      const companyAccounts = await storage.getAllLedgerAccounts(companyId, true);

      // Fetch period vouchers WITH their dates for monthly grouping
      const voucherConditions = [
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        eq(vouchers.optional, false),
      ];
      if (startDate) voucherConditions.push(gte(vouchers.voucherDate, startDate.toISOString().split("T")[0]));
      if (endDate) voucherConditions.push(lte(vouchers.voucherDate, endDate.toISOString().split("T")[0]));

      const allPeriodVouchers = await db
        .select({ id: vouchers.id, voucherDate: vouchers.voucherDate })
        .from(vouchers)
        .where(and(...voucherConditions))
        .execute();

      // Group voucher IDs by YYYY-MM
      const vouchersByMonth = new Map<string, number[]>();
      for (const v of allPeriodVouchers) {
        const d = new Date(v.voucherDate);
        const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
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
      if (startDate) salesConditions.push(gte(vouchers.voucherDate, startDate.toISOString().split("T")[0]));
      if (endDate) salesConditions.push(lte(vouchers.voucherDate, endDate.toISOString().split("T")[0]));
      const allSalesRows = await db
        .select({ voucherDate: vouchers.voucherDate, total: salesItems.totalSales })
        .from(salesItems)
        .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
        .where(and(...salesConditions))
        .execute();

      // Group POS sales by month
      const salesByMonth = new Map<string, number>();
      let totalSalesAll = 0;
      for (const s of allSalesRows) {
        const d = new Date(s.voucherDate);
        const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const v = parseFloat(s.total || "0");
        salesByMonth.set(mk, (salesByMonth.get(mk) || 0) + v);
        totalSalesAll += v;
      }

      // ERP voucher-based income: income accounts excluded from directIncomes/indirectIncomes
      // (SALES-named accounts and uncategorized income) that appear in non-POS vouchers.
      const xlsxMissedIncomeAccounts = companyAccounts.filter((acc) => {
        if (acc.accountType !== "Income") return false;
        if (acc.subType === "Indirect Income") return false;
        if (
          acc.subType === "Direct Income" &&
          !acc.code?.includes("SALES") &&
          !acc.name?.toLowerCase().includes("sales")
        )
          return false;
        return true;
      });
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
          const credit = parseFloat(e.creditAmount || "0");
          const debit = parseFloat(e.debitAmount || "0");
          const net = credit - debit;
          if (Math.abs(net) < 0.001) continue;
          const vDate = voucherDateMap.get(e.voucherId);
          if (!vDate) continue;
          const d = new Date(vDate);
          const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          salesByMonth.set(mk, (salesByMonth.get(mk) || 0) + net);
          totalSalesAll += net;
        }
      }

      // allTimeAccountBalances for Net Position (no startDate filter)
      const allTimeConds = [
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        eq(vouchers.optional, false),
      ];
      if (endDate) allTimeConds.push(lte(vouchers.voucherDate, endDate.toISOString().split("T")[0]));
      const allTimeVsXlsx = await db
        .select({ id: vouchers.id })
        .from(vouchers)
        .where(and(...allTimeConds))
        .execute();
      const allTimeIdsXlsx = allTimeVsXlsx.map((v) => v.id);
      const allTimeEntriesXlsx =
        allTimeIdsXlsx.length > 0
          ? await db
              .select({
                ledgerAccountId: voucherEntries.ledgerAccountId,
                debitAmount: sql<string>`COALESCE("voucher_entries"."base_debit_amount", "voucher_entries"."debit_amount")`,
                creditAmount: sql<string>`COALESCE("voucher_entries"."base_credit_amount", "voucher_entries"."credit_amount")`,
              })
              .from(voucherEntries)
              .where(inArray(voucherEntries.voucherId, allTimeIdsXlsx))
              .execute()
          : [];
      const allTimeBalsXlsx = new Map<number, { debit: number; credit: number }>();
      for (const e of allTimeEntriesXlsx) {
        if (e.ledgerAccountId) {
          const d = parseFloat(e.debitAmount || "0"),
            c = parseFloat(e.creditAmount || "0");
          const cur = allTimeBalsXlsx.get(e.ledgerAccountId) || { debit: 0, credit: 0 };
          allTimeBalsXlsx.set(e.ledgerAccountId, { debit: cur.debit + d, credit: cur.credit + c });
        }
      }

      // Opening Stock
      const allStockItems = await storage.getAllStockItems(companyId);
      let openingStockValue = 0;
      for (const item of allStockItems) openingStockValue += parseFloat(item.openingValue || "0");

      // Closing Stock (current inventory)
      const activeLocData = await db
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.companyId, companyId), eq(locations.active, true), isNull(locations.deletedAt)))
        .execute();
      const activeLocIds = activeLocData.map((l) => l.id);
      let closingStockValue = 0;
      if (activeLocIds.length > 0) {
        const invData = await db
          .select({ quantity: inventory.quantity, averageRate: inventory.averageRate })
          .from(inventory)
          .where(inArray(inventory.locationId, activeLocIds))
          .execute();
        for (const inv of invData)
          closingStockValue += parseFloat(inv.quantity || "0") * parseFloat(inv.averageRate || "0");
      }

      // Net Position - same calculation as dashboard (/api/stats/net-profit)
      const npRound2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

      // Build supplier balance map from all-time entries
      const xlsxSupplierBals = new Map<number, { debit: number; credit: number }>();
      for (const e of allTimeEntriesXlsx) {
        if (
          (
            e as unknown as { ledgerAccountId: number | null; debitAmount: string; creditAmount: string } & {
              supplierId: unknown;
            }
          ).supplierId
        ) {
          const d = parseFloat(e.debitAmount || "0"),
            c = parseFloat(e.creditAmount || "0");
          const cur = xlsxSupplierBals.get(
            (
              e as unknown as { ledgerAccountId: number | null; debitAmount: string; creditAmount: string } & {
                supplierId: number;
              }
            ).supplierId
          ) || { debit: 0, credit: 0 };
          xlsxSupplierBals.set(
            (
              e as unknown as { ledgerAccountId: number | null; debitAmount: string; creditAmount: string } & {
                supplierId: number;
              }
            ).supplierId,
            { debit: cur.debit + d, credit: cur.credit + c }
          );
        }
      }

      // Account exclusion rules matching dashboard
      const npExcludedTypes = ["Income", "Profit", "Equity", "EQUITY", "Fixed Asset"];
      const npExpenseTypes = ["Expense", "Direct Expense", "Indirect Expense"];
      const _npLiabilityTypes = ["Liability", "Duty Agent", "Transporter Agent", "Loan"];
      const npAssetTypes = ["Asset", "Current Asset", "Fixed Asset", "Bank", "Cash"];
      const npStockPatterns = [
        "closing stock",
        "opening stock",
        "stock in hand",
        "stock on hand",
        "inventory",
        "stock account",
        "goods in stock",
        "merchandise",
      ];
      const npStockCodes = ["CLOSING_STOCK", "OPENING_STOCK", "STOCK", "INVENTORY", "STOCK_IN_HAND"];
      const npFixedAssetNames = [
        "rover",
        "toyota",
        "mercedes",
        "vehicle",
        "car",
        "truck",
        "land",
        "property",
        "building",
        "house",
        "rolex",
        "watch",
        "luxury",
        "jewelry",
        "guarantee",
        "deposit",
        "caution",
      ];
      const isExcludedFromNp = (acc: { code: string; id: number; name: string; active: boolean; createdAt: Date; companyId: number; deletedAt: Date | null; accountType: string; subType: string | null; parentId: number | null; openingBalance: string | null; openingBalanceSide: string | null; openingBalanceNativeAmount: string | null; openingBalanceCurrency: string | null; openingBalanceHistoricalRate: string | null; openingBalanceBaseAmount: string | null; isHidden: boolean; }) => {
        if (npExcludedTypes.includes(acc.accountType || "")) return true;
        if (acc.code === "PRODUCTION_ADJUSTMENT" || acc.code === "CONSUMPTION_EXPENSE") return true;
        const nameLower = (acc.name || "").toLowerCase();
        const codeLower = (acc.code || "").toLowerCase();
        if (npAssetTypes.includes(acc.accountType || "")) {
          if (npStockPatterns.some((p: string) => nameLower.includes(p))) return true;
          if (
            npStockCodes.some(
              (c: string) => codeLower === c.toLowerCase() || codeLower.startsWith(c.toLowerCase() + "_")
            )
          )
            return true;
          if (npFixedAssetNames.some((p: string) => nameLower.includes(p))) return true;
        }
        return false;
      };

      // CFA revaluation: Cash accounts hold physical CFA units — their USD worth changes with the rate.
      const xlsxCfaRateRows = await db
        .select()
        .from(exchangeRates)
        .where(
          and(
            eq(exchangeRates.companyId, companyId),
            eq(exchangeRates.fromCurrency, "USD"),
            eq(exchangeRates.toCurrency, "CFA")
          )
        )
        .orderBy(desc(exchangeRates.effectiveDate))
        .limit(1);
      const xlsxCurrentCfaRate = xlsxCfaRateRows.length > 0 ? parseFloat(xlsxCfaRateRows[0].rate) : 0;

      let npForUs = 0,
        npOnUs = 0;
      for (const acc of companyAccounts) {
        if (npExpenseTypes.includes(acc.accountType || "")) continue;
        if (acc.accountType === "Income") continue;
        if (isExcludedFromNp(acc)) continue;
        const opening = parseFloat(acc.openingBalance || "0");
        const openingSigned = acc.openingBalanceSide === "Dr" ? opening : -opening;
        const bal = allTimeBalsXlsx.get(acc.id) || { debit: 0, credit: 0 };
        let net = openingSigned + bal.debit - bal.credit;
        // Revalue Cash accounts: amounts are in CFA, divide by current rate to get USD
        if (xlsxCurrentCfaRate > 0 && acc.accountType === "Cash") {
          net = net / xlsxCurrentCfaRate;
        }
        if (net > 0) npForUs += net;
        else if (net < 0) npOnUs += Math.abs(net);
      }

      // For All Time (no endDate): include inventory, workers, OTW — current values match the dashboard.
      // For specific periods (endDate set): skip these non-date-bounded components.
      const xlsxIsAllTime = !endDate;
      if (xlsxIsAllTime) {
        // Add stock on floor (inventory) as asset
        npForUs += closingStockValue;

        // Add worker/employee liabilities
        const xlsxEmployees = await db
          .select()
          .from(employees)
          .where(and(eq(employees.companyId, companyId), eq(employees.active, true), isNull(employees.deletedAt)))
          .execute();
        let xlsxWorkerBal = 0;
        for (const emp of xlsxEmployees) xlsxWorkerBal += parseFloat(emp.currentBalance || "0");
        if (xlsxWorkerBal > 0) npOnUs += xlsxWorkerBal;
        else if (xlsxWorkerBal < 0) npForUs += Math.abs(xlsxWorkerBal);

        // Add OTW containers as assets
        const xlsxOtwContainers = await db
          .select()
          .from(containers)
          .where(and(eq(containers.companyId, companyId), eq(containers.status, "OTW")))
          .execute();
        for (const c of xlsxOtwContainers) {
          npForUs += parseFloat(c.grandTotal || c.itemsTotal || "0");
        }
      }

      // Add suppliers (always included — xlsxSupplierBals is already bounded by endDate)
      const xlsxParentCompanyId = await storage.getParentCompanyId();
      const xlsxShouldIncludeSuppliers = xlsxParentCompanyId === null || companyId === xlsxParentCompanyId;
      if (xlsxShouldIncludeSuppliers) {
        const xlsxAllSuppliers = await db.select().from(suppliers).where(isNull(suppliers.deletedAt)).execute();
        for (const sup of xlsxAllSuppliers) {
          const balance = xlsxSupplierBals.get(sup.id);
          if (balance) {
            const opening = parseFloat(sup.openingBalance || "0");
            const netBalance = opening + balance.credit - balance.debit;
            if (netBalance > 0) npOnUs += netBalance;
            else if (netBalance < 0) npForUs += Math.abs(netBalance);
          }
        }
      }

      const netPositionValue = npRound2(npForUs - npOnUs);

      // Import charges IDs
      const importChargesParent = companyAccounts.find((acc) => acc.code === "IMPORT_CHARGES");
      const importChargesIds = new Set<number>();
      if (importChargesParent) {
        importChargesIds.add(importChargesParent.id);
        companyAccounts.forEach((acc) => {
          if (acc.parentId === importChargesParent.id) importChargesIds.add(acc.id);
        });
      }

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

      if (sortedMonths.length > 1) {
        // Summary sheet first (one column per month + grand total)
        const allBalances = computeBalancesFromEntries(allPeriodEntries);
        const totalStats = computeStats(
          sheetCtx,
          allBalances,
          totalSalesAll,
          openingStockValue,
          closingStockValue,
          false
        );
        const monthStatsList = sortedMonths.map((mk) => {
          const monthVIds = vouchersByMonth.get(mk)!;
          const monthEntries = monthVIds.flatMap((id) => entriesByVoucherId.get(id) || []);
          const monthBalances = computeBalancesFromEntries(monthEntries);
          const monthSales = salesByMonth.get(mk) || 0;
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
        const stats = computeStats(sheetCtx, allBalances, totalSalesAll, openingStockValue, closingStockValue, false);
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
