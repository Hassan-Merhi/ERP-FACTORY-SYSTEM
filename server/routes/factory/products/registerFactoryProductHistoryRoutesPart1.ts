// Extracted from ./productHistoryRoutes.ts
import type { Express, Request, Response } from "express";
import { parseId, parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryBaleProducts, factoryBales, customerOrders, customerOrderBales } from "@shared/schema";
import { eq, and, desc, sql, inArray, not } from "drizzle-orm";

export function registerFactoryProductHistoryRoutesPart1(app: Express) {
  app.get(
    "/api/factory/bale-product-history/:productId/:locationId/:year/:month",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const productId = parseId(req.params.productId);

        if (productId === null) return res.status(400).json({ message: "Invalid id" });
        const locationId = parseId(req.params.locationId);
        if (locationId === null) return res.status(400).json({ message: "Invalid id" });
        const year = parseId(req.params.year);
        if (year === null) return res.status(400).json({ message: "Invalid id" });
        const month = parseId(req.params.month);
        if (month === null) return res.status(400).json({ message: "Invalid id" });

        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 1);

        const bales = await db
          .select({
            id: factoryBales.id,
            baleCode: factoryBales.baleCode,
            referenceNumber: factoryBales.referenceNumber,
            weightKg: factoryBales.weightKg,
            costPerKg: factoryBales.costPerKg,
            totalCost: factoryBales.totalCost,
            status: factoryBales.status,
            createdAt: factoryBales.createdAt,
          })
          .from(factoryBales)
          .where(
            and(
              eq(factoryBales.companyId, companyId),
              eq(factoryBales.productId, productId),
              eq(factoryBales.erpLocationId, locationId),
              sql`${factoryBales.createdAt} >= ${startDate}`,
              sql`${factoryBales.createdAt} < ${endDate}`,
              not(inArray(factoryBales.status, ["DELETED", "REMOVED"]))
            )
          )
          .orderBy(desc(factoryBales.createdAt));

        const [product] = await db
          .select({ sellingPrice: factoryBaleProducts.sellingPrice })
          .from(factoryBaleProducts)
          .where(and(eq(factoryBaleProducts.id, productId), eq(factoryBaleProducts.companyId, companyId)));

        res.json({ bales, sellingPrice: product?.sellingPrice || "0" });
      } catch (error: unknown) {
        logger.error("Error fetching monthly bale details:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get(
    "/api/factory/bale-product-history/:productId/:locationId/all-bales",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const productId = parseId(req.params.productId);

        if (productId === null) return res.status(400).json({ message: "Invalid id" });
        const locationId = parseId(req.params.locationId);
        if (locationId === null) return res.status(400).json({ message: "Invalid id" });
        const year = req.query.year ? parseOptionalId(req.query.year) : null;

        const conditions = [
          eq(factoryBales.companyId, companyId),
          eq(factoryBales.productId, productId),
          eq(factoryBales.erpLocationId, locationId),
          not(inArray(factoryBales.status, ["DELETED", "REMOVED"])),
        ];

        if (year) {
          const startDate = new Date(year, 0, 1);
          const endDate = new Date(year + 1, 0, 1);
          conditions.push(sql`${factoryBales.createdAt} >= ${startDate}`);
          conditions.push(sql`${factoryBales.createdAt} < ${endDate}`);
        }

        const bales = await db
          .select({
            id: factoryBales.id,
            baleCode: factoryBales.baleCode,
            referenceNumber: factoryBales.referenceNumber,
            weightKg: factoryBales.weightKg,
            costPerKg: factoryBales.costPerKg,
            totalCost: factoryBales.totalCost,
            status: factoryBales.status,
            createdAt: factoryBales.createdAt,
          })
          .from(factoryBales)
          .where(and(...conditions))
          .orderBy(desc(factoryBales.createdAt));

        // Find which IN_STOCK bales are currently scanned into a LOADING order
        // (V5 bales stay IN_STOCK during loading — need cross-reference to detect)
        const inStockIds = bales.filter((b) => b.status === "IN_STOCK").map((b) => b.id);
        const loadingBaleIds = new Set<number>();
        const finalizedOrderBaleIds = new Set<number>();
        if (inStockIds.length > 0) {
          const orderRows = await db
            .select({ baleId: customerOrderBales.baleId, orderStatus: customerOrders.status })
            .from(customerOrderBales)
            .innerJoin(customerOrders, eq(customerOrderBales.orderId, customerOrders.id))
            .where(
              and(
                inArray(customerOrders.status, ["LOADING", "FINALIZED", "DISPATCHED", "SOLD"]),
                inArray(customerOrderBales.baleId, inStockIds)
              )
            );
          for (const r of orderRows) {
            if (r.orderStatus === "LOADING") loadingBaleIds.add(r.baleId);
            else finalizedOrderBaleIds.add(r.baleId);
          }
        }

        const [product] = await db
          .select({ sellingPrice: factoryBaleProducts.sellingPrice })
          .from(factoryBaleProducts)
          .where(and(eq(factoryBaleProducts.id, productId), eq(factoryBaleProducts.companyId, companyId)));

        res.json({
          bales: bales.map((b) => ({
            ...b,
            isInLoadingOrder: loadingBaleIds.has(b.id),
            // Derive effective status for stale IN_STOCK bales on finalized orders
            status: b.status === "IN_STOCK" && finalizedOrderBaleIds.has(b.id) ? "SOLD" : b.status,
          })),
          sellingPrice: product?.sellingPrice || "0",
        });
      } catch (error: unknown) {
        logger.error("Error fetching all bale details:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
