// Extracted from ./retailFashionRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  RETAIL_NO_BRAND_NAME,
  retailLabelPrintEvents,
  retailProducts,
  retailProductVariants,
  users,
} from "@shared/schema";
import { requireAuth, requireNonPOS } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { currentUserId, requireRetailCompany } from "./pos/retailPosContext";
import { labelRequestSchema, loadLabelRows, toNumber } from "./validateQuickAddVariants";
import { registerRetailFashionRoutesPart1 } from "./registerRetailFashionRoutesPart1";

export function registerRetailFashionRoutes(app: Express): void {
  registerRetailFashionRoutesPart1(app);

  /** Existing styles for a brand, so quick add can extend a style instead of re-creating it. */
  app.get("/api/retail/styles", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const brandId = Number(req.query.brandId);
      const rows = await db
        .select({ id: retailProducts.id, name: retailProducts.name, category: retailProducts.category })
        .from(retailProducts)
        .where(
          and(
            eq(retailProducts.companyId, companyId),
            Number.isInteger(brandId) && brandId > 0 ? eq(retailProducts.brandId, brandId) : undefined
          )
        )
        .orderBy(retailProducts.name)
        .limit(500);
      res.json(rows);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  /**
   * Returns printable label data and records an audit row per variant. The
   * barcode printed is always the variant's stored barcode; printing never
   * issues or changes a barcode, so reprints keep the same identity.
   */
  app.post("/api/retail/labels", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const userId = currentUserId(req);
      const body = labelRequestSchema.parse(req.body);
      const copiesByVariant = new Map<number, number>();
      for (const item of body.items) {
        copiesByVariant.set(item.variantId, (copiesByVariant.get(item.variantId) ?? 0) + item.copies);
      }
      const variantIds = [...copiesByVariant.keys()];
      const rows = await loadLabelRows(companyId, variantIds);
      if (rows.length !== variantIds.length) return res.status(404).json({ message: "Retail variant not found" });

      const printed = await db
        .select({ variantId: retailLabelPrintEvents.variantId })
        .from(retailLabelPrintEvents)
        .where(
          and(eq(retailLabelPrintEvents.companyId, companyId), inArray(retailLabelPrintEvents.variantId, variantIds))
        )
        .groupBy(retailLabelPrintEvents.variantId);
      const printedBefore = new Set(printed.map((row) => row.variantId));

      await db.insert(retailLabelPrintEvents).values(
        rows.map((row) => ({
          companyId,
          variantId: row.variantId,
          barcode: row.barcode,
          copies: copiesByVariant.get(row.variantId) ?? 1,
          layout: body.layout,
          isReprint: printedBefore.has(row.variantId),
          createdBy: userId,
        }))
      );

      const order = new Map(variantIds.map((id, index) => [id, index]));
      res.status(201).json({
        layout: body.layout,
        labels: rows
          .sort((a, b) => (order.get(a.variantId) ?? 0) - (order.get(b.variantId) ?? 0))
          .map((row) => ({
            ...row,
            brand: row.brand ?? RETAIL_NO_BRAND_NAME,
            sellingPrice: toNumber(row.sellingPrice),
            copies: copiesByVariant.get(row.variantId) ?? 1,
            isReprint: printedBefore.has(row.variantId),
          })),
      });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/retail/variants/:id/labels", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const variantId = Number(req.params.id);
      if (!Number.isInteger(variantId) || variantId <= 0) return res.status(400).json({ message: "Invalid variant" });
      const rows = await db
        .select({
          id: retailLabelPrintEvents.id,
          barcode: retailLabelPrintEvents.barcode,
          copies: retailLabelPrintEvents.copies,
          layout: retailLabelPrintEvents.layout,
          isReprint: retailLabelPrintEvents.isReprint,
          createdAt: retailLabelPrintEvents.createdAt,
          createdBy: users.username,
        })
        .from(retailLabelPrintEvents)
        .leftJoin(users, eq(users.id, retailLabelPrintEvents.createdBy))
        .where(and(eq(retailLabelPrintEvents.companyId, companyId), eq(retailLabelPrintEvents.variantId, variantId)))
        .orderBy(desc(retailLabelPrintEvents.createdAt))
        .limit(200);
      res.json(rows);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  /**
   * Archive / restore. Archiving only hides an item from selling and browsing; it never
   * deletes the variant, its barcode, sales lines, returns or stock movements.
   */
  const activeSchema = z.object({ active: z.boolean() });

  app.patch("/api/retail/variants/:id/active", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const variantId = Number(req.params.id);
      if (!Number.isInteger(variantId) || variantId <= 0) return res.status(400).json({ message: "Invalid variant" });
      const { active } = activeSchema.parse(req.body);
      const [updated] = await db
        .update(retailProductVariants)
        .set({ active, updatedAt: new Date() })
        .where(and(eq(retailProductVariants.id, variantId), eq(retailProductVariants.companyId, companyId)))
        .returning({ id: retailProductVariants.id, productId: retailProductVariants.productId });
      if (!updated) return res.status(404).json({ message: "Retail variant not found" });
      if (active) {
        // Restoring a variant makes its style sellable again.
        await db
          .update(retailProducts)
          .set({ active: true, updatedAt: new Date() })
          .where(and(eq(retailProducts.id, updated.productId), eq(retailProducts.companyId, companyId)));
      }
      res.json({ id: updated.id, active });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/retail/products/:id/active", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ message: "Invalid product ID" });
      }
      const { active } = activeSchema.parse(req.body);
      const [updated] = await db
        .update(retailProducts)
        .set({ active, updatedAt: new Date() })
        .where(and(eq(retailProducts.id, productId), eq(retailProducts.companyId, companyId)))
        .returning({ id: retailProducts.id });
      if (!updated) return res.status(404).json({ message: "Retail product not found" });
      res.json({ id: updated.id, active });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
