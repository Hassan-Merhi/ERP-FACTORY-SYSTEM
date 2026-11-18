/**
 * factoryDocsUsersRoutes: FactoryAnalytics endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryRawStock, factoryBales } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { toMoney } from "../../../lib/money";
import { registerFactoryAnalyticsRoutesPart1 } from "./registerFactoryAnalyticsRoutesPart1";
import { registerFactoryAnalyticsRoutesPart2 } from "./registerFactoryAnalyticsRoutesPart2";
import { registerFactoryAnalyticsRoutesPart3 } from "./registerFactoryAnalyticsRoutesPart3";

export function registerFactoryAnalyticsRoutes(app: Express) {
  registerFactoryAnalyticsRoutesPart1(app);
  registerFactoryAnalyticsRoutesPart2(app);
  registerFactoryAnalyticsRoutesPart3(app);
  registerFactoryAnalyticsRoutesPart4(app);
}

function registerFactoryAnalyticsRoutesPart4(app: Express) {
  // ── Factory Analytics: Stock Summary (opening + closing stock) ───────────
  app.get("/api/factory/analytics/stock-summary", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Opening stock = total raw material received (cost basis)
      const [rawReceived] = await db
        .select({
          totalCost: sql<string>`COALESCE(SUM(${factoryRawStock.receivedKg} * ${factoryRawStock.costPerKgUsd}), '0')`,
          totalKg: sql<string>`COALESCE(SUM(${factoryRawStock.receivedKg}), '0')`,
        })
        .from(factoryRawStock)
        .where(eq(factoryRawStock.companyId, companyId));

      // Closing stock = remaining raw material (not yet used) + bale stock in stock
      const [rawRemaining] = await db
        .select({
          remainingCost: sql<string>`COALESCE(SUM((${factoryRawStock.receivedKg} - ${factoryRawStock.usedKg}) * ${factoryRawStock.costPerKgUsd}), '0')`,
          remainingKg: sql<string>`COALESCE(SUM(${factoryRawStock.receivedKg} - ${factoryRawStock.usedKg}), '0')`,
        })
        .from(factoryRawStock)
        .where(eq(factoryRawStock.companyId, companyId));

      const [baleStock] = await db
        .select({
          totalCost: sql<string>`COALESCE(SUM(${factoryBales.totalCost}), '0')`,
          totalWeightKg: sql<string>`COALESCE(SUM(${factoryBales.weightKg}), '0')`,
          count: sql<number>`COUNT(${factoryBales.id})`,
        })
        .from(factoryBales)
        .where(and(eq(factoryBales.companyId, companyId), eq(factoryBales.status, "IN_STOCK")));

      const openingStock = toMoney(rawReceived?.totalCost).toNumber();
      const closingRaw = toMoney(rawRemaining?.remainingCost).toNumber();
      const closingBales = toMoney(baleStock?.totalCost).toNumber();
      const closingStock = closingRaw + closingBales;

      res.json({
        openingStock,
        closingStock,
        detail: {
          rawReceived: { cost: openingStock, kg: toMoney(rawReceived?.totalKg).toNumber() },
          rawRemaining: { cost: closingRaw, kg: toMoney(rawRemaining?.remainingKg).toNumber() },
          balesInStock: {
            cost: closingBales,
            kg: toMoney(baleStock?.totalWeightKg).toNumber(),
            count: baleStock?.count ?? 0,
          },
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
