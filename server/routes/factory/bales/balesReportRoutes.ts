/**
 * factoryBalesRoutes: BalesReport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { sumMoney, toMoney } from "../../../lib/money";

import { factoryRawStock, factoryMixBatches, factoryBales } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";

import { _getKpiCached, _setKpiCached } from "./_helpers";
import { registerBalesReportRoutesPart1 } from "./registerBalesReportRoutesPart1";
import { registerBalesReportRoutesPart2 } from "./registerBalesReportRoutesPart2";

export function registerBalesReportRoutes(app: Express) {
  registerBalesReportRoutesPart1(app);
  registerBalesReportRoutesPart2(app);
  registerBalesReportRoutesPart3(app);
}

function registerBalesReportRoutesPart3(app: Express) {
  // ───────────────────────────────────────────────
  // 11. Factory Production Summary
  // ───────────────────────────────────────────────

  app.get("/api/factory/production-summary", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const allBales = await db
        .select({
          status: factoryBales.status,
          weightKg: factoryBales.weightKg,
        })
        .from(factoryBales)
        .where(eq(factoryBales.companyId, companyId));

      const totalBales = allBales.length;
      let pendingCount = 0;
      let finalizedCount = 0;
      const pendingWeights: string[] = [];
      const finalizedWeights: string[] = [];

      for (const bale of allBales) {
        if (bale.status === "PENDING_PRESSING") {
          pendingCount++;
          pendingWeights.push(bale.weightKg);
        } else if (bale.status === "IN_STOCK") {
          finalizedCount++;
          finalizedWeights.push(bale.weightKg);
        }
      }
      const pendingWeight = sumMoney(pendingWeights);
      const finalizedWeight = sumMoney(finalizedWeights);

      const mixBatches = await db
        .select({
          totalWeightKg: factoryMixBatches.totalWeightKg,
          usedKg: factoryMixBatches.usedKg,
        })
        .from(factoryMixBatches)
        .where(eq(factoryMixBatches.companyId, companyId));

      const totalMixWeight = sumMoney(mixBatches.map((mb) => mb.totalWeightKg));
      const totalMixUsed = sumMoney(mixBatches.map((mb) => mb.usedKg));

      res.json({
        totalBales,
        pendingCount,
        finalizedCount,
        pendingWeight: pendingWeight.toFixed(3),
        finalizedWeight: finalizedWeight.toFixed(3),
        totalWeight: pendingWeight.plus(finalizedWeight).toFixed(3),
        mixBatchUtilization: {
          totalWeightKg: totalMixWeight.toFixed(3),
          usedKg: totalMixUsed.toFixed(3),
          remainingKg: totalMixWeight.minus(totalMixUsed).toFixed(3),
          utilizationPercent: totalMixWeight.gt(0) ? totalMixUsed.div(totalMixWeight).times(100).toFixed(1) : "0.0",
        },
      });
    } catch (error: unknown) {
      logger.error("Error fetching production summary:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // Factory Dashboard KPIs
  // ───────────────────────────────────────────────

  app.get("/api/factory/dashboard-kpis", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const _kpiKey = `factory-kpis:${companyId}:${todayStart.toDateString()}`;
      const _kpiHit = _getKpiCached(_kpiKey);
      if (_kpiHit) return res.json(_kpiHit);

      // Fire all three independent DB queries in parallel
      const [rawStockTotals, todayMixBatches, todayBales] = await Promise.all([
        db
          .select({
            totalReceived: sql<string>`COALESCE(SUM(${factoryRawStock.receivedKg}), 0)`,
            totalUsed: sql<string>`COALESCE(SUM(${factoryRawStock.usedKg}), 0)`,
          })
          .from(factoryRawStock)
          .where(eq(factoryRawStock.companyId, companyId)),

        db
          .select({ totalWeightKg: factoryMixBatches.totalWeightKg })
          .from(factoryMixBatches)
          .where(and(eq(factoryMixBatches.companyId, companyId), sql`${factoryMixBatches.createdAt} >= ${todayStart}`)),

        db
          .select({
            id: factoryBales.id,
            baleCode: factoryBales.baleCode,
            productName: factoryBales.productName,
            category: factoryBales.category,
            weightKg: factoryBales.weightKg,
            pressedAt: factoryBales.pressedAt,
            status: factoryBales.status,
          })
          .from(factoryBales)
          .where(and(eq(factoryBales.companyId, companyId), sql`${factoryBales.pressedAt} >= ${todayStart}`)),
      ]);

      const closingStockKg = toMoney(rawStockTotals[0]?.totalReceived).minus(toMoney(rawStockTotals[0]?.totalUsed));

      const kgsUsedToday = sumMoney(todayMixBatches.map((mb) => mb.totalWeightKg));
      const openingStockKg = closingStockKg.plus(kgsUsedToday);

      const balesPressedToday = todayBales.length;
      const totalBaleWeightToday = sumMoney(todayBales.map((b) => b.weightKg));

      const categoryMap: Record<string, { count: number; weights: string[] }> = {};
      for (const bale of todayBales) {
        const name = bale.productName || bale.category || "Unknown";
        if (!categoryMap[name]) categoryMap[name] = { count: 0, weights: [] };
        categoryMap[name].count++;
        categoryMap[name].weights.push(bale.weightKg);
      }
      const categories = Object.entries(categoryMap)
        .map(([name, data]) => ({
          name,
          count: data.count,
          totalKg: sumMoney(data.weights).toDecimalPlaces(3).toNumber(),
        }))
        .sort((a, b) => b.count - a.count);

      const _kpiResult = {
        openingStockKg: openingStockKg.toFixed(3),
        closingStockKg: closingStockKg.toFixed(3),
        balesPressedToday,
        kgsUsedToday: kgsUsedToday.toFixed(3),
        totalBaleWeightToday: totalBaleWeightToday.toFixed(3),
        categories,
        balesDetail: todayBales.map((b) => ({ ...b, quantity: 1 })),
      };
      _setKpiCached(_kpiKey, _kpiResult);
      res.json(_kpiResult);
    } catch (error: unknown) {
      logger.error("Error fetching factory dashboard KPIs:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
