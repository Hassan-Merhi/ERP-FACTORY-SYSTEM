/**
 * factoryIntelligenceRoutes: FactoryMixOptimize endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import type { AppDb, AuthMiddleware } from "../routeBoundaryTypes";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and, sql } from "drizzle-orm";
import { factorySettings, factoryBales, factoryMixBatches, factoryMixBatchSources } from "@shared/schema";
import { plusMoney, toMoney } from "../../lib/money";

/** A caller-supplied material offered to the optimizer when no history exists. */
type MixOptimizeMaterialInput = {
  supplierId: number;
  costPerKg: string | null;
};

/** Request body accepted by POST /api/factory/mix/optimize. */
type MixOptimizeRequest = {
  companyId?: number;
  targetProductId: number;
  desiredMarginPct?: number;
  availableMaterials?: MixOptimizeMaterialInput[];
};

/** One proposed mix returned by the optimizer. */
type MixOptimizeSuggestion = {
  sources: Array<{ containerId?: number | null; supplierId?: number; kgRatio: number }>;
  expectedCostPerBale: number;
  expectedProfit: number;
  historicalWastePct: number | null;
};

export function registerFactoryMixOptimizeRoutes(app: Express, requireAuth: AuthMiddleware, db: AppDb) {
  app.post("/api/factory/mix/optimize", requireAuth, async (req: Request, res: Response) => {
    try {
      const body = req.body as MixOptimizeRequest;
      const companyId = body.companyId || req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { targetProductId, desiredMarginPct, availableMaterials } = body;

      const [settings] = await db.select().from(factorySettings).where(eq(factorySettings.companyId, companyId));

      const laborCostPerKg = toMoney(settings?.laborCostPerKg).toNumber();
      const overheadPerKg = toMoney(settings?.overheadPerKg).toNumber();

      const balesForProduct = await db
        .select()
        .from(factoryBales)
        .where(and(eq(factoryBales.companyId, companyId), eq(factoryBales.productId, targetProductId)));

      const mixBatchIds = Array.from(
        new Set(balesForProduct.map((b) => b.mixBatchId).filter((id): id is number => id !== null))
      );

      let suggestions: MixOptimizeSuggestion[] = [];

      if (mixBatchIds.length > 0) {
        const mixes = await db
          .select()
          .from(factoryMixBatches)
          .where(
            sql`${factoryMixBatches.id} IN (${sql.join(
              mixBatchIds.map((id) => sql`${id}`),
              sql`, `
            )})`
          );

        const sources = await db
          .select()
          .from(factoryMixBatchSources)
          .where(
            sql`${factoryMixBatchSources.mixBatchId} IN (${sql.join(
              mixBatchIds.map((id) => sql`${id}`),
              sql`, `
            )})`
          );

        const mixPerformance = mixes.map((mix) => {
          const mixSources = sources.filter((s) => s.mixBatchId === mix.id);
          const totalInputKg = mixSources.reduce((s: number, src) => plusMoney(s, src.weightKg), 0);
          const mixBales = balesForProduct.filter((b) => b.mixBatchId === mix.id);
          const totalOutputKg = mixBales.reduce((s: number, b) => plusMoney(s, b.weightKg), 0);
          const wastePct = totalInputKg > 0 ? ((totalInputKg - totalOutputKg) / totalInputKg) * 100 : 100;

          const sourceRatios = mixSources.map((src) => ({
            containerId: src.containerId,
            kgRatio: totalInputKg > 0 ? toMoney(src.weightKg).toNumber() / totalInputKg : 0,
            costPerKg: toMoney(src.costPerKg).toNumber(),
          }));

          return { mix, sourceRatios, wastePct, totalInputKg };
        });

        mixPerformance.sort((a, b) => a.wastePct - b.wastePct);
        const top3 = mixPerformance.slice(0, 3);

        suggestions = top3.map((perf) => {
          const avgMaterialCost = perf.sourceRatios.reduce((s: number, r) => s + r.costPerKg * r.kgRatio, 0);
          const avgBaleWeight = 25;
          const expectedCostPerBale = (avgMaterialCost + laborCostPerKg + overheadPerKg) * avgBaleWeight;
          const expectedSalePrice = expectedCostPerBale / (1 - (desiredMarginPct || 20) / 100);
          const expectedProfit = expectedSalePrice - expectedCostPerBale;

          return {
            sources: perf.sourceRatios.map((r) => ({
              containerId: r.containerId,
              kgRatio: Math.round(r.kgRatio * 10000) / 10000,
            })),
            expectedCostPerBale: Math.round(expectedCostPerBale * 100) / 100,
            expectedProfit: Math.round(expectedProfit * 100) / 100,
            historicalWastePct: Math.round(perf.wastePct * 100) / 100,
          };
        });
      }

      if (suggestions.length === 0 && availableMaterials && availableMaterials.length > 0) {
        const equalRatio = 1 / availableMaterials.length;
        const avgCost =
          availableMaterials.reduce((s: number, m) => plusMoney(s, m.costPerKg), 0) / availableMaterials.length;
        const avgBaleWeight = 25;
        const expectedCostPerBale = (avgCost + laborCostPerKg + overheadPerKg) * avgBaleWeight;
        const expectedSalePrice = expectedCostPerBale / (1 - (desiredMarginPct || 20) / 100);
        const expectedProfit = expectedSalePrice - expectedCostPerBale;

        suggestions = [
          {
            sources: availableMaterials.map((m) => ({
              supplierId: m.supplierId,
              kgRatio: Math.round(equalRatio * 10000) / 10000,
            })),
            expectedCostPerBale: Math.round(expectedCostPerBale * 100) / 100,
            expectedProfit: Math.round(expectedProfit * 100) / 100,
            historicalWastePct: null,
          },
        ];
      }

      res.json({ suggestions });
    } catch (error: unknown) {
      logger.error("Error optimizing mix:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // 9. Traceability
  // ───────────────────────────────────────────────
}
