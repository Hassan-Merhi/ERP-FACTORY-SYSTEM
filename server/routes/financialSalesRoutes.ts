/**
 * Fiscal-period & financial-sales routes.
 *
 * Fiscal-period close/closures and financial sales summaries (by location,
 * with per-location details and individual POS transactions). Extracted from
 * fiscalTransferRoutes.ts as a sub-registrar; behaviour is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../lib/httpHandlers";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { FiscalPeriodCloseError } from "../storage/accounting/fiscal-periods";
import { requireAuth, checkPOSLocation } from "../auth";
import { ledgerAccounts, salesItems, stockItems, voucherEntries, vouchers } from "@shared/schema";
import { sumMoney, toMoney } from "../lib/money";
import { registerFinancialSalesRoutesPart1 } from "./registerFinancialSalesRoutesPart1";

export function registerFinancialSalesRoutes(app: Express) {
  app.post("/api/fiscal-period/close", requireAuth, async (req, res) => {
    try {
      // Check role authorization - use currentRole from session
      const userRole = req.session.currentRole;
      if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
        return res.status(403).json({
          message: "Only Admins and Owners can close fiscal periods",
        });
      }

      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { periodStartDate, periodEndDate, retainedEarningsAccountId, notes } = req.body;

      // Validate required fields
      if (!periodStartDate || !periodEndDate || !retainedEarningsAccountId) {
        return res.status(400).json({
          message: "Period start date, end date, and retained earnings account are required",
        });
      }

      // Parse and validate retained earnings account ID
      const accountId = parseInt(retainedEarningsAccountId);
      if (isNaN(accountId)) {
        return res.status(400).json({
          message: "Invalid retained earnings account ID",
        });
      }

      // Validate dates are valid and in correct order
      const startDate = new Date(periodStartDate);
      const endDate = new Date(periodEndDate);

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return res.status(400).json({
          message: "Invalid date format. Use YYYY-MM-DD",
        });
      }

      if (startDate > endDate) {
        return res.status(400).json({
          message: "Period start date must be before or equal to end date",
        });
      }

      // Validate retained earnings account exists and is an Equity account
      const retainedEarningsAccount = await storage.getLedgerAccountById(accountId);
      if (!retainedEarningsAccount) {
        return res.status(400).json({
          message: "Retained earnings account not found",
        });
      }
      if (retainedEarningsAccount.accountType !== "Equity") {
        return res.status(400).json({
          message: "Retained earnings account must be an Equity account",
        });
      }
      if (retainedEarningsAccount.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Retained earnings account belongs to a different company",
        });
      }

      const closure = await storage.closeFiscalPeriod(
        req.session.currentCompanyId,
        periodStartDate,
        periodEndDate,
        accountId,
        req.session.userId!,
        notes,
        // The close writes its audit row in its own transaction (wave 17 A).
        { username: req.session.username || "unknown" }
      );

      res.json(closure);
    } catch (error: unknown) {
      const status = error instanceof FiscalPeriodCloseError ? error.status : errorStatus(error);
      res.status(status).json({ message: getErrorMessage(error) });
    }
  });

  registerFinancialSalesRoutesPart1(app);

  // Get individual POS transactions for a specific location
  app.get(
    "/api/financial/sales/:locationId/transactions",
    requireAuth,
    async (req, res, next) => {
      // Credit Sales synthetic group (-1) doesn't need POS location validation
      if (req.params.locationId === "-1") return next();
      return checkPOSLocation(req, res, next);
    },
    async (req, res) => {
      try {
        if (!req.session.currentCompanyId) {
          return res.status(400).json({ message: "No company selected" });
        }

        const locationId = parseInt(req.params.locationId);
        if (isNaN(locationId)) {
          return res.status(400).json({ message: "Invalid location ID" });
        }

        const { startDate, endDate } = req.query;

        // Build query conditions — credit sales group uses isCreditSale flag, not locationId
        const conditions = [
          eq(vouchers.companyId, req.session.currentCompanyId),
          eq(vouchers.voucherType, "Sales"),
          isNull(vouchers.deletedAt),
          eq(vouchers.optional, false),
        ];

        if (locationId === -1) {
          conditions.push(eq(vouchers.isCreditSale, true));
        } else {
          conditions.push(eq(vouchers.locationId, locationId));
        }

        if (startDate) {
          conditions.push(sql`${vouchers.voucherDate} >= ${startDate}`);
        }

        if (endDate) {
          conditions.push(sql`${vouchers.voucherDate} <= ${endDate}`);
        }

        // Get all sales vouchers for this location with details
        const salesVouchers = await db
          .select()
          .from(vouchers)
          .where(and(...conditions))
          .orderBy(sql`${vouchers.voucherDate} DESC, ${vouchers.createdAt} DESC`);

        // Batch-fetch all sales items and cash account names in parallel
        const voucherIds = salesVouchers.map((v) => v.id);
        const [allSalesItems, cashEntries] = await Promise.all([
          voucherIds.length > 0
            ? db
                .select({
                  id: salesItems.id,
                  voucherId: salesItems.voucherId,
                  stockItemId: salesItems.stockItemId,
                  stockItemName: stockItems.name,
                  quantity: salesItems.quantity,
                  sellingPrice: salesItems.sellingPrice,
                  totalSales: salesItems.totalSales,
                })
                .from(salesItems)
                .leftJoin(stockItems, eq(salesItems.stockItemId, stockItems.id))
                .where(inArray(salesItems.voucherId, voucherIds))
            : Promise.resolve([]),
          // Find the Cash-type debit entry for each voucher (that's the cash account used)
          voucherIds.length > 0
            ? db
                .select({
                  voucherId: voucherEntries.voucherId,
                  cashAccountName: ledgerAccounts.name,
                })
                .from(voucherEntries)
                .innerJoin(ledgerAccounts, eq(voucherEntries.ledgerAccountId, ledgerAccounts.id))
                .where(
                  and(
                    inArray(voucherEntries.voucherId, voucherIds),
                    eq(ledgerAccounts.accountType, "Cash"),
                    sql`${voucherEntries.debitAmount}::numeric > 0`
                  )
                )
            : Promise.resolve([]),
        ]);

        const itemsByVoucher = new Map<number, typeof allSalesItems>();
        for (const item of allSalesItems) {
          const arr = itemsByVoucher.get(item.voucherId!) || [];
          arr.push(item);
          itemsByVoucher.set(item.voucherId!, arr);
        }

        // Use first Cash debit entry per voucher (there's only one in normal POS sales)
        const cashAccountByVoucher = new Map<number, string>();
        for (const entry of cashEntries) {
          if (entry.voucherId && !cashAccountByVoucher.has(entry.voucherId)) {
            cashAccountByVoucher.set(entry.voucherId, entry.cashAccountName);
          }
        }

        const transactions = salesVouchers.map((voucher) => {
          const items = itemsByVoucher.get(voucher.id) || [];
          const totalQty = sumMoney(items.map((item) => item.quantity)).toNumber();
          const totalAmt = toMoney(voucher.totalAmount).toNumber();

          return {
            id: voucher.id,
            voucherNumber: voucher.voucherNumber,
            voucherDate: voucher.voucherDate,
            createdAt: voucher.createdAt,
            description: voucher.description,
            // The voucher schema has no persisted customer-name field in this query.
            customerName: null,
            cashAccountName: cashAccountByVoucher.get(voucher.id) ?? null,
            totalAmount: totalAmt,
            totalQuantity: totalQty,
            itemCount: items.length,
            items,
          };
        });

        res.json(transactions);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
