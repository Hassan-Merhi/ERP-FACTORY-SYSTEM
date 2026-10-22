/**
 * Bale lookup by article code (GET /api/lookup/article/:articleCode).
 *
 * Registered first by registerBaleLookupRoutes in baleLookupRoutes.ts, at the
 * original position; behaviour is unchanged.
 */
import { normalizeSearchText } from "@shared/searchNormalization";
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { eq, and, or, sql, inArray } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { factoryBaleProducts, factoryBales } from "@shared/schema";

export function registerBaleLookupArticleRoutes(app: Express) {
  // Lookup by ARTICLE code
  app.get("/api/lookup/article/:articleCode", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const articleCode = decodeURIComponent(req.params.articleCode);

      // Search for a matching product in BOTH catalogs in parallel
      const [erpProduct, labelPrints, factoryProductRows] = await Promise.all([
        storage.getBaleProductByArticleCode(articleCode, companyId),
        storage.getBaleLabelPrintsByArticle(articleCode, companyId),
        // factoryBales.productId points to factory_bale_products, not bale_products
        // Use case-insensitive match so article codes with mixed case are still found.
        db
          .select({
            id: factoryBaleProducts.id,
            name: factoryBaleProducts.name,
            code: factoryBaleProducts.code,
            articleCode: factoryBaleProducts.articleCode,
            active: factoryBaleProducts.active,
          })
          .from(factoryBaleProducts)
          .where(
            and(
              eq(factoryBaleProducts.companyId, companyId),
              sql`regexp_replace(lower(coalesce(${factoryBaleProducts.articleCode}::text, '')), '[^[:alnum:]]+', '', 'g') = ${normalizeSearchText(articleCode)}`
            )
          ),
      ]);

      // Use ERP product for display if found; fall back to factory product
      const factoryProduct = factoryProductRows[0] ?? null;
      const displayProduct =
        erpProduct ||
        (factoryProduct ? { ...factoryProduct, weightPerBaleKg: null, description: null, categoryId: null } : null);

      // IDs in factory_bale_products that match this article code
      const factoryProductIds = factoryProductRows.map((p) => p.id);

      // Enrich each label print with bale status so non-admin users can see deleted bales
      const refNumbers = labelPrints.map((lp) => lp.referenceNumber).filter(Boolean);
      const coveredRefs = new Set(refNumbers);
      const baleStatusMap: Record<string, string> = {};
      if (refNumbers.length > 0) {
        const baleRows = await db
          .select({ referenceNumber: factoryBales.referenceNumber, status: factoryBales.status })
          .from(factoryBales)
          .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.referenceNumber, refNumbers)));
        for (const b of baleRows) {
          if (b.referenceNumber) baleStatusMap[b.referenceNumber] = b.status;
        }
      }

      const enrichedLabelPrints = labelPrints.map((lp) => ({
        ...lp,
        baleStatus: baleStatusMap[lp.referenceNumber] ?? null,
      }));

      // Also find bales in factory_bales that have this articleCode (directly on the bale row,
      // or via productId → factory_bale_products) but have NO label print entry yet.
      // These are manually imported bales, system-created bales, or produced bales never printed.
      let directBalesWhereClause;
      if (factoryProductIds.length > 0) {
        directBalesWhereClause = and(
          eq(factoryBales.companyId, companyId),
          or(
            sql`regexp_replace(lower(coalesce(${factoryBales.articleCode}::text, '')), '[^[:alnum:]]+', '', 'g') = ${normalizeSearchText(articleCode)}`,
            inArray(factoryBales.productId, factoryProductIds)
          )
        );
      } else {
        directBalesWhereClause = and(
          eq(factoryBales.companyId, companyId),
          sql`regexp_replace(lower(coalesce(${factoryBales.articleCode}::text, '')), '[^[:alnum:]]+', '', 'g') = ${normalizeSearchText(articleCode)}`
        );
      }

      const directBalesRaw = await db
        .select({
          id: factoryBales.id,
          referenceNumber: factoryBales.referenceNumber,
          weightKg: factoryBales.weightKg,
          status: factoryBales.status,
          createdAt: factoryBales.createdAt,
        })
        .from(factoryBales)
        .where(directBalesWhereClause);

      // Only include bales not already covered by a label print
      const uncoveredBales = directBalesRaw.filter((b) => b.referenceNumber && !coveredRefs.has(b.referenceNumber));

      // Synthesize label-print-like entries (negative ID to avoid collision with real print IDs)
      const syntheticEntries = uncoveredBales.map((b) => ({
        id: -b.id,
        referenceNumber: b.referenceNumber,
        approxWeightKg: b.weightKg,
        articleCode,
        companyId,
        printedAt: null,
        scannedAt: null,
        scannedByUserId: null,
        scannedByName: null,
        baleStatus: b.status,
        _synthetic: true,
      }));

      // Merge: real label prints first, then synthetic entries sorted by reference number
      const allEntries = [
        ...enrichedLabelPrints,
        ...syntheticEntries.sort((a, b) => a.referenceNumber.localeCompare(b.referenceNumber)),
      ];

      res.json({ product: displayProduct || null, labelPrints: allEntries });
    } catch (error: unknown) {
      logger.error("Error looking up article:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
