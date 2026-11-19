/**
 * Bale lookup routes.
 *
 * Article-code and reference-number lookups and the reference-scan flow used
 * by the factory floor. Extracted from baleRoutes.ts as a sub-registrar;
 * behaviour is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { requireAuth, requireRole } from "../auth";
import { registerBaleLookupArticleRoutes } from "./baleLookupArticleRoutes";
import { baleLabelPrints, customerOrderBales, customerOrders, factoryBaleProducts, factoryBales } from "@shared/schema";
import { registerBaleLookupRoutesPart1 } from "./registerBaleLookupRoutesPart1";

export function registerBaleLookupRoutes(app: Express) {
  registerBaleLookupArticleRoutes(app);

  registerBaleLookupRoutesPart1(app);

  // Admin: Change the linked bale product (article code / product name) for a reference
  app.patch(
    "/api/lookup/reference/:referenceNumber/change-product",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req, res) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const referenceNumber = decodeURIComponent(req.params.referenceNumber).trim().toUpperCase();
        const { newProductId } = req.body;

        if (!newProductId || typeof newProductId !== "number") {
          return res.status(400).json({ message: "newProductId (number) is required" });
        }

        const labelMatches = await db
          .select({ id: baleLabelPrints.id, productionBaleId: baleLabelPrints.productionBaleId })
          .from(baleLabelPrints)
          .where(
            and(
              sql`LOWER(TRIM(${baleLabelPrints.referenceNumber})) = LOWER(TRIM(${referenceNumber}))`,
              eq(baleLabelPrints.companyId, companyId)
            )
          )
          .limit(2);

        const linkedBaleIds = [
          ...new Set(labelMatches.map((label) => label.productionBaleId).filter((id): id is number => id != null)),
        ];
        if (linkedBaleIds.length > 1) {
          return res.status(409).json({ message: "Reference number not found", code: "AMBIGUOUS_REFERENCE" });
        }

        let bale: typeof factoryBales.$inferSelect | undefined;
        if (linkedBaleIds.length === 1) {
          [bale] = await db
            .select()
            .from(factoryBales)
            .where(and(eq(factoryBales.companyId, companyId), eq(factoryBales.id, linkedBaleIds[0])))
            .limit(1);
        }

        if (!bale) {
          const baleMatches = await db
            .select()
            .from(factoryBales)
            .where(
              and(
                sql`LOWER(TRIM(${factoryBales.referenceNumber})) = LOWER(TRIM(${referenceNumber}))`,
                eq(factoryBales.companyId, companyId)
              )
            )
            .limit(2);

          if (baleMatches.length === 0) {
            return res.status(404).json({ message: "Bale not found for this reference" });
          }
          if (baleMatches.length > 1) {
            return res.status(409).json({ message: "Reference number not found", code: "AMBIGUOUS_REFERENCE" });
          }
          bale = baleMatches[0];
        }

        if (labelMatches.length > 1 && linkedBaleIds.length === 0) {
          return res.status(409).json({ message: "Reference number not found", code: "AMBIGUOUS_REFERENCE" });
        }

        // Guard: locked non-deleted order only.
        const orderBaleRows = await db
          .select({ orderId: customerOrderBales.orderId })
          .from(customerOrderBales)
          .where(sql`LOWER(TRIM(${customerOrderBales.baleReference})) = LOWER(TRIM(${referenceNumber}))`);

        if (orderBaleRows.length > 0) {
          const orderIds = [...new Set(orderBaleRows.map((row) => row.orderId))];
          const orders = await db
            .select({ status: customerOrders.status })
            .from(customerOrders)
            .where(
              and(
                inArray(customerOrders.id, orderIds),
                eq(customerOrders.companyId, companyId),
                isNull(customerOrders.deletedAt)
              )
            );
          if (orders.some((order) => ["FINALIZED", "VERIFIED", "DISPATCHED", "SOLD"].includes(order.status))) {
            return res
              .status(409)
              .json({ message: "This bale is linked to a finalized/locked order and cannot be changed." });
          }
        }

        const [newProduct] = await db
          .select()
          .from(factoryBaleProducts)
          .where(and(eq(factoryBaleProducts.id, newProductId), eq(factoryBaleProducts.companyId, companyId)))
          .limit(1);

        if (!newProduct) return res.status(404).json({ message: "Target product not found" });

        const newArticleCode = newProduct.articleCode || newProduct.code;
        const newBaleCode = newProduct.code;
        const newProductName = newProduct.name;

        await db.transaction(async (tx) => {
          await tx
            .update(factoryBales)
            .set({
              productId: newProduct.id,
              articleCode: newArticleCode,
              baleCode: newBaleCode,
              productName: newProductName,
              updatedAt: new Date(),
            })
            .where(and(eq(factoryBales.id, bale.id), eq(factoryBales.companyId, companyId)));

          if (linkedBaleIds.length === 1) {
            await tx
              .update(baleLabelPrints)
              .set({ articleCode: newArticleCode })
              .where(and(eq(baleLabelPrints.productionBaleId, bale.id), eq(baleLabelPrints.companyId, companyId)));
          } else if (labelMatches.length === 1) {
            await tx
              .update(baleLabelPrints)
              .set({ articleCode: newArticleCode })
              .where(eq(baleLabelPrints.id, labelMatches[0].id));
          }
        });

        res.json({ message: "Bale product changed", newArticleCode, newProductName });
      } catch (error: unknown) {
        logger.error("Error changing bale product:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
