import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
/**
 * accountRoutes: AccountPayable endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { resolveParentCompanyId, getSupplierBalanceForContext } from "../helpers/supplierBalanceHelpers";
import { vouchers } from "@shared/schema";
import { eq, and, or, desc, sql, isNull, ilike } from "drizzle-orm";

export function registerAccountPayableRoutes(app: Express) {
  // Get payable accounts (creditors - suppliers with positive balance)
  app.get("/api/accounts/payables", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const suppliers = await storage.getAllSuppliers();
      const parentCompanyId = await resolveParentCompanyId(companyId);
      const isChildCompany = companyId !== parentCompanyId;

      const payableAccounts = (
        await Promise.all(
          suppliers.map(async (supplier) => {
            const { balance, hasActivity } = await getSupplierBalanceForContext(supplier, companyId);
            if (isChildCompany && !hasActivity) return null;
            return {
              id: supplier.id,
              accountId: supplier.id,
              code: supplier.code,
              name: supplier.legalName,
              balance,
            };
          })
        )
      )
        .filter((account): account is NonNullable<typeof account> => account !== null && account.balance > 0)
        .sort((a, b) => b.balance - a.balance);

      res.json(payableAccounts);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get all accounts for voucher sidebar (optimized format with balances)
  app.get("/api/vouchers/search", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const q = ((req.query.q as string) || "").trim();
      if (!q) return res.json([]);

      // Split into individual keywords so "avance transport" matches both words anywhere
      const keywords = q.split(/\s+/).filter(Boolean);

      // Strip currency symbols / commas so "$3,967" → "3967" for amount matching
      const amountQ = q.replace(/[$,\s]/g, "");
      const isNumericSearch = keywords.length === 1 && /^\d+(\.\d+)?$/.test(amountQ);

      // Each keyword must appear in description OR voucherNumber (AND across keywords)
      const keywordConditions = keywords.map((kw) =>
        or(
          punctuationInsensitiveSearch(vouchers.voucherNumber, kw),
          punctuationInsensitiveSearch(vouchers.description, kw),
          isNumericSearch ? sql`CAST(${vouchers.totalAmount} AS TEXT) LIKE ${"%" + amountQ + "%"}` : sql`false`
        )
      );

      const results = await db
        .select({
          id: vouchers.id,
          voucherNumber: vouchers.voucherNumber,
          voucherType: vouchers.voucherType,
          voucherDate: vouchers.voucherDate,
          effectiveDate: vouchers.effectiveDate,
          description: vouchers.description,
          totalAmount: vouchers.totalAmount,
          currency: vouchers.currency,
          locationName: vouchers.locationName,
        })
        .from(vouchers)
        .where(
          and(eq(vouchers.companyId, req.session.currentCompanyId), isNull(vouchers.deletedAt), ...keywordConditions)
        )
        .orderBy(desc(sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate})`))
        .limit(100);

      res.json(results);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
