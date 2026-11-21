// Extracted from ./financialSalesRoutes.ts
import type { Express } from "express";
import { getErrorDetails } from "@shared/errorUtils";
import { logger } from "../lib/logger";
import { getErrorMessage, errorStatus } from "../lib/httpHandlers";
import { eq, and, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { FiscalPeriodCloseError } from "../storage/accounting/fiscal-periods";
import { logAudit } from "./_helpers";
import { requireAuth, requireNonPOS, checkPOSLocation } from "../auth";
import { locations, salesItems, vouchers } from "@shared/schema";
import { sumMoney, toMoney } from "../lib/money";

export function registerFinancialSalesRoutesPart1(app: Express) {
  // Reopen the latest closed fiscal period (Admin). Soft-deletes the closing
  // journal, restores the opening balances the close zeroed and lifts the lock
  // back to the previous close. A reason is required and audited.
  app.post("/api/fiscal-period/:id/reopen", requireAuth, async (req, res) => {
    try {
      const userRole = req.session.currentRole;
      if (userRole !== "Admin" && userRole !== "Developer") {
        return res.status(403).json({ message: "Only Admins can reopen fiscal periods" });
      }
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const closureId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(closureId) || closureId <= 0) {
        return res.status(400).json({ message: "Invalid fiscal period closure ID" });
      }
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (!reason) return res.status(400).json({ message: "A reason is required to reopen a fiscal period" });

      // Phase 21 (B): the reopen audit is written on the reopen's transaction.
      const closure = await storage.reopenFiscalPeriod(companyId, closureId, async (tx, reopened) => {
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId,
            action: "reverse",
            tableName: "fiscal_period_closures",
            recordId: reopened.id,
            recordIdentifier: `${reopened.periodStartDate}..${reopened.periodEndDate}`,
            changes: {
              status: { old: "CLOSED", new: "REOPENED" },
              closingVoucherId: { old: reopened.closingVoucherId, new: null },
              reason: { old: undefined, new: reason },
            },
          },
          tx
        );
      });
      res.json({ reopened: true, periodStartDate: closure.periodStartDate, periodEndDate: closure.periodEndDate });
    } catch (error: unknown) {
      const status = error instanceof FiscalPeriodCloseError ? error.status : errorStatus(error);
      res.status(status).json({ message: getErrorMessage(error) });
    }
  });

  // Get fiscal period closures for current company
  app.get("/api/fiscal-period/closures", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const closures = await storage.getFiscalPeriodClosures(req.session.currentCompanyId);
      res.json(closures);
    } catch (error: unknown) {
      const details = getErrorDetails(error);
      const cause =
        typeof error === "object" && error !== null && "cause" in error ? getErrorDetails(error.cause) : undefined;
      const pgCode = cause?.code ?? details.code;
      logger.error("[GET /api/fiscal-period/closures] Failed to load closures", {
        error,
        companyId: req.session.currentCompanyId,
        pgCode,
      });
      if (pgCode === "42703" || pgCode === "42P01") {
        return res.status(503).json({
          message: "The fiscal-period database schema needs an administrator update.",
          code: "FISCAL_PERIOD_SCHEMA_OUTDATED",
        });
      }
      return res.status(500).json({
        message: "Fiscal-period closures could not be loaded. Please contact an administrator.",
        code: "FISCAL_PERIOD_READ_FAILED",
      });
    }
  });

  // Get POS sales grouped by location with optional date filtering
  app.get("/api/financial/sales", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { startDate, endDate } = req.query;

      // Build query conditions (applied to vouchers via join)
      const conditions = [
        eq(vouchers.companyId, req.session.currentCompanyId),
        eq(vouchers.voucherType, "Sales"),
        isNull(vouchers.deletedAt),
        eq(vouchers.optional, false),
      ];

      if (startDate) {
        conditions.push(sql`${vouchers.voucherDate} >= ${startDate}`);
      }

      if (endDate) {
        conditions.push(sql`${vouchers.voucherDate} <= ${endDate}`);
      }

      // Aggregate from salesItems (same source as payroll sales-summary)
      // Groups by location + isCreditSale so credit sales stay separate
      const rows = await db
        .select({
          locationId: vouchers.locationId,
          locationName: locations.name,
          locationCode: locations.code,
          isCreditSale: vouchers.isCreditSale,
          totalQuantity: sql<string>`COALESCE(SUM(${salesItems.quantity}), 0)`,
          totalSales: sql<string>`COALESCE(SUM(${salesItems.totalSales}), 0)`,
          totalTransactions: sql<string>`COUNT(DISTINCT ${vouchers.id})`,
        })
        .from(salesItems)
        .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
        .leftJoin(locations, eq(vouchers.locationId, locations.id))
        .where(and(...conditions))
        .groupBy(vouchers.locationId, locations.name, locations.code, vouchers.isCreditSale);

      const CREDIT_SALES_ID = -1;

      const salesByLocation = new Map<
        number,
        {
          locationId: number;
          locationName: string;
          locationCode: string;
          totalSales: number;
          totalTransactions: number;
          totalQuantity: number;
          isCreditSale?: boolean;
        }
      >();

      for (const row of rows) {
        const qty = toMoney(row.totalQuantity).toNumber();
        const amount = toMoney(row.totalSales).toNumber();
        const txns = parseInt(row.totalTransactions as string);

        if (row.isCreditSale) {
          const existing = salesByLocation.get(CREDIT_SALES_ID);
          if (existing) {
            // Exact per-location totals: float += left residue on the sales report.
            existing.totalSales = toMoney(existing.totalSales).plus(amount).toNumber();
            existing.totalTransactions += txns;
            existing.totalQuantity = toMoney(existing.totalQuantity).plus(qty).toNumber();
          } else {
            salesByLocation.set(CREDIT_SALES_ID, {
              locationId: CREDIT_SALES_ID,
              locationName: "Credit Sales",
              locationCode: "CREDIT",
              totalSales: amount,
              totalTransactions: txns,
              totalQuantity: qty,
              isCreditSale: true,
            });
          }
        } else {
          if (!row.locationId) continue;
          const existing = salesByLocation.get(row.locationId);
          if (existing) {
            // Exact per-location totals: float += left residue on the sales report.
            existing.totalSales = toMoney(existing.totalSales).plus(amount).toNumber();
            existing.totalTransactions += txns;
            existing.totalQuantity = toMoney(existing.totalQuantity).plus(qty).toNumber();
          } else {
            salesByLocation.set(row.locationId, {
              locationId: row.locationId,
              locationName: row.locationName || "Unknown",
              locationCode: row.locationCode || "",
              totalSales: amount,
              totalTransactions: txns,
              totalQuantity: qty,
              isCreditSale: false,
            });
          }
        }
      }

      res.json(Array.from(salesByLocation.values()));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get detailed sales info for a specific location
  app.get("/api/financial/sales/:locationId/details", requireAuth, checkPOSLocation, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const locationId = parseInt(req.params.locationId);
      if (isNaN(locationId)) {
        return res.status(400).json({ message: "Invalid location ID" });
      }

      const { startDate, endDate } = req.query;

      // Build query conditions
      const conditions = [
        eq(vouchers.companyId, req.session.currentCompanyId),
        eq(vouchers.voucherType, "Sales"),
        eq(vouchers.locationId, locationId),
        isNull(vouchers.deletedAt),
        eq(vouchers.optional, false),
      ];

      if (startDate) {
        conditions.push(sql`${vouchers.voucherDate} >= ${startDate}`);
      }

      if (endDate) {
        conditions.push(sql`${vouchers.voucherDate} <= ${endDate}`);
      }

      // Get all sales vouchers for this location
      const salesVouchers = await db
        .select()
        .from(vouchers)
        .where(and(...conditions));

      // Quantity counts transactions (one per voucher); items sold per voucher
      // would need the inventory updates behind it.
      const totalQuantity = salesVouchers.length;
      const totalAmount = sumMoney(salesVouchers.map((voucher) => voucher.totalAmount)).toNumber();

      res.json({
        locationId,
        totalQuantity,
        totalAmount,
        totalTransactions: salesVouchers.length,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
