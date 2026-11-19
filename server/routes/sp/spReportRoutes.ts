import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { sql } from "drizzle-orm";
import { requireSpCompany, getSpAccount, parseNum } from "./spHelpers";
import { resultRows } from "../../lib/queryResult";
import { getLatestSpProfitCorrection } from "./spProfitManualCorrections";
import { presentSpMonthlyProfit } from "./spProfitReportPresentation";
import { registerSpReportRoutesPart1 } from "./registerSpReportRoutesPart1";

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
          AND v.deleted_at IS NULL
          AND v.optional = false
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

  registerSpReportRoutesPart1(app);
}
