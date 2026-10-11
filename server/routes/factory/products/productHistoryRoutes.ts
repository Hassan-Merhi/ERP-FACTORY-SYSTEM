/**
 * factoryProductsRoutes: FactoryProductHistory endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, NextFunction, Request, Response } from "express";
import { parseId, parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryBaleProducts, factoryBales, customerOrders, customerOrderBales, locations } from "@shared/schema";
import { eq, and, desc, sql, inArray, not } from "drizzle-orm";
import { toMoney } from "../../../lib/money";

export function registerFactoryProductHistoryRoutes(app: Express) {
  // Shared implementation for the monthly-overview query (year-level view).
  // Called by both the 2-segment route (year from ?year=) and the 3-segment route (year from path).
  async function baleProductHistoryByYear(
    req: import("express").Request,
    res: import("express").Response,
    companyId: number,
    productId: number,
    locationId: number,
    year: number
  ) {
    try {
      const [product] = await db
        .select({
          id: factoryBaleProducts.id,
          name: factoryBaleProducts.name,
          articleCode: factoryBaleProducts.articleCode,
          weightPerBaleKg: factoryBaleProducts.weightPerBaleKg,
          sellingPrice: factoryBaleProducts.sellingPrice,
        })
        .from(factoryBaleProducts)
        .where(and(eq(factoryBaleProducts.id, productId), eq(factoryBaleProducts.companyId, companyId)));

      if (!product) return res.status(404).json({ message: "Product not found" });

      const [location] = await db
        .select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(eq(locations.id, locationId));

      if (!location) return res.status(404).json({ message: "Location not found" });

      const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];

      const startDate = new Date(year, 0, 1);
      const endDate = new Date(year + 1, 0, 1);
      const sellingPricePerBale = toMoney(product.sellingPrice).toNumber();

      const rows = await db
        .select({
          month: sql<number>`EXTRACT(MONTH FROM ${factoryBales.createdAt})`.as("month"),
          balesIn: sql<number>`COUNT(*)::int`.as("bales_in"),
          balesOut: sql<number>`SUM(CASE WHEN ${factoryBales.status} IN ('SOLD','REMOVED','DELETED','DISPATCHED')
              OR (${factoryBales.status} = 'IN_STOCK' AND EXISTS (
                SELECT 1 FROM customer_order_bales cob
                JOIN customer_orders co ON co.id = cob.order_id
                WHERE cob.bale_id = ${sql.raw("factory_bales.id")}
                  AND co.status IN ('FINALIZED','DISPATCHED','SOLD')
                  AND co.company_id = ${companyId}
              ))
            THEN 1 ELSE 0 END)::int`.as("bales_out"),
          // balesInStock = IN_STOCK bales not on a finalized order
          balesInStock: sql<number>`SUM(CASE WHEN ${factoryBales.status} = 'IN_STOCK' AND NOT EXISTS (
            SELECT 1 FROM customer_order_bales cob
            JOIN customer_orders co ON co.id = cob.order_id
            WHERE cob.bale_id = ${sql.raw("factory_bales.id")}
              AND co.status IN ('FINALIZED','DISPATCHED','SOLD')
              AND co.company_id = ${companyId}
          ) THEN 1 ELSE 0 END)::int`.as("bales_in_stock"),
          // balesLoading = IN_STOCK bales that are assigned to a LOADING order
          balesLoading: sql<number>`SUM(CASE WHEN ${factoryBales.status} = 'IN_STOCK' AND EXISTS (
            SELECT 1 FROM customer_order_bales cob
            JOIN customer_orders co ON co.id = cob.order_id
            WHERE cob.bale_id = ${sql.raw("factory_bales.id")} AND co.status = 'LOADING' AND co.company_id = ${companyId}
          ) THEN 1 ELSE 0 END)::int`.as("bales_loading"),
          totalWeightIn: sql<number>`COALESCE(SUM(${factoryBales.weightKg}::numeric), 0)`.as("total_weight_in"),
          totalWeightOut:
            sql<number>`COALESCE(SUM(CASE WHEN ${factoryBales.status} IN ('SOLD','REMOVED','DELETED','DISPATCHED') THEN ${factoryBales.weightKg}::numeric ELSE 0 END), 0)`.as(
              "total_weight_out"
            ),
          // Weight of bales from this month that are currently IN_STOCK and not in a loading order
          totalWeightInStock: sql<number>`COALESCE(SUM(CASE WHEN ${factoryBales.status} = 'IN_STOCK' AND NOT EXISTS (
            SELECT 1 FROM customer_order_bales cob
            JOIN customer_orders co ON co.id = cob.order_id
            WHERE cob.bale_id = ${sql.raw("factory_bales.id")} AND co.status = 'LOADING' AND co.company_id = ${companyId}
          ) THEN ${factoryBales.weightKg}::numeric ELSE 0 END), 0)`.as("total_weight_in_stock"),
          totalCost: sql<number>`COALESCE(SUM(${factoryBales.totalCost}::numeric), 0)`.as("total_cost"),
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
        .groupBy(sql`EXTRACT(MONTH FROM ${factoryBales.createdAt})`)
        .orderBy(sql`EXTRACT(MONTH FROM ${factoryBales.createdAt})`);

      // Grand Total Net = actual current IN_STOCK bale count (all-time, not year-filtered)
      // Excludes bales currently in a LOADING order
      const [inStockSnapshot] = await db
        .select({
          balesNet: sql<number>`SUM(CASE WHEN NOT EXISTS (
            SELECT 1 FROM customer_order_bales cob
            JOIN customer_orders co ON co.id = cob.order_id
            WHERE cob.bale_id = ${sql.raw("factory_bales.id")} AND co.status = 'LOADING' AND co.company_id = ${companyId}
          ) THEN 1 ELSE 0 END)::int`.as("bales_net"),
          balesLoading: sql<number>`SUM(CASE WHEN EXISTS (
            SELECT 1 FROM customer_order_bales cob
            JOIN customer_orders co ON co.id = cob.order_id
            WHERE cob.bale_id = ${sql.raw("factory_bales.id")} AND co.status = 'LOADING' AND co.company_id = ${companyId}
          ) THEN 1 ELSE 0 END)::int`.as("bales_loading"),
          totalWeightNet: sql<number>`COALESCE(SUM(CASE WHEN NOT EXISTS (
            SELECT 1 FROM customer_order_bales cob
            JOIN customer_orders co ON co.id = cob.order_id
            WHERE cob.bale_id = ${sql.raw("factory_bales.id")} AND co.status = 'LOADING' AND co.company_id = ${companyId}
          ) THEN ${factoryBales.weightKg}::numeric ELSE 0 END), 0)`.as("total_weight_net"),
        })
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, companyId),
            eq(factoryBales.productId, productId),
            eq(factoryBales.erpLocationId, locationId),
            eq(factoryBales.status, "IN_STOCK")
          )
        );

      const realInStockCount = Number(inStockSnapshot?.balesNet ?? 0);
      const _realLoadingCount = Number(inStockSnapshot?.balesLoading ?? 0);
      const realInStockWeightKg = Number(inStockSnapshot?.totalWeightNet ?? 0);

      const monthlyData = rows.map((r) => {
        const balesIn = Number(r.balesIn);
        const balesOut = Number(r.balesOut);
        const balesLoading = Number(r.balesLoading);
        const balesInStock = Number(r.balesInStock);
        // Net = in-stock bales that are NOT in a loading order
        const balesNet = balesInStock - balesLoading;
        const totalWeightIn = Number(r.totalWeightIn);
        const totalWeightOut = Number(r.totalWeightOut);
        const totalWeightInStock = Number(r.totalWeightInStock);
        return {
          month: Number(r.month),
          monthName: monthNames[Number(r.month) - 1],
          baleCount: balesIn,
          balesIn,
          balesOut,
          balesPending: balesLoading,
          balesNet,
          totalWeight: totalWeightIn,
          totalWeightOut,
          totalWeightNet: totalWeightInStock,
          totalCost: Number(r.totalCost),
          totalSellingValue: balesNet * sellingPricePerBale,
        };
      });

      // Sum per-month movements for the grand total row (except Net/KG-Net/Value which use snapshot)
      const grandTotalMovements = monthlyData.reduce(
        (acc, m) => ({
          baleCount: acc.baleCount + m.balesIn,
          balesIn: acc.balesIn + m.balesIn,
          balesOut: acc.balesOut + m.balesOut,
          balesPending: acc.balesPending + m.balesPending,
          totalWeight: acc.totalWeight + m.totalWeight,
          totalWeightOut: acc.totalWeightOut + m.totalWeightOut,
          totalCost: acc.totalCost + m.totalCost,
        }),
        { baleCount: 0, balesIn: 0, balesOut: 0, balesPending: 0, totalWeight: 0, totalWeightOut: 0, totalCost: 0 }
      );

      // Grand Total Net and KG Net come from the live IN_STOCK snapshot (matches Location Inventory)
      const grandTotal = {
        ...grandTotalMovements,
        balesNet: realInStockCount,
        totalWeightNet: realInStockWeightKg,
        totalSellingValue: realInStockCount * sellingPricePerBale,
      };

      res.json({ product, location, year, monthlyData, grandTotal });
    } catch (error: unknown) {
      logger.error("Error fetching bale product history:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  }

  // 2-segment route: year from ?year= query param (legacy / default-year usage)
  app.get(
    "/api/factory/bale-product-history/:productId/:locationId",
    requireAuth,
    async (req: Request, res: Response) => {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const productId = parseId(req.params.productId);
      if (productId === null) return res.status(400).json({ message: "Invalid id" });
      const locationId = parseId(req.params.locationId);
      if (locationId === null) return res.status(400).json({ message: "Invalid id" });
      const year = parseOptionalId(req.query.year) || new Date().getFullYear();
      return baleProductHistoryByYear(req, res, companyId, productId, locationId, year);
    }
  );

  // 3-segment route: year in path — this is what the frontend actually calls
  // e.g. GET /api/factory/bale-product-history/3538/142/2026
  // Express 5 no longer accepts inline regex constraints in route paths.
  // Explicitly pass the static all-bales route through below instead.
  app.get(
    "/api/factory/bale-product-history/:productId/:locationId/:year",
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      if (req.params.year === "all-bales") return next();
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const productId = parseId(req.params.productId);
      if (productId === null) return res.status(400).json({ message: "Invalid id" });
      const locationId = parseId(req.params.locationId);
      if (locationId === null) return res.status(400).json({ message: "Invalid id" });
      const year = parseInt(req.params.year, 10);
      if (isNaN(year) || year < 2000 || year > 2100) return res.status(400).json({ message: "Invalid year" });
      return baleProductHistoryByYear(req, res, companyId, productId, locationId, year);
    }
  );

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
