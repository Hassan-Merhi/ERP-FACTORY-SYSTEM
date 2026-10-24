/**
 * factoryProductsRoutes: FactoryProductBulk endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { sqlArray } from "../../../lib/sqlArray";
import { checkFactoryAdmin } from "../_helpers";
import { factoryBaleProducts } from "@shared/schema";
import { eq, and, or, sql, inArray, ilike } from "drizzle-orm";
import { parseMoneyInput } from "../../../lib/money";

export function registerFactoryProductBulkRoutes(app: Express) {
  app.delete("/api/factory/bale-products/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [updated] = await db
        .update(factoryBaleProducts)
        .set({ active: false, deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(factoryBaleProducts.id, id), eq(factoryBaleProducts.companyId, companyId)))
        .returning();

      if (!updated) return res.status(404).json({ message: "Product not found" });
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error deleting factory bale product:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/bale-products/bulk-toggle-active", requireAuth, async (req: Request, res: Response) => {
    try {
      // Owners may hide/restore catalogue products without an admin override.
      // Other bulk product mutations remain admin-only.
      if (req.session.currentRole !== "Owner" && !checkFactoryAdmin(req, res)) return;
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { ids, active } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: "ids array required" });
      if (typeof active !== "boolean") return res.status(400).json({ message: "active boolean required" });

      await db
        .update(factoryBaleProducts)
        .set({ active, updatedAt: new Date() })
        .where(and(eq(factoryBaleProducts.companyId, companyId), inArray(factoryBaleProducts.id, ids)));

      res.json({ updated: ids.length });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/bale-products/bulk-rename-preview", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { codePrefix, find, replace } = req.body;
      if (!codePrefix || find === undefined || find === "" || replace === undefined) {
        return res.status(400).json({ message: "codePrefix, find (non-empty), and replace are required" });
      }

      const products = await db
        .select()
        .from(factoryBaleProducts)
        .where(
          and(
            eq(factoryBaleProducts.companyId, companyId),
            or(
              ilike(factoryBaleProducts.code, `${codePrefix}%`),
              ilike(factoryBaleProducts.articleCode, `${codePrefix}%`)
            )
          )
        )
        .orderBy(factoryBaleProducts.id);

      const matches = products
        .filter((p) => p.name.includes(find))
        .map((p) => ({
          id: p.id,
          code: p.articleCode,
          currentName: p.name,
          newName: p.name.replaceAll(find, replace),
        }));

      res.json({ total: products.length, matches });
    } catch (error: unknown) {
      logger.error("Error previewing bulk rename:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/bale-products/bulk-rename-apply", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!checkFactoryAdmin(req, res)) return;
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { items } = req.body;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "No items to rename" });
      }

      let updated = 0;
      for (const item of items) {
        const [result] = await db
          .update(factoryBaleProducts)
          .set({ name: item.newName, updatedAt: new Date() })
          .where(and(eq(factoryBaleProducts.id, item.id), eq(factoryBaleProducts.companyId, companyId)))
          .returning();
        if (result) updated++;
      }

      res.json({ updated });
    } catch (error: unknown) {
      logger.error("Error applying bulk rename:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/bale-products/merge — merge source products into target
  app.post("/api/factory/bale-products/merge", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!checkFactoryAdmin(req, res)) return;
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { targetId, sourceIds } = req.body;
      if (!targetId || !Array.isArray(sourceIds) || sourceIds.length === 0) {
        return res.status(400).json({ message: "targetId and sourceIds[] are required" });
      }

      // Fetch target product
      const [target] = await db
        .select()
        .from(factoryBaleProducts)
        .where(and(eq(factoryBaleProducts.id, targetId), eq(factoryBaleProducts.companyId, companyId)));
      if (!target) return res.status(404).json({ message: "Target product not found" });

      // Verify all source products belong to this company
      const sources = await db
        .select()
        .from(factoryBaleProducts)
        .where(and(inArray(factoryBaleProducts.id, sourceIds), eq(factoryBaleProducts.companyId, companyId)));
      if (sources.length !== sourceIds.length) {
        return res.status(400).json({ message: "One or more source products not found for this company" });
      }

      // In a transaction: reroute all referencing rows then deactivate sources
      let movedBales = 0;
      await db.transaction(async (tx) => {
        // Update factory_bales: reassign product + fix inline article_code and product_name
        const updateResult = await tx.execute(sql`
          UPDATE factory_bales
          SET product_id = ${targetId},
              article_code = ${target.articleCode || null},
              product_name = ${target.name}
          WHERE product_id = ANY(${sqlArray(sourceIds)})
            AND company_id = ${companyId}
        `);
        movedBales = updateResult.rowCount ?? 0;

        // Update factory_pressing_batches: reassign product
        await tx.execute(sql`
          UPDATE factory_pressing_batches
          SET product_id = ${targetId}
          WHERE product_id = ANY(${sqlArray(sourceIds)})
            AND company_id = ${companyId}
        `);

        // Update factory_pos_sale_items: reassign product + fix inline name/articleCode
        await tx.execute(sql`
          UPDATE factory_pos_sale_items
          SET product_id = ${targetId},
              product_name = ${target.name},
              article_code = ${target.articleCode || null}
          WHERE product_id = ANY(${sqlArray(sourceIds)})
            AND company_id = ${companyId}
        `);

        // Soft-delete source products
        await tx.execute(sql`
          UPDATE factory_bale_products
          SET active = false, updated_at = NOW()
          WHERE id = ANY(${sqlArray(sourceIds)})
            AND company_id = ${companyId}
        `);
      });

      res.json({ movedBales, mergedProducts: sources.length, targetName: target.name });
    } catch (error: unknown) {
      logger.error("Error merging bale products:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/bale-products/bulk-update-prices", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { prices } = req.body;
      if (!Array.isArray(prices) || prices.length === 0) {
        return res.status(400).json({ message: "prices array is required" });
      }

      let updated = 0;
      let skipped = 0;

      for (const row of prices) {
        const id = parseInt(String(row.id));
        if (isNaN(id) || id <= 0) {
          skipped++;
          continue;
        }

        const updates: Record<string, unknown> = { updatedAt: new Date() };

        if (row.sellingPrice !== undefined && row.sellingPrice !== null && String(row.sellingPrice).trim() !== "") {
          const sp = parseMoneyInput(String(row.sellingPrice))?.toNumber() ?? NaN;
          if (!isNaN(sp) && sp >= 0) updates.sellingPrice = sp.toFixed(2);
        }
        if (
          row.productionPrice !== undefined &&
          row.productionPrice !== null &&
          String(row.productionPrice).trim() !== ""
        ) {
          const pp = parseMoneyInput(String(row.productionPrice))?.toNumber() ?? NaN;
          if (!isNaN(pp) && pp >= 0) updates.productionPrice = pp.toFixed(2);
        }

        if (Object.keys(updates).length <= 1) {
          skipped++;
          continue;
        }

        await db
          .update(factoryBaleProducts)
          .set(updates)
          .where(and(eq(factoryBaleProducts.id, id), eq(factoryBaleProducts.companyId, companyId)));
        updated++;
      }

      res.json({ updated, skipped });
    } catch (error: unknown) {
      logger.error("Error bulk-updating bale product prices:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
