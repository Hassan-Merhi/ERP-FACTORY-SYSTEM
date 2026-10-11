/**
 * factoryIntelligenceRoutes: FactoryKpi endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Database } from "../../db";
import type { Express, Request, Response, RequestHandler } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { plusMoney, toMoney } from "../../lib/money";
import { eq, and, sql, gte, lte } from "drizzle-orm";

import {
  factoryWasteEntries,
  factoryBales,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryWorkers,
} from "@shared/schema";

export function registerFactoryKpiRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
  app.get("/api/factory/kpis/daily", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const from = req.query.from as string;
      const to = req.query.to as string;
      if (!from || !to) return res.status(400).json({ message: "from and to dates are required" });

      const bales = await db
        .select()
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, companyId),
            sql`DATE(${factoryBales.finalizedAt}) >= ${from}`,
            sql`DATE(${factoryBales.finalizedAt}) <= ${to}`
          )
        );

      const wasteEntries = await db
        .select()
        .from(factoryWasteEntries)
        .where(
          and(
            eq(factoryWasteEntries.companyId, companyId),
            gte(factoryWasteEntries.date, from),
            lte(factoryWasteEntries.date, to)
          )
        );

      const dailyMap: Record<string, { balesProduced: number; kgPressed: number; wasteKg: number }> = {};

      for (const bale of bales) {
        const d = bale.finalizedAt ? new Date(bale.finalizedAt).toISOString().split("T")[0] : null;
        if (!d) continue;
        if (!dailyMap[d]) dailyMap[d] = { balesProduced: 0, kgPressed: 0, wasteKg: 0 };
        dailyMap[d].balesProduced++;
        dailyMap[d].kgPressed = plusMoney(dailyMap[d].kgPressed, bale.weightKg);
      }

      for (const w of wasteEntries) {
        const d = w.date;
        if (!d) continue;
        if (!dailyMap[d]) dailyMap[d] = { balesProduced: 0, kgPressed: 0, wasteKg: 0 };
        dailyMap[d].wasteKg = plusMoney(dailyMap[d].wasteKg, w.kgWaste);
      }

      const result = Object.entries(dailyMap)
        .map(([date, data]) => ({ date, ...data }))
        .sort((a, b) => a.date.localeCompare(b.date));

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching daily KPIs:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/kpis/workers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const from = req.query.from as string;
      const to = req.query.to as string;
      if (!from || !to) return res.status(400).json({ message: "from and to dates are required" });

      const bales = await db
        .select()
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, companyId),
            sql`DATE(${factoryBales.finalizedAt}) >= ${from}`,
            sql`DATE(${factoryBales.finalizedAt}) <= ${to}`
          )
        );

      const workers = await db.select().from(factoryWorkers).where(eq(factoryWorkers.companyId, companyId));

      const workerMap = new Map(workers.map((w) => [w.id, w] as const));

      const workerStats: Record<number, { workerId: number; workerName: string; balesCount: number; totalKg: number }> =
        {};

      for (const bale of bales) {
        const wId = bale.finalizedBy;
        if (!wId) continue;
        if (!workerStats[wId]) {
          const worker = workerMap.get(wId);
          workerStats[wId] = {
            workerId: wId,
            workerName: worker?.fullName || "Unknown",
            balesCount: 0,
            totalKg: 0,
          };
        }
        workerStats[wId].balesCount++;
        workerStats[wId].totalKg = plusMoney(workerStats[wId].totalKg, bale.weightKg);
      }

      const result = Object.values(workerStats).sort((a, b) => b.balesCount - a.balesCount);
      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching worker KPIs:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/kpis/mixes", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const from = req.query.from as string;
      const to = req.query.to as string;
      if (!from || !to) return res.status(400).json({ message: "from and to dates are required" });

      const mixes = await db
        .select()
        .from(factoryMixBatches)
        .where(
          and(
            eq(factoryMixBatches.companyId, companyId),
            sql`DATE(${factoryMixBatches.createdAt}) >= ${from}`,
            sql`DATE(${factoryMixBatches.createdAt}) <= ${to}`
          )
        );

      const mixIds = mixes.map((m) => m.id);
      if (mixIds.length === 0) return res.json([]);

      const sources = await db
        .select()
        .from(factoryMixBatchSources)
        .where(
          sql`${factoryMixBatchSources.mixBatchId} IN (${sql.join(
            mixIds.map((id: number) => sql`${id}`),
            sql`, `
          )})`
        );

      const bales = await db
        .select()
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, companyId),
            sql`${factoryBales.mixBatchId} IN (${sql.join(
              mixIds.map((id: number) => sql`${id}`),
              sql`, `
            )})`
          )
        );

      const result = mixes.map((mix) => {
        const mixSources = sources.filter((s) => s.mixBatchId === mix.id);
        const totalInputKg = mixSources.reduce((s: number, src) => plusMoney(s, src.weightKg), 0);

        const mixBales = bales.filter((b) => b.mixBatchId === mix.id);
        const outputBalesCount = mixBales.length;
        const totalOutputKg = mixBales.reduce((s: number, b) => plusMoney(s, b.weightKg), 0);

        const wasteKg = toMoney(totalInputKg).minus(totalOutputKg).toNumber();
        const wastePct = totalInputKg > 0 ? (wasteKg / totalInputKg) * 100 : 0;

        return {
          mixBatchId: mix.id,
          batchCode: mix.batchCode,
          name: mix.name,
          totalInputKg,
          outputBalesCount,
          totalOutputKg,
          wasteKg,
          wastePct: Math.round(wastePct * 100) / 100,
        };
      });

      result.sort((a: { wastePct: number }, b: { wastePct: number }) => a.wastePct - b.wastePct);
      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching mix KPIs:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // 5. Profitability
  // ───────────────────────────────────────────────
}
