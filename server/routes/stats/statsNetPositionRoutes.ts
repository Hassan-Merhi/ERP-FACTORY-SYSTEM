import ExcelJS from "exceljs";
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db, pool } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { logAudit, calculateHistoricalLocationInventory } from "../_helpers";
import { getClientDate } from "../../lib/dateUtils";
import { inventory, containers, vouchers, suppliers, locations, factoryWorkerAdvances } from "@shared/schema";
import { eq, and, or, inArray, sql, isNull, lte } from "drizzle-orm";
import {
  classifyEquityAccounts,
  classifyNetPositionAccounts,
  round2,
  type NetPositionAccount,
} from "../../netPositionHelper";
import { getSupplierPartnerCustomerNetPosition } from "../../helpers/supplierPartnerCustomerNetPosition";

export function registerStatsNetPositionRoutes(app: Express) {
  app.get("/api/stats/net-position-excel", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Cumulative "as of" date — same approach as /api/stats/net-profit
      const fromDate = req.query.fromDate ? String(req.query.fromDate) : null;
      const toDate = req.query.toDate ? String(req.query.toDate) : null;

      const allCompanies = await storage.getAllCompanies();
      const company = allCompanies.find((c) => c.id === companyId);
      const companyName = company?.name || "Company";

      // ── 1. Accounts & voucher entries (cumulative up to toDate) ──────────
      const companyAccounts = await storage.getAllLedgerAccounts(companyId, true);

      const voucherConds = [
        eq(vouchers.companyId, companyId),
        eq(vouchers.optional, false),
        isNull(vouchers.deletedAt),
      ];
      if (toDate) voucherConds.push(lte(vouchers.voucherDate, toDate));

      const voucherAcctConds = [eq(vouchers.optional, false), isNull(vouchers.deletedAt)];
      if (toDate) voucherAcctConds.push(lte(vouchers.voucherDate, toDate));

      // Two separate queries — see net-profit route for rationale:
      // companyEntries  → supplier/employee balances (scoped to voucher's company)
      // ledgerAccEntries → ledger account balances (scoped to account's company so
      //                    migrated accounts appear correctly in the destination)
      //
      // COALESCE(base_debit_amount, debit_amount): uses historical USD base when available
      // (i.e. after backfill), falls back to debit_amount for legacy rows.
      const _npExcelParams = toDate ? [companyId, toDate] : [companyId];
      const _npExcelDateClause = toDate ? "AND v.voucher_date <= $2" : "";

      const [companyEntriesRaw, ledgerAccEntriesRaw] = await Promise.all([
        pool.query<{
          ledger_account_id: string;
          supplier_id: string | null;
          debit_amount: string;
          credit_amount: string;
        }>(
          `SELECT ve.ledger_account_id,
                  ve.supplier_id,
                  COALESCE(ve.base_debit_amount,  ve.debit_amount)  AS debit_amount,
                  COALESCE(ve.base_credit_amount, ve.credit_amount) AS credit_amount
           FROM voucher_entries ve
           JOIN vouchers v ON ve.voucher_id = v.id
           WHERE v.company_id = $1
             AND v.optional   = false
             AND v.deleted_at IS NULL
             ${_npExcelDateClause}`,
          _npExcelParams
        ),
        pool.query<{ ledger_account_id: string; debit_amount: string; credit_amount: string }>(
          `SELECT ve.ledger_account_id,
                  COALESCE(ve.base_debit_amount,  ve.debit_amount)  AS debit_amount,
                  COALESCE(ve.base_credit_amount, ve.credit_amount) AS credit_amount
           FROM voucher_entries ve
           JOIN vouchers        v  ON ve.voucher_id        = v.id
           JOIN ledger_accounts la ON ve.ledger_account_id = la.id
           WHERE la.company_id = $1
             AND v.optional    = false
             AND v.deleted_at IS NULL
             ${_npExcelDateClause}`,
          _npExcelParams
        ),
      ]);

      const companyEntries = companyEntriesRaw.rows;
      const ledgerAccEntries = ledgerAccEntriesRaw.rows;

      const accountBalances = new Map<number, { debit: number; credit: number }>();
      const supplierBalances = new Map<number, { debit: number; credit: number }>();
      for (const e of ledgerAccEntries) {
        if (e.ledger_account_id) {
          const id = parseInt(e.ledger_account_id);
          const cur = accountBalances.get(id) || { debit: 0, credit: 0 };
          accountBalances.set(id, {
            debit: cur.debit + parseFloat(e.debit_amount || "0"),
            credit: cur.credit + parseFloat(e.credit_amount || "0"),
          });
        }
      }
      for (const e of companyEntries) {
        if (e.supplier_id) {
          const id = parseInt(e.supplier_id);
          const cur = supplierBalances.get(id) || { debit: 0, credit: 0 };
          supplierBalances.set(id, {
            debit: cur.debit + parseFloat(e.debit_amount || "0"),
            credit: cur.credit + parseFloat(e.credit_amount || "0"),
          });
        }
      }

      // ── 2. Classify accounts ──────────────────────────────────────────────
      const parentCompanyId = await storage.getParentCompanyId();
      const shouldIncludeSuppliers = parentCompanyId === null || companyId === parentCompanyId;
      // SP formula: Cash + Customer A/R + Stock (inventory) → What We Have; sp_payable and Loan/Loans → What We Owe.
      const isSupplierPartner = company?.companyType === "supplier_partner";
      const supplierPartnerCustomerPosition = isSupplierPartner
        ? await getSupplierPartnerCustomerNetPosition(companyId, toDate)
        : null;
      const accountsForClassify = isSupplierPartner
        ? companyAccounts.filter(
            (a) =>
              a.accountType === "Cash" ||
              a.accountType === "Loan" ||
              a.accountType === "Loans" ||
              ((a.accountType === "Customer" ||
                a.subType === "Accounts Receivable" ||
                (a.code || "").toUpperCase().startsWith("CUST-") ||
                (a.name || "").toLowerCase().includes("customer account")) &&
                !supplierPartnerCustomerPosition?.ledgerAccountIds.has(a.id)) ||
              a.subType === "sp_payable"
          )
        : companyAccounts.filter(
            (a) =>
              a.subType !== "sp_stock" &&
              a.subType !== "sp_cost_clearing" &&
              !(a.accountType === "Liability" && (a.name as string)?.startsWith("Insurance"))
          );
      const classified = classifyNetPositionAccounts(accountsForClassify, accountBalances, {
        includeSupplierTypeAccounts: shouldIncludeSuppliers,
      });
      const equity = classifyEquityAccounts(companyAccounts, accountBalances);
      let forUsTotal = classified.forUsTotal;
      let onUsTotal = classified.onUsTotal;
      const forUsAccounts = [...classified.forUsAccounts];
      const onUsAccounts = [...classified.onUsAccounts];

      if (supplierPartnerCustomerPosition) {
        for (const customer of supplierPartnerCustomerPosition.items) {
          const value = round2(Math.abs(customer.signedBalance));
          if (customer.signedBalance > 0) {
            forUsTotal = round2(forUsTotal + value);
            forUsAccounts.push({
              id: customer.ledgerAccountId ?? undefined,
              name: customer.name,
              code: customer.code,
              value,
              category: "Asset",
            });
          } else {
            onUsTotal = round2(onUsTotal + value);
            onUsAccounts.push({
              id: customer.ledgerAccountId ?? undefined,
              name: customer.name,
              code: customer.code,
              value,
              category: "Liability",
            });
          }
        }
        forUsAccounts.sort((a, b) => b.value - a.value);
        onUsAccounts.sort((a, b) => b.value - a.value);
      }

      // ── 3. Stock In Hand — historical as of toDate ────────────────────────
      const activeLocsData = await db
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.companyId, companyId), eq(locations.active, true), isNull(locations.deletedAt)))
        .execute();
      const activeLocIds = activeLocsData.map((l) => l.id);
      let stockOnFloor = 0;
      if (activeLocIds.length > 0) {
        if (toDate) {
          // Parallelize across locations — each location is independent
          const allHistorical = await Promise.all(
            activeLocIds.map((locId: number) => calculateHistoricalLocationInventory(locId, companyId, toDate))
          );
          for (const items of allHistorical) {
            for (const inv of items) {
              const qty = parseFloat(inv.quantity || "0");
              const rate = parseFloat(inv.averageRate || "0");
              if (qty > 0) stockOnFloor += qty * rate;
            }
          }
        } else {
          const invData = await db
            .select({ quantity: inventory.quantity, averageRate: inventory.averageRate })
            .from(inventory)
            .where(inArray(inventory.locationId, activeLocIds))
            .execute();
          for (const inv of invData)
            stockOnFloor += parseFloat(inv.quantity || "0") * parseFloat(inv.averageRate || "0");
        }
      }
      if (stockOnFloor > 0) {
        forUsTotal += stockOnFloor;
        forUsAccounts.push({
          name: "Stock In Hand (Inventory)",
          code: "COMPUTED",
          value: stockOnFloor,
          category: "Inventory",
        });
      }

      // ── 4. Factory worker advances only (Factory Net Position is isolated from ERP) ──
      // ERP employee advances are NOT included here — they belong in the ERP Net Position.
      // Factory workers live in factory_workers / factory_worker_advances tables, not employees.
      // Remove the "Factory Worker Advances" ledger account (replaced by table sum below).
      const fwaLedgerIdx2 = forUsAccounts.findIndex((a) => (a.name || "").toLowerCase() === "factory worker advances");
      if (fwaLedgerIdx2 !== -1) {
        forUsTotal = round2(forUsTotal - forUsAccounts[fwaLedgerIdx2].value);
        forUsAccounts.splice(fwaLedgerIdx2, 1);
      }
      // Use the authoritative factory_worker_advances table as the sole source.
      {
        const [fwAdvRow2] = await db
          .select({ total: sql<string>`COALESCE(SUM(CAST(remaining_balance AS numeric)), 0)` })
          .from(factoryWorkerAdvances)
          .where(and(eq(factoryWorkerAdvances.companyId, companyId), eq(factoryWorkerAdvances.fullyPaid, false)));
        const workerAdvances = parseFloat(fwAdvRow2?.total || "0");
        if (workerAdvances > 0) {
          forUsTotal += workerAdvances;
          forUsAccounts.push({
            name: "Worker Advances (Prepaid)",
            code: "COMPUTED",
            value: workerAdvances,
            category: "Worker Advances",
          });
        }
      }

      // ── 5. Supplier balances ──────────────────────────────────────────────
      if (shouldIncludeSuppliers) {
        // Only fetch suppliers that appear in this company's entries (avoids full-table scan)
        const supplierIdsWithBalance = [...supplierBalances.keys()];
        const allSuppliers =
          supplierIdsWithBalance.length > 0
            ? await db
                .select()
                .from(suppliers)
                .where(and(isNull(suppliers.deletedAt), inArray(suppliers.id, supplierIdsWithBalance)))
                .execute()
            : [];
        let supplierLiabilities = 0;
        let supplierAssets = 0;
        for (const sup of allSuppliers) {
          const balance = supplierBalances.get(sup.id);
          if (balance) {
            const opening = parseFloat(sup.openingBalance || "0");
            const netBalance = opening + balance.credit - balance.debit;
            if (netBalance > 0) {
              supplierLiabilities += netBalance;
              onUsAccounts.push({ name: sup.legalName, code: sup.code || "", value: netBalance, category: "Supplier" });
            } else if (netBalance < 0) {
              supplierAssets += Math.abs(netBalance);
              forUsAccounts.push({
                name: sup.legalName,
                code: sup.code || "",
                value: Math.abs(netBalance),
                category: "Supplier Overpayment",
              });
            }
          }
        }
        if (supplierLiabilities > 0) onUsTotal += supplierLiabilities;
        if (supplierAssets > 0) forUsTotal += supplierAssets;
      }

      // ── 6. OTW containers — historical as of toDate ───────────────────────
      // Same logic as the main endpoint: use status='OFFLOADED' (not offloadDate) as the
      // authoritative indicator that a container left OTW status.
      const excelOtwQuery = toDate
        ? and(
            eq(containers.companyId, companyId),
            lte(containers.importDate, toDate),
            or(
              eq(containers.status, "OTW"),
              and(eq(containers.status, "OFFLOADED"), sql`${containers.offloadDate} > ${toDate}`)
            )
          )
        : and(eq(containers.companyId, companyId), eq(containers.status, "OTW"));
      const otwContainers = await db.select().from(containers).where(excelOtwQuery).execute();
      let stockOtwValue = 0;
      for (const container of otwContainers) {
        const gTotal = parseFloat(container.grandTotal ?? "0");
        stockOtwValue += gTotal || parseFloat(container.itemsTotal ?? "0");
      }
      if (stockOtwValue > 0) {
        forUsTotal += stockOtwValue;
        forUsAccounts.push({
          name: "Stock On The Way",
          code: "STOCK_OTW",
          value: stockOtwValue,
          category: "Stock OTW",
        });
      }

      const equityContribution = isSupplierPartner ? equity.total : 0;
      const netPosition = round2(forUsTotal - onUsTotal + equityContribution);
      forUsTotal = round2(forUsTotal);
      onUsTotal = round2(onUsTotal);

      // ── 5. Build Excel ────────────────────────────────────────────────────
      const ExcelJS = await import("exceljs");
      const wb = new ExcelJS.default.Workbook();
      wb.creator = companyName;
      wb.created = new Date();

      const DARK_GREEN = "FF1A6B3C";
      const DARK_RED = "FF8B1A1A";
      const DARK_NAVY = "FF1F3864";
      const LIGHT_GREEN = "FFE8F5E9";
      const LIGHT_RED = "FFFDECEA";
      const ALT_ROW = "FFF5F5F5";
      const NUM_FMT = "#,##0.00";

      const currency = (n: number) =>
        `$${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`;

      // ── Sheet 1: Summary ──────────────────────────────────────────────────
      // ── Merge stock accounts into one combined Inventory line (Excel) ────────
      {
        const isStockEntry = (a: NetPositionAccount) => {
          const nl = (a.name || "").toLowerCase();
          const cat = (a.category || "").toLowerCase();
          return cat === "inventory" || nl.includes("stock in hand") || nl.includes("stock on floor");
        };
        const stockEntries = forUsAccounts.filter(isStockEntry);
        if (stockEntries.length > 1) {
          const combined = round2(stockEntries.reduce((s: number, a) => s + (a.value || 0), 0));
          for (let i = forUsAccounts.length - 1; i >= 0; i--) {
            if (isStockEntry(forUsAccounts[i])) forUsAccounts.splice(i, 1);
          }
          if (combined > 0) {
            forUsAccounts.push({
              name: "Stock In Hand / Stock on Floor",
              code: "COMPUTED",
              value: combined,
              category: "Inventory",
            });
          }
        } else if (stockEntries.length === 1 && stockEntries[0].name !== "Stock In Hand / Stock on Floor") {
          stockEntries[0].name = "Stock In Hand / Stock on Floor";
        }
      }

      const ws1 = wb.addWorksheet("Net Position Summary");
      ws1.columns = [
        { key: "label", width: 35 },
        { key: "value", width: 22 },
        { key: "note", width: 40 },
      ];

      const addTitle = (ws: ExcelJS.Worksheet, text: string, argb: string) => {
        const row = ws.addRow([text]);
        row.height = 28;
        const cell = row.getCell(1);
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 14 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
        cell.alignment = { vertical: "middle" };
        ws.mergeCells(`A${row.number}:C${row.number}`);
      };

      const addSubheader = (ws: ExcelJS.Worksheet, text: string, argb: string) => {
        const row = ws.addRow([text]);
        row.height = 18;
        const cell = row.getCell(1);
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
        ws.mergeCells(`A${row.number}:C${row.number}`);
      };

      addTitle(ws1, `${companyName} — Net Position Report`, DARK_NAVY);

      const dateRange =
        fromDate && toDate
          ? `${fromDate} to ${toDate}`
          : fromDate
            ? `From ${fromDate}`
            : toDate
              ? `Up to ${toDate}`
              : "All Time";
      const metaRow = ws1.addRow([`Date Range: ${dateRange}`, "", `Generated: ${new Date().toLocaleDateString()}`]);
      metaRow.getCell(1).font = { italic: true, color: { argb: "FF555555" } };
      metaRow.getCell(3).font = { italic: true, color: { argb: "FF555555" } };
      metaRow.getCell(3).alignment = { horizontal: "right" };
      ws1.addRow([]);

      // Formula banner
      addSubheader(ws1, "Net Position Formula", DARK_NAVY);
      const formulaRow = ws1.addRow(["What We Have  −  What We Owe  =  Net Position"]);
      ws1.mergeCells(`A${formulaRow.number}:C${formulaRow.number}`);
      formulaRow.getCell(1).font = { bold: true, size: 12 };
      formulaRow.height = 20;

      ws1.addRow([]);

      // Summary table
      const sumHeaders = ws1.addRow(["Category", "Amount (USD)", "Notes"]);
      sumHeaders.height = 18;
      sumHeaders.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DARK_NAVY } };
        cell.alignment = { horizontal: "center" };
      });

      const haveRow = ws1.addRow([
        "What We Have (Total Assets)",
        currency(round2(forUsTotal)),
        `${forUsAccounts.length} accounts`,
      ]);
      haveRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_GREEN } };
      haveRow.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_GREEN } };
      haveRow.getCell(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_GREEN } };
      haveRow.getCell(1).font = { bold: true, color: { argb: DARK_GREEN } };
      haveRow.getCell(2).font = { bold: true, color: { argb: DARK_GREEN } };
      haveRow.getCell(2).alignment = { horizontal: "right" };

      const oweRow = ws1.addRow([
        "What We Owe (Total Liabilities)",
        currency(round2(onUsTotal)),
        `${onUsAccounts.length} accounts`,
      ]);
      oweRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_RED } };
      oweRow.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_RED } };
      oweRow.getCell(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_RED } };
      oweRow.getCell(1).font = { bold: true, color: { argb: DARK_RED } };
      oweRow.getCell(2).font = { bold: true, color: { argb: DARK_RED } };
      oweRow.getCell(2).alignment = { horizontal: "right" };

      const netArgb = netPosition >= 0 ? DARK_GREEN : DARK_RED;
      const netBgArgb = netPosition >= 0 ? "FFD4EDDA" : "FFF8D7DA";
      const netRow = ws1.addRow([
        "Net Position",
        currency(round2(netPosition)),
        netPosition >= 0 ? "We have more than we owe" : "We owe more than we have",
      ]);
      [1, 2, 3].forEach((col) => {
        const cell = netRow.getCell(col);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: netBgArgb } };
        cell.font = { bold: true, size: 13, color: { argb: netArgb } };
      });
      netRow.getCell(2).alignment = { horizontal: "right" };
      netRow.height = 22;

      ws1.addRow([]);

      // Category breakdown — Assets
      addSubheader(ws1, "Assets Breakdown by Category", DARK_GREEN);
      const assetCatMap: Record<string, number> = {};
      for (const a of forUsAccounts)
        assetCatMap[a.category || "Other"] = (assetCatMap[a.category || "Other"] || 0) + a.value;
      const catHdr = ws1.addRow(["Category", "Total (USD)", ""]);
      catHdr.eachCell((cell) => {
        cell.font = { bold: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EAD3" } };
      });
      Object.entries(assetCatMap)
        .sort((a, b) => b[1] - a[1])
        .forEach(([cat, val], i) => {
          const r = ws1.addRow([cat, currency(round2(val)), ""]);
          if (i % 2 === 1)
            r.eachCell((c) => {
              c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ALT_ROW } };
            });
          r.getCell(2).alignment = { horizontal: "right" };
        });

      ws1.addRow([]);

      // Category breakdown — Liabilities
      addSubheader(ws1, "Liabilities Breakdown by Category", DARK_RED);
      const liabCatMap: Record<string, number> = {};
      for (const a of onUsAccounts)
        liabCatMap[a.category || "Other"] = (liabCatMap[a.category || "Other"] || 0) + a.value;
      const liabHdr = ws1.addRow(["Category", "Total (USD)", ""]);
      liabHdr.eachCell((cell) => {
        cell.font = { bold: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4CCCC" } };
      });
      Object.entries(liabCatMap)
        .sort((a, b) => b[1] - a[1])
        .forEach(([cat, val], i) => {
          const r = ws1.addRow([cat, currency(round2(val)), ""]);
          if (i % 2 === 1)
            r.eachCell((c) => {
              c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ALT_ROW } };
            });
          r.getCell(2).alignment = { horizontal: "right" };
        });

      // ── Sheet 2: What We Have (Assets) ────────────────────────────────────
      const ws2 = wb.addWorksheet("What We Have (Assets)");
      ws2.columns = [
        { key: "name", width: 40, header: "Account Name" },
        { key: "code", width: 18, header: "Code" },
        { key: "category", width: 22, header: "Category" },
        { key: "value", width: 20, header: "Balance (USD)" },
      ];
      const ws2Hdr = ws2.getRow(1);
      ws2Hdr.height = 20;
      ws2Hdr.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DARK_GREEN } };
        cell.alignment = { vertical: "middle", horizontal: "center" };
      });

      // Title row above headers
      ws2.spliceRows(1, 0, [`${companyName} — What We Have (Assets)  |  ${dateRange}`]);
      ws2.mergeCells("A1:D1");
      const ws2Title = ws2.getRow(1);
      ws2Title.getCell(1).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 13 };
      ws2Title.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: DARK_GREEN } };
      ws2Title.height = 24;

      const sortedAssets = [...forUsAccounts].sort((a, b) => b.value - a.value);
      sortedAssets.forEach((acc, i) => {
        const r = ws2.addRow({
          name: acc.name,
          code: acc.code || "",
          category: acc.category || "Other",
          value: round2(acc.value),
        });
        r.getCell("value").numFmt = NUM_FMT;
        r.getCell("value").alignment = { horizontal: "right" };
        if (i % 2 === 1)
          r.eachCell((c) => {
            c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ALT_ROW } };
          });
      });

      // Total row
      const assetTotalRow = ws2.addRow({ name: "TOTAL", code: "", category: "", value: round2(forUsTotal) });
      assetTotalRow.eachCell((c) => {
        c.font = { bold: true, color: { argb: DARK_GREEN } };
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_GREEN } };
      });
      assetTotalRow.getCell("value").numFmt = NUM_FMT;
      assetTotalRow.getCell("value").alignment = { horizontal: "right" };

      // ── Sheet 3: What We Owe (Liabilities) ───────────────────────────────
      const ws3 = wb.addWorksheet("What We Owe (Liabilities)");
      ws3.columns = [
        { key: "name", width: 40, header: "Account Name" },
        { key: "code", width: 18, header: "Code" },
        { key: "category", width: 22, header: "Category" },
        { key: "value", width: 20, header: "Balance (USD)" },
      ];
      ws3.spliceRows(1, 0, [`${companyName} — What We Owe (Liabilities)  |  ${dateRange}`]);
      ws3.mergeCells("A1:D1");
      const ws3Title = ws3.getRow(1);
      ws3Title.getCell(1).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 13 };
      ws3Title.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: DARK_RED } };
      ws3Title.height = 24;
      const ws3Hdr = ws3.getRow(2);
      ws3Hdr.height = 20;
      ws3Hdr.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DARK_RED } };
        cell.alignment = { vertical: "middle", horizontal: "center" };
      });

      const sortedLiabs = [...onUsAccounts].sort((a, b) => b.value - a.value);
      sortedLiabs.forEach((acc, i) => {
        const r = ws3.addRow({
          name: acc.name,
          code: acc.code || "",
          category: acc.category || "Other",
          value: round2(acc.value),
        });
        r.getCell("value").numFmt = NUM_FMT;
        r.getCell("value").alignment = { horizontal: "right" };
        if (i % 2 === 1)
          r.eachCell((c) => {
            c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ALT_ROW } };
          });
      });

      const liabTotalRow = ws3.addRow({ name: "TOTAL", code: "", category: "", value: round2(onUsTotal) });
      liabTotalRow.eachCell((c) => {
        c.font = { bold: true, color: { argb: DARK_RED } };
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_RED } };
      });
      liabTotalRow.getCell("value").numFmt = NUM_FMT;
      liabTotalRow.getCell("value").alignment = { horizontal: "right" };

      // ── Send file ─────────────────────────────────────────────────────────
      const dateTag = getClientDate(req);
      const xlsBuffer = Buffer.from(await wb.xlsx.writeBuffer());
      // Non-fatal: audit write must not block the Excel download
      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || req.session.userId!,
          companyId: companyId!,
          action: "export",
          tableName: "reports",
          recordId: null,
          recordIdentifier: `Net Position Excel — ${dateTag}`,
          changes: { format: { old: null, new: "xlsx" } },
        });
      } catch (auditErr) {
        logger.error("[NetPositionExcel] audit write failed:", { error: auditErr });
      }
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="Net_Position_${dateTag}.xlsx"`);
      res.setHeader("Content-Length", xlsBuffer.byteLength);
      res.end(xlsBuffer);
    } catch (error: unknown) {
      logger.error("Net position Excel error:", { error: error });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get monthly sales and profit data for Dashboard charts
}
