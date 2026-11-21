// Extracted from ./orderPricingRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { customerProformaLines, factoryBaleProducts, factoryBales } from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
  changedPrice,
  notCancelled,
  orderIdOf,
  orderWithDetails,
  pricingErrorResponse,
  repriceOrderTx,
  type PriceUpdate,
} from "./repriceOrderTx";
import { registerOrderPricingRoutesPart1 } from "./registerOrderPricingRoutesPart1";

export function registerOrderPricingRoutes(app: Express) {
  app.post("/api/factory/customer-orders/:id/reprice", requireAuth, async (req: Request, res: Response) => {
    try {
      const ids = orderIdOf(req, res);
      if (!ids) return;
      const { companyId, orderId } = ids;

      // "Apply Current Prices" = use the CURRENT catalogue selling price as primary source.
      // Proforma price is only a fallback if no catalogue price is found for that article.
      const repriced = await db.transaction((tx) =>
        repriceOrderTx(
          tx,
          companyId,
          orderId,
          (order) =>
            ["DRAFT", "LOADING", "PENDING_VERIFICATION", "VERIFIED", "FINALIZED"].includes(order.status)
              ? null
              : "Cannot reprice a cancelled order",
          async (order, orderBales) => {
            // 1. Collect all unique article codes and bale IDs from this order
            const articleCodes = [...new Set(orderBales.map((b) => b.articleCode).filter(Boolean) as string[])];
            const baleIds = [...new Set(orderBales.map((b) => b.baleId).filter(Boolean))];

            // 2a. Bulk-fetch current selling prices by article code (primary path)
            const cataloguePriceMap = new Map<string, string>(); // lowerArticleCode → sellingPrice
            if (articleCodes.length > 0) {
              const catalogueRows = await tx
                .select({
                  articleCode: factoryBaleProducts.articleCode,
                  sellingPrice: factoryBaleProducts.sellingPrice,
                })
                .from(factoryBaleProducts)
                .where(
                  and(
                    eq(factoryBaleProducts.companyId, companyId),
                    inArray(factoryBaleProducts.articleCode, articleCodes)
                  )
                );
              for (const r of catalogueRows) {
                if (r.articleCode && r.sellingPrice != null) {
                  cataloguePriceMap.set(r.articleCode.toLowerCase().trim(), r.sellingPrice);
                }
              }
            }

            // 2b. Fallback: also pull prices via factoryBales.productId chain
            //     This covers cases where the article code in the bale doesn't match the catalogue entry.
            const baleIdPriceMap = new Map<number, string>(); // baleId → sellingPrice
            if (baleIds.length > 0) {
              const chainRows = await tx
                .select({ baleId: factoryBales.id, sellingPrice: factoryBaleProducts.sellingPrice })
                .from(factoryBales)
                .innerJoin(factoryBaleProducts, eq(factoryBaleProducts.id, factoryBales.productId))
                .where(inArray(factoryBales.id, baleIds));
              for (const r of chainRows) {
                if (r.baleId && r.sellingPrice != null) baleIdPriceMap.set(r.baleId, r.sellingPrice);
              }
            }

            // 3. Proforma prices as fallback for articles not in catalogue
            const proformaMap = new Map<string, string>();
            if (order.proformaIdUsed) {
              const proformaLines = await tx
                .select()
                .from(customerProformaLines)
                .where(eq(customerProformaLines.proformaId, order.proformaIdUsed));
              for (const pl of proformaLines) {
                if (pl.articleCode) proformaMap.set(pl.articleCode.toLowerCase(), pl.pricePerBale);
              }
            }

            const updates: PriceUpdate[] = [];
            for (const bale of orderBales) {
              const codeKey = bale.articleCode?.toLowerCase().trim();
              // Priority 1: catalogue price by article code
              // Priority 2: catalogue price via bale→product chain (baleId lookup)
              // Priority 3: proforma price
              const rawPrice =
                codeKey && cataloguePriceMap.has(codeKey)
                  ? cataloguePriceMap.get(codeKey)!
                  : bale.baleId && baleIdPriceMap.has(bale.baleId)
                    ? baleIdPriceMap.get(bale.baleId)!
                    : codeKey && proformaMap.has(codeKey)
                      ? proformaMap.get(codeKey)!
                      : null;
              // Skip if the price is 0 (not yet set) or already identical
              const price = changedPrice(rawPrice, bale.priceUsed);
              if (price) updates.push({ baleRowId: bale.id, price });
            }
            return updates;
          }
        )
      );

      res.json(await orderWithDetails(orderId, repriced));
    } catch (error: unknown) {
      pricingErrorResponse(res, error, "Error repricing order:");
    }
  });

  // Apply PRODUCTION prices to all bales in this order
  app.post("/api/factory/customer-orders/:id/reprice-production", requireAuth, async (req: Request, res: Response) => {
    try {
      const ids = orderIdOf(req, res);
      if (!ids) return;
      const { companyId, orderId } = ids;

      const repriced = await db.transaction((tx) =>
        repriceOrderTx(tx, companyId, orderId, notCancelled, async (_order, orderBales) => {
          // Collect unique article codes and bale IDs
          const articleCodes = [...new Set(orderBales.map((b) => b.articleCode).filter(Boolean) as string[])];
          const baleIds = [...new Set(orderBales.map((b) => b.baleId).filter(Boolean))];

          // Lookup production prices by article code
          const catalogueProdMap = new Map<string, string>();
          if (articleCodes.length > 0) {
            const catRows = await tx
              .select({
                articleCode: factoryBaleProducts.articleCode,
                productionPrice: factoryBaleProducts.productionPrice,
              })
              .from(factoryBaleProducts)
              .where(
                and(
                  eq(factoryBaleProducts.companyId, companyId),
                  inArray(factoryBaleProducts.articleCode, articleCodes)
                )
              );
            for (const r of catRows) {
              if (r.articleCode && r.productionPrice != null) {
                catalogueProdMap.set(r.articleCode.toLowerCase().trim(), r.productionPrice);
              }
            }
          }

          // Fallback: via baleId → product chain
          const baleIdProdMap = new Map<number, string>();
          if (baleIds.length > 0) {
            const chainRows = await tx
              .select({ baleId: factoryBales.id, productionPrice: factoryBaleProducts.productionPrice })
              .from(factoryBales)
              .innerJoin(factoryBaleProducts, eq(factoryBaleProducts.id, factoryBales.productId))
              .where(inArray(factoryBales.id, baleIds));
            for (const r of chainRows) {
              if (r.baleId && r.productionPrice != null) baleIdProdMap.set(r.baleId, r.productionPrice);
            }
          }

          const updates: PriceUpdate[] = [];
          for (const bale of orderBales) {
            const codeKey = bale.articleCode?.toLowerCase().trim();
            const rawPrice =
              codeKey && catalogueProdMap.has(codeKey)
                ? catalogueProdMap.get(codeKey)!
                : bale.baleId && baleIdProdMap.has(bale.baleId)
                  ? baleIdProdMap.get(bale.baleId)!
                  : null;
            const price = changedPrice(rawPrice, bale.priceUsed);
            if (price) updates.push({ baleRowId: bale.id, price });
          }
          return updates;
        })
      );

      res.json(await orderWithDetails(orderId, repriced));
    } catch (error: unknown) {
      pricingErrorResponse(res, error, "Error repricing order with production prices:");
    }
  });

  registerOrderPricingRoutesPart1(app);

  // ─────── CONTAINER DOCUMENT TYPES ───────
}
