import ExcelJS from "exceljs";
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db, pool } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { logAudit } from "../_helpers";
import { getClientDate } from "../../lib/dateUtils";
import { sumMoney, toMoney } from "../../lib/money";
import { containers } from "@shared/schema";
import { eq, and, or, sql, lte } from "drizzle-orm";
import {
  classifyEquityAccounts,
  classifyNetPositionAccounts,
  round2,
  type NetPositionAccount,
} from "../../netPositionHelper";
import { loadNetPositionParties } from "../../services/accounting/balances/netPositionParties";
import { ledgerCarriesStock } from "../../services/accounting/perpetualInventory/reportBasis";
import { companyStockValue } from "../../services/inventory/stockValuation";

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

      // Ledger accounts: this company's vouchers on its own accounts (engine
      // rule 4, wave 17 A; they were read by the account's company, so another
      // company's lines on these accounts counted here). Lines of this
      // company's vouchers on another company's or a missing account are the
      // engine's missingAccount lines below. Vouchers count from
      // COALESCE(effective_date, voucher_date). COALESCE(base_debit_amount,
      // debit_amount): the historical USD base when available. Customers,
      // suppliers and employees come from the balance engine below.
      const _npExcelParams = toDate ? [companyId, toDate] : [companyId];
      const _npExcelDateClause = toDate ? "AND COALESCE(v.effective_date, v.voucher_date) <= $2" : "";

      const ledgerAccEntriesRaw = await pool.query<{
        ledger_account_id: string;
        debit_amount: string;
        credit_amount: string;
      }>(
        `SELECT ve.ledger_account_id,
                COALESCE(ve.base_debit_amount,  ve.debit_amount)  AS debit_amount,
                COALESCE(ve.base_credit_amount, ve.credit_amount) AS credit_amount
         FROM voucher_entries ve
         JOIN vouchers        v  ON ve.voucher_id        = v.id
         JOIN ledger_accounts la ON ve.ledger_account_id = la.id
         WHERE la.company_id = $1
           AND v.company_id  = $1
           AND v.optional    = false
           AND v.deleted_at IS NULL
           ${_npExcelDateClause}`,
        _npExcelParams
      );
      const ledgerAccEntries = ledgerAccEntriesRaw.rows;

      // Sum each id's debits and credits exactly, then hand numbers to the classifiers.
      const exactBalances = (rows: Array<{ id: string | null; debit_amount: string; credit_amount: string }>) => {
        const grouped = new Map<number, { debits: string[]; credits: string[] }>();
        for (const e of rows) {
          if (!e.id) continue;
          const id = parseInt(e.id);
          const cur = grouped.get(id) || { debits: [], credits: [] };
          cur.debits.push(e.debit_amount);
          cur.credits.push(e.credit_amount);
          grouped.set(id, cur);
        }
        const balances = new Map<number, { debit: number; credit: number }>();
        for (const [id, { debits, credits }] of Array.from(grouped)) {
          balances.set(id, { debit: sumMoney(debits).toNumber(), credit: sumMoney(credits).toNumber() });
        }
        return balances;
      };
      const accountBalances = exactBalances(ledgerAccEntries.map((e) => ({ ...e, id: e.ledger_account_id })));

      // ── 2. Classify accounts ──────────────────────────────────────────────
      // One supplier-inclusion rule (wave 13, owner decision 2): supplier payables
      // count in the posting company; the global parentCompanyId setting no longer gates them.
      const shouldIncludeSuppliers = true; // ERP_NET_POSITION_INCLUDES_SUPPLIERS (netPositionParties.ts)
      // SP formula: Cash + Customer A/R + Stock (inventory) → What We Have; sp_payable and Loan/Loans → What We Owe.
      const isSupplierPartner = company?.companyType === "supplier_partner";
      // Customers, suppliers and employees from the one balance engine (as the
      // live /api/stats/net-profit); supplier-partner companies exclude
      // customers by design. Amounts not in the ledger are listed separately.
      const parties = await loadNetPositionParties(companyId, {
        asOf: toDate,
        customers: !isSupplierPartner,
        suppliers: shouldIncludeSuppliers,
        factorySuppliers: false,
        employees: "erp",
        codes: "erp",
        payrollCurrentBalanceMemo: true,
        banks: true,
        missingAccounts: true,
      });
      const accountsForClassify = (
        isSupplierPartner
          ? companyAccounts.filter(
              (a) =>
                a.accountType === "Cash" ||
                a.accountType === "Loan" ||
                a.accountType === "Loans" ||
                a.subType === "sp_payable"
            )
          : companyAccounts.filter(
              (a) =>
                a.subType !== "sp_stock" &&
                a.subType !== "sp_cost_clearing" &&
                !(a.accountType === "Liability" && (a.name as string)?.startsWith("Insurance"))
            )
      ).filter((a) => !parties.customerLedgerIds.has(a.id));
      // Perpetual inventory (wave 8.5): from the cut-over the ledger carries the stock.
      const ledgerStock = !isSupplierPartner && (await ledgerCarriesStock(companyId, toDate));
      const classified = classifyNetPositionAccounts(accountsForClassify, accountBalances, {
        includeSupplierTypeAccounts: shouldIncludeSuppliers,
        ledgerStockAccounts: ledgerStock,
      });
      const equity = classifyEquityAccounts(companyAccounts, accountBalances);
      let forUsTotal = classified.forUsTotal;
      let onUsTotal = classified.onUsTotal;
      const forUsAccounts = [...classified.forUsAccounts];
      const onUsAccounts = [...classified.onUsAccounts];

      // ── 3. Stock In Hand — as of toDate (live without one) ───────────────
      // Wave 11: the one stock valuation (stockValuation), SUM(total_value)
      // over the company's non-deleted locations, bale mirror left out;
      // negative stock does not subtract.
      const stockOnFloor = ledgerStock ? 0 : Number(await companyStockValue(db, companyId, toDate));
      if (stockOnFloor > 0) {
        forUsTotal += stockOnFloor;
        forUsAccounts.push({
          name: "Stock In Hand (Inventory)",
          code: "COMPUTED",
          value: stockOnFloor,
          category: "Inventory",
        });
      }

      // ── 4–5. Customers, suppliers, payroll, workers and bank accounts (balance engine) ─
      // The factory_worker_advances table this export used to add (and the
      // ledger account it replaced) belong to the factory net position; the
      // ERP export now matches the live ERP net position.
      forUsAccounts.push(...parties.forUs.map(({ partyKind: _kind, partyId: _id, ...line }) => line));
      onUsAccounts.push(...parties.onUs.map(({ partyKind: _kind, partyId: _id, ...line }) => line));
      forUsTotal += parties.forUsTotal;
      onUsTotal += parties.onUsTotal;

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
      // From the cut-over, Goods in Transit in the ledger carries the containers on the way.
      const otwContainers = ledgerStock ? [] : await db.select().from(containers).where(excelOtwQuery).execute();
      const stockOtwValue = sumMoney(
        otwContainers.map((container) => {
          const gTotal = toMoney(container.grandTotal);
          return gTotal.isZero() ? container.itemsTotal : gTotal;
        })
      ).toNumber();
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

      // Amounts not yet in the ledger: shown for information, not in the totals above.
      if (parties.notInLedger.lines.length > 0) {
        addSubheader(ws1, "Not yet in the ledger (not included in the net position)", DARK_NAVY);
        for (const line of parties.notInLedger.lines) {
          const r = ws1.addRow([line.label, currency(round2(line.value)), `${line.count} items`]);
          r.getCell(2).alignment = { horizontal: "right" };
          r.getCell(1).font = { italic: true };
        }
        ws1.addRow([]);
      }

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
