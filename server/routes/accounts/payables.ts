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
import { requireAuth } from "../../auth";
import { toMoney } from "../../lib/money";
import { getPartyBalances } from "../../services/accounting/balances/ledgerBalanceEngine";
import { vouchers } from "@shared/schema";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { eq, and, or, desc, sql, isNull, inArray } from "drizzle-orm";

export function registerAccountPayableRoutes(app: Express) {
  // Get payable accounts (creditors - suppliers with a Cr balance), from the one
  // balance engine (wave 13): the company's suppliers plus any supplier of
  // another company this company posted to, each line counted once in its
  // voucher company.
  app.get("/api/accounts/payables", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { parties } = await getPartyBalances(db, { companyId, kind: "supplier" });
      const ids = parties.map((party) => party.id).filter((id): id is number => id !== null);
      const masters =
        ids.length === 0
          ? []
          : await db
              .select({
                id: companyScopedSuppliers.id,
                code: companyScopedSuppliers.code,
                legalName: companyScopedSuppliers.legalName,
                companyId: companyScopedSuppliers.companyId,
              })
              .from(companyScopedSuppliers)
              .where(inArray(companyScopedSuppliers.id, ids));
      const byId = new Map(masters.map((supplier) => [supplier.id, supplier]));

      const payableAccounts = parties
        .map((party) => {
          const supplier = party.id === null ? undefined : byId.get(party.id);
          const balance = toMoney(party.closing).negated();
          return {
            id: party.id,
            accountId: party.id,
            code: supplier?.code ?? party.code,
            name: supplier?.legalName ?? party.name,
            balance: balance.toNumber(),
            balanceBasis: "ledger" as const,
            postedFromOtherCompany: supplier ? supplier.companyId !== companyId : false,
            exact: balance,
          };
        })
        .filter((account) => account.id !== null && account.exact.greaterThan(0))
        .sort((a, b) => b.exact.comparedTo(a.exact))
        .map(({ exact: _exact, ...account }) => account);

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
