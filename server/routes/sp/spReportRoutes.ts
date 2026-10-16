import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { sql, eq, asc, desc } from "drizzle-orm";
import { spStockMovements, spProfitSplits } from "@shared/schema";
import { requireSpCompany, getSpAccount, parseNum } from "./spHelpers";
import { resultRows } from "../../lib/queryResult";
import { getLatestSpProfitCorrection } from "./spProfitManualCorrections";
import { presentSpMonthlyProfit } from "./spProfitReportPresentation";

// ── Reports + Profit Splits ───────────────────────────────────────────────────

export function registerSpReportRoutes(app: Express) {
  app.get("/api/sp/report/payable", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const payableAcct = await getSpAccount(companyId, "sp_payable");
      if (!payableAcct) return res.json({ openingBalance: 0, movements: [], closingBalance: 0 });

      // All voucher entries against Supplier Cash Payable account
      const rows = await db.execute(sql`
        SELECT ve.*, v.voucher_date, v.description, v.voucher_number
        FROM voucher_entries ve
        JOIN vouchers v ON ve.voucher_id = v.id
        WHERE ve.ledger_account_id = ${payableAcct.id}
          AND v.company_id = ${companyId}
        ORDER BY v.voucher_date ASC, v.id ASC
      `);

      const entries = resultRows(rows);
      let runningBalance = 0;
      const movements = entries.map((e) => {
        const credit = parseNum(e.credit_amount);
        const debit = parseNum(e.debit_amount);
        runningBalance += credit - debit;
        return {
          date: e.voucher_date,
          description: e.description,
          voucherNumber: e.voucher_number,
          credit,
          debit,
          balance: runningBalance,
        };
      });

      res.json({ openingBalance: 0, movements, closingBalance: runningBalance });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/sp/report/profit", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const { startDate, endDate } = req.query;

      // ── Resolve configured POS accounts from company settings ──────────────
      // SP POS sales no longer use the sp_sales table — they go through the standard
      // ERP POS route (posRoutes.ts) and land in vouchers + voucher_entries.
      // Revenue = credits to the profit account (grandTotal per sale).
      // COGS    = credits to the payable account (supplier cost per sale).
      // Net profit = Revenue − COGS  (e.g. $775 − $482.60 = $292.40).
      let totalRevenue = 0;
      let totalCogs = 0;
      let saleCount = 0;

      // Use salesItems as source of truth: totalSales/totalCost/profit are stored
      // at sale time regardless of how the ledger accounts are configured.
      // This correctly handles old sales and eliminates reliance on voucher-entry math.
      const siRows = await db.execute(sql`
        SELECT
          COALESCE(SUM(CAST(si.total_sales AS DECIMAL)), 0) AS total_revenue,
          COALESCE(SUM(CAST(si.total_cost  AS DECIMAL)), 0) AS total_cogs,
          COUNT(DISTINCT v.id)                              AS cnt
        FROM sales_items si
        JOIN vouchers v ON si.voucher_id = v.id
        WHERE v.company_id   = ${companyId}
          AND v.voucher_type = 'Sales'
          AND v.deleted_at   IS NULL
          ${startDate ? sql`AND v.voucher_date >= ${startDate}` : sql``}
          ${endDate ? sql`AND v.voucher_date <= ${endDate}` : sql``}
      `);
      const siRow = resultRows(siRows)[0];
      totalRevenue = parseNum(siRow?.total_revenue);
      totalCogs = parseNum(siRow?.total_cogs);
      saleCount = parseInt(String(siRow?.cnt ?? "0"), 10);

      // Shared Charges can be posted on either side depending on the settlement flow.
      // Report the net charge magnitude so a credit-side GC settlement still appears as
      // a positive charge while debit-side SP expense postings continue to work.
      const sharedAcct = await getSpAccount(companyId, "sp_shared_charges");
      let totalSharedCharges = 0;
      if (sharedAcct) {
        const sharedRows = await db.execute(sql`
          SELECT ABS(
            COALESCE(SUM(CAST(ve.debit_amount AS DECIMAL)), 0)
            - COALESCE(SUM(CAST(ve.credit_amount AS DECIMAL)), 0)
          ) AS total
          FROM voucher_entries ve
          JOIN vouchers v ON ve.voucher_id = v.id
          WHERE ve.ledger_account_id = ${sharedAcct.id}
            AND v.company_id         = ${companyId}
            AND v.deleted_at IS NULL
            AND v.optional = false
            ${startDate ? sql`AND v.voucher_date >= ${startDate}` : sql``}
            ${endDate ? sql`AND v.voucher_date <= ${endDate}` : sql``}
        `);
        const sr = resultRows(sharedRows)[0];
        totalSharedCharges = parseNum(sr?.total);
      }

      let approvedNetProfit: string | null = null;
      // Only a whole calendar-month report may use a developer-approved target.
      // Partial date ranges retain their original source-ledger arithmetic.
      const first = typeof startDate === "string" ? startDate : "";
      const last = typeof endDate === "string" ? endDate : "";
      const match = /^(\d{4}-(?:0[1-9]|1[0-2]))-01$/.exec(first);
      if (match) {
        const [year, month] = match[1].split("-").map(Number);
        const periodEnd = `${match[1]}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
        if (last === periodEnd) {
          const approved = await getLatestSpProfitCorrection(db, companyId, match[1]);
          if (approved) approvedNetProfit = approved.targetNetProfit;
        }
      }
      // Display the approved net adjustment in Gross Profit rather than a
      // separate Other Income / (Expense) row. Shared Charges are unchanged.
      // This is presentation only: POS source revenue/COGS remain immutable and
      // any approved difference stays auditable in the month-close suspense journal.
      const { grossProfit, netProfit } = presentSpMonthlyProfit({
        totalRevenue,
        totalCogs,
        totalSharedCharges,
        approvedNetProfit,
      });
      const splitPct = 50;
      // Assign odd cents deterministically so both shares sum to the exact
      // corrected net profit, matching the Decimal rounding in Phase 11.
      const netCents = Math.round(netProfit * 100);
      const ourCents = Math.sign(netCents) * Math.round(Math.abs(netCents) / 2);
      const ourShare = ourCents / 100;
      const supplierShare = (netCents - ourCents) / 100;

      res.json({
        totalRevenue,
        totalCogs,
        grossProfit,
        totalSharedCharges,
        netProfit,
        splitPct,
        ourShare,
        supplierShare,
        saleCount,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/sp/report/stock", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const movements = await db
        .select()
        .from(spStockMovements)
        .where(eq(spStockMovements.companyId, companyId))
        .orderBy(asc(spStockMovements.articleCode));

      // Group by articleCode
      const groups = new Map();
      for (const m of movements) {
        const key = m.articleCode;
        if (!groups.has(key)) {
          groups.set(key, {
            articleCode: key,
            description: m.description,
            totalQtyIn: 0,
            totalQtyRemaining: 0,
            totalValueIn: 0,
            totalValueRemaining: 0,
            movements: [],
          });
        }
        const g = groups.get(key)!;
        const qtyIn = parseNum(m.qtyIn);
        const qtyRem = parseNum(m.qtyRemaining);
        const finalCost = parseNum(m.finalUnitCostUsd);
        g.totalQtyIn += qtyIn;
        g.totalQtyRemaining += qtyRem;
        g.totalValueIn += qtyIn * finalCost;
        g.totalValueRemaining += qtyRem * finalCost;
        g.movements.push(m);
      }

      const result = [...groups.values()].map((g) => ({
        ...g,
        avgFinalCost: g.totalQtyRemaining > 0 ? g.totalValueRemaining / g.totalQtyRemaining : 0,
      }));

      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Sales Detail Report ───────────────────────────────────────────────────

  app.get("/api/sp/report/sales-detail", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const { startDate, endDate } = req.query;

      // Per-article sales aggregation
      const salesRows = await db.execute(sql`
        SELECT
          sl.article_code,
          MAX(sl.description) AS description,
          SUM(CAST(sl.qty_sold AS DECIMAL))                                          AS sold_qty,
          SUM(CAST(sl.qty_sold AS DECIMAL) * CAST(sl.sale_price_per_unit AS DECIMAL)) AS sales_total,
          SUM(CAST(sl.qty_sold AS DECIMAL) * CAST(sl.final_unit_cost_usd AS DECIMAL)) AS total_final_cost,
          SUM(CAST(sl.qty_sold AS DECIMAL) * CAST(sl.base_unit_cost_usd AS DECIMAL))  AS base_payable,
          AVG(CAST(sl.final_unit_cost_usd AS DECIMAL))                               AS avg_final_cost,
          AVG(CAST(sl.sale_price_per_unit AS DECIMAL))                               AS avg_sale_price
        FROM sp_sale_lines sl
        JOIN sp_sales s ON sl.sale_id = s.id
        WHERE sl.company_id = ${companyId} AND s.status = 'posted'
        ${startDate ? sql`AND s.sale_date >= ${startDate}` : sql``}
        ${endDate ? sql`AND s.sale_date <= ${endDate}` : sql``}
        GROUP BY sl.article_code
        ORDER BY sl.article_code ASC
      `);

      // Current stock remaining per article
      const stockRows = await db.execute(sql`
        SELECT article_code,
               SUM(CAST(qty_in AS DECIMAL))        AS total_qty_in,
               SUM(CAST(qty_remaining AS DECIMAL))  AS qty_remaining
        FROM sp_stock_movements
        WHERE company_id = ${companyId}
        GROUP BY article_code
      `);

      // Total supplier payments (debit on SP-PAY = payment made)
      const payableAcct = await getSpAccount(companyId, "sp_payable");
      let paymentsTotal = 0;
      let payableBalance = 0;
      if (payableAcct) {
        const payRows = await db.execute(sql`
          SELECT COALESCE(SUM(CAST(debit_amount AS DECIMAL)), 0)  AS total_payments,
                 COALESCE(SUM(CAST(credit_amount AS DECIMAL)), 0) AS total_credits
          FROM voucher_entries ve
          JOIN vouchers v ON ve.voucher_id = v.id
          WHERE ve.ledger_account_id = ${payableAcct.id} AND v.company_id = ${companyId}
            AND v.deleted_at IS NULL
            AND v.optional = false
        `);
        const pr = resultRows(payRows)[0];
        paymentsTotal = parseNum(pr?.total_payments);
        payableBalance = parseNum(pr?.total_credits) - paymentsTotal;
      }

      const salesArr = resultRows(salesRows);
      const stockArr = resultRows<{ article_code: string }>(stockRows);
      const stockMap = new Map();
      for (const s of stockArr) stockMap.set(s.article_code, s);

      const rows = salesArr.map((r) => {
        const stk = stockMap.get(r.article_code) || {};
        const soldQty = parseNum(r.sold_qty);
        const salesTotal = parseNum(r.sales_total);
        const finalCost = parseNum(r.total_final_cost);
        const basePay = parseNum(r.base_payable);
        return {
          articleCode: r.article_code,
          description: r.description,
          totalQtyIn: parseNum(stk.total_qty_in),
          currentQtyRemaining: parseNum(stk.qty_remaining),
          soldQty,
          salesTotal,
          avgSalePrice: parseNum(r.avg_sale_price),
          totalFinalCost: finalCost,
          avgFinalCost: parseNum(r.avg_final_cost),
          grossProfit: salesTotal - finalCost,
          basePayable: basePay,
        };
      });

      res.json({ rows, paymentsTotal, remainingPayable: payableBalance });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Profit Splits ─────────────────────────────────────────────────────────

  app.get("/api/sp/profit-splits", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const splits = await db
        .select()
        .from(spProfitSplits)
        .where(eq(spProfitSplits.companyId, companyId))
        .orderBy(desc(spProfitSplits.periodMonth));

      res.json(splits);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/sp/profit-splits", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const { periodMonth, totalRevenue, totalCogs, totalSharedCharges, splitPct } = req.body;

      if (!periodMonth) return res.status(400).json({ message: "periodMonth required (YYYY-MM)" });

      const rev = parseNum(totalRevenue);
      const cogs = parseNum(totalCogs);
      const shared = parseNum(totalSharedCharges);
      const gross = rev - cogs;
      const net = gross - shared;
      const pct = parseNum(splitPct) || 50;
      const our = net * (pct / 100);
      const sup = net - our;

      const [split] = await db
        .insert(spProfitSplits)
        .values({
          companyId,
          periodMonth,
          totalRevenue: String(rev),
          totalCogs: String(cogs),
          totalSharedCharges: String(shared),
          grossProfit: String(gross),
          splitPct: String(pct),
          ourShare: String(our),
          supplierShare: String(sup),
          finalizedAt: new Date(),
        })
        .returning();

      res.json(split);
    } catch (error: unknown) {
      if ((error as { code?: string }).code === "23505") {
        return res.status(400).json({ message: `Profit split for ${req.body.periodMonth} already exists` });
      }
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
