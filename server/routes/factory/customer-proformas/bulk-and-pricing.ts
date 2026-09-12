/**
 * factoryCustomerProformaRoutes: FactoryCustomerProformaBulkPricing endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { syncProformaReservations } from "../_stockReservationHelper";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  factoryBaleProducts,
  customerProformas,
  customerProformaLines,
  insertCustomerProformaSchema,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { autoSavePriceToPriceList } from "./_helpers";

function hasDuplicateNormalizedArticleCodes(lines: Array<{ articleCode?: unknown }>): boolean {
  const seen = new Set<string>();
  for (const line of lines) {
    const normalized = String(line.articleCode ?? "").trim().toLowerCase();
    if (!normalized) continue;
    if (seen.has(normalized)) return true;
    seen.add(normalized);
  }
  return false;
}

export function registerFactoryCustomerProformaBulkPricingRoutes(app: Express) {
  app.post("/api/factory/customer-proformas/bulk", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { customerId, name, isActive, lines } = req.body;
      if (!customerId || !name || !Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({
          message: `customerId, name, and at least one line are required. Got: customerId=${customerId}, name=${name}, lines=${Array.isArray(lines) ? lines.length : "not array"}`,
        });
      }

      const validLines = lines.filter((l) => l.articleCode && l.productName && parseInt(l.quantity) > 0);
      if (validLines.length === 0) {
        return res
          .status(400)
          .json({ message: "At least one line must have articleCode, productName, and quantity > 0" });
      }
      if (hasDuplicateNormalizedArticleCodes(validLines)) {
        return res.status(400).json({
          message: "Article code already exists in this proforma",
        });
      }

      const parsed = insertCustomerProformaSchema.parse({ companyId, customerId, name, isActive: isActive || false });

      const result = await db.transaction(async (tx) => {
        const [proforma] = await tx.insert(customerProformas).values(parsed).returning();

        const lineValues = validLines.map((l) => ({
          proformaId: proforma.id,
          articleCode: l.articleCode,
          productName: l.productName,
          quantity: parseInt(l.quantity),
          pricePerBale: String(l.pricePerBale || "0"),
          productionPricePerBale: String(l.productionPricePerBale || "0"),
          pricingMode: l.pricingMode ?? "per_bale",
          pricePerKg:
            l.pricingMode === "per_kg" && l.pricePerKg != null && l.pricePerKg !== "" ? String(l.pricePerKg) : null,
        }));

        const insertedLines = await tx.insert(customerProformaLines).values(lineValues).returning();

        return { ...proforma, lines: insertedLines };
      });

      // Sync outside transaction — reservations are derived, not transactional
      await syncProformaReservations(db, companyId, result.id);

      // Auto-save all line prices to customer price list
      for (const l of validLines) {
        if (l.articleCode && l.pricePerBale) {
          await autoSavePriceToPriceList(companyId, customerId, l.articleCode, l.pricePerBale).catch(() => {});
        }
      }

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error bulk creating proforma:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/factory/customer-proformas/:id/replace-lines", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [proforma] = await db
        .select()
        .from(customerProformas)
        .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)));
      if (!proforma) return res.status(404).json({ message: "Proforma not found" });

      const { lines } = req.body;
      if (!Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({ message: "At least one line is required" });
      }

      const validLines = lines.filter((l) => l.articleCode && l.productName && parseInt(l.quantity) > 0);
      if (validLines.length === 0) {
        return res
          .status(400)
          .json({ message: "At least one line must have articleCode, productName, and quantity > 0" });
      }
      if (hasDuplicateNormalizedArticleCodes(validLines)) {
        return res.status(400).json({
          message: "Article code already exists in this proforma",
        });
      }

      const result = await db.transaction(async (tx) => {
        await tx.delete(customerProformaLines).where(eq(customerProformaLines.proformaId, id));
        const lineValues = validLines.map((l) => ({
          proformaId: id,
          articleCode: l.articleCode,
          productName: l.productName,
          quantity: parseInt(l.quantity),
          pricePerBale: String(l.pricePerBale || "0"),
          pricingMode: l.pricingMode ?? "per_bale",
          pricePerKg:
            l.pricingMode === "per_kg" && l.pricePerKg != null && l.pricePerKg !== "" ? String(l.pricePerKg) : null,
        }));
        const insertedLines = await tx.insert(customerProformaLines).values(lineValues).returning();
        return { ...proforma, lines: insertedLines };
      });

      // Sync — all lines replaced, recalculate reservation state
      await syncProformaReservations(db, companyId, id);
      res.json(result);
    } catch (error: unknown) {
      logger.error("Error replacing proforma lines:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post(
    "/api/factory/customer-proformas/:id/apply-catalog-prices",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const id = parseId(req.params.id);

        if (id === null) return res.status(400).json({ message: "Invalid id" });

        const lines = await db.select().from(customerProformaLines).where(eq(customerProformaLines.proformaId, id));
        if (!lines.length) return res.json({ updated: 0, skipped: 0 });

        const products = await db
          .select()
          .from(factoryBaleProducts)
          .where(eq(factoryBaleProducts.companyId, companyId));
        const priceByArticleCode = new Map<string, string>();
        for (const p of products) {
          if (p.articleCode && p.sellingPrice && parseFloat(String(p.sellingPrice)) > 0) {
            priceByArticleCode.set(p.articleCode.toLowerCase(), String(p.sellingPrice));
          }
        }

        let updated = 0;
        let skipped = 0;
        let fixed = 0;
        for (const line of lines) {
          if (line.priceFixed) {
            fixed++;
            continue;
          }
          const newPrice = priceByArticleCode.get((line.articleCode || "").toLowerCase());
          if (newPrice) {
            await db
              .update(customerProformaLines)
              .set({ pricePerBale: newPrice })
              .where(eq(customerProformaLines.id, line.id));
            updated++;
          } else {
            skipped++;
          }
        }

        res.json({ updated, skipped, fixed });
      } catch (error: unknown) {
        logger.error("Error applying catalog prices:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Apply production price from catalogue to all non-fixed lines
  app.post(
    "/api/factory/customer-proformas/:id/apply-production-prices",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });

        const lines = await db.select().from(customerProformaLines).where(eq(customerProformaLines.proformaId, id));
        if (!lines.length) return res.json({ updated: 0, skipped: 0 });

        const products = await db
          .select()
          .from(factoryBaleProducts)
          .where(eq(factoryBaleProducts.companyId, companyId));
        const priceByArticleCode = new Map<string, string>();
        for (const p of products) {
          if (p.articleCode && p.productionPrice && parseFloat(String(p.productionPrice)) > 0) {
            priceByArticleCode.set(p.articleCode.toLowerCase(), String(p.productionPrice));
          }
        }

        let updated = 0;
        let skipped = 0;
        let fixed = 0;
        for (const line of lines) {
          if (line.priceFixed) {
            fixed++;
            continue;
          }
          const newPrice = priceByArticleCode.get((line.articleCode || "").toLowerCase());
          if (newPrice) {
            await db
              .update(customerProformaLines)
              .set({ pricePerBale: newPrice })
              .where(eq(customerProformaLines.id, line.id));
            updated++;
          } else {
            skipped++;
          }
        }

        res.json({ updated, skipped, fixed });
      } catch (error: unknown) {
        logger.error("Error applying production prices:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
