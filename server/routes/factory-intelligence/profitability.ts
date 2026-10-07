/**
 * factoryIntelligenceRoutes: FactoryProfitability endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Database } from "../../db";
import type { Express, Request, Response, RequestHandler } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { MoneyDecimal, sumMoney, toMoney, type MoneyInput } from "../../lib/money";
import { eq, and, sql } from "drizzle-orm";

import {
  factorySettings,
  factoryBales,
  factoryContainers,
  factoryRawStock,
  factoryMixBatchSources,
  containerFreight,
  customerOrderBales,
} from "@shared/schema";

const cents = (value: MoneyInput): number => toMoney(value).toDecimalPlaces(2).toNumber();

export function registerFactoryProfitabilityRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
  app.get("/api/factory/profitability/bales", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const from = req.query.from as string;
      const to = req.query.to as string;
      if (!from || !to) return res.status(400).json({ message: "from and to dates are required" });

      const [settings] = await db.select().from(factorySettings).where(eq(factorySettings.companyId, companyId));

      const laborCostPerKg = toMoney(settings?.laborCostPerKg);
      const overheadPerKg = toMoney(settings?.overheadPerKg);

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

      if (bales.length === 0) return res.json([]);

      const mixBatchIds = Array.from(new Set(bales.map((b) => b.mixBatchId).filter(Boolean))) as number[];
      const _sources =
        mixBatchIds.length > 0
          ? await db
              .select()
              .from(factoryMixBatchSources)
              .where(
                sql`${factoryMixBatchSources.mixBatchId} IN (${sql.join(
                  mixBatchIds.map((id: number) => sql`${id}`),
                  sql`, `
                )})`
              )
          : [];

      const orderBales = await db
        .select()
        .from(customerOrderBales)
        .where(
          sql`${customerOrderBales.baleId} IN (${sql.join(
            bales.map((b) => sql`${b.id}`),
            sql`, `
          )})`
        );

      const orderBaleMap = new Map(orderBales.map((ob) => [ob.baleId, ob] as const));

      const _freightEntries = await db.select().from(containerFreight).where(eq(containerFreight.companyId, companyId));

      const result = bales.map((bale) => {
        const weight = toMoney(bale.weightKg);
        const weightKg = weight.toNumber();
        const materialCost = toMoney(bale.totalCost);
        const laborCost = weight.times(laborCostPerKg);
        const overheadCost = weight.times(overheadPerKg);

        const freightAllocated = new MoneyDecimal(0);
        const totalCost = sumMoney([materialCost, laborCost, overheadCost, freightAllocated]);

        const ob = orderBaleMap.get(bale.id);
        const salePrice = ob ? toMoney(ob.priceUsed).toNumber() : null;
        const profit = ob ? toMoney(ob.priceUsed).minus(totalCost) : null;

        return {
          baleId: bale.id,
          referenceNumber: bale.referenceNumber,
          productName: bale.productName,
          weightKg,
          materialCost: cents(materialCost),
          laborCost: cents(laborCost),
          overheadCost: cents(overheadCost),
          freightAllocated: cents(freightAllocated),
          totalCost: cents(totalCost),
          salePrice,
          profit: profit !== null ? cents(profit) : null,
        };
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching bale profitability:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/profitability/containers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const from = req.query.from as string;
      const to = req.query.to as string;
      if (!from || !to) return res.status(400).json({ message: "from and to dates are required" });

      const containers = await db
        .select()
        .from(factoryContainers)
        .where(
          and(
            eq(factoryContainers.companyId, companyId),
            sql`DATE(${factoryContainers.createdAt}) >= ${from}`,
            sql`DATE(${factoryContainers.createdAt}) <= ${to}`
          )
        );

      if (containers.length === 0) return res.json([]);

      const containerIds = containers.map((c) => c.id);

      const rawStockEntries = await db
        .select()
        .from(factoryRawStock)
        .where(
          and(
            eq(factoryRawStock.companyId, companyId),
            sql`${factoryRawStock.containerId} IN (${sql.join(
              containerIds.map((id: number) => sql`${id}`),
              sql`, `
            )})`
          )
        );

      const freightEntries = await db
        .select()
        .from(containerFreight)
        .where(
          and(
            eq(containerFreight.companyId, companyId),
            sql`${containerFreight.containerId} IN (${sql.join(
              containerIds.map((id: number) => sql`${id}`),
              sql`, `
            )})`
          )
        );

      const allBales = await db.select().from(factoryBales).where(eq(factoryBales.companyId, companyId));

      const allOrderBales = await db.select().from(customerOrderBales);

      const orderBaleMap = new Map(allOrderBales.map((ob) => [ob.baleId, ob] as const));

      const [settings] = await db.select().from(factorySettings).where(eq(factorySettings.companyId, companyId));

      const laborCostPerKg = toMoney(settings?.laborCostPerKg);
      const overheadPerKg = toMoney(settings?.overheadPerKg);

      const mixSources = await db
        .select()
        .from(factoryMixBatchSources)
        .where(
          sql`${factoryMixBatchSources.containerId} IN (${sql.join(
            containerIds.map((id: number) => sql`${id}`),
            sql`, `
          )})`
        );

      const result = containers.map((container) => {
        const containerRawStock = rawStockEntries.filter((r) => r.containerId === container.id);
        const rawStockCost = sumMoney(containerRawStock.map((r) => toMoney(r.receivedKg).times(toMoney(r.costPerKg))));

        const containerFreightTotal = sumMoney(
          freightEntries.filter((f) => f.containerId === container.id).map((f) => f.freightAmount)
        );

        const containerMixSources = mixSources.filter((s) => s.containerId === container.id);
        const mixBatchIds = Array.from(new Set(containerMixSources.map((s) => s.mixBatchId)));

        const containerBales = allBales.filter((b) => b.mixBatchId !== null && mixBatchIds.includes(b.mixBatchId));
        const baleTotalKg = sumMoney(containerBales.map((b) => b.weightKg));
        const baleLaborCost = baleTotalKg.times(laborCostPerKg);
        const baleOverheadCost = baleTotalKg.times(overheadPerKg);

        const totalCost = sumMoney([rawStockCost, containerFreightTotal, baleLaborCost, baleOverheadCost]);

        const totalRevenue = sumMoney(containerBales.map((bale) => orderBaleMap.get(bale.id)?.priceUsed));

        const profit = totalRevenue.minus(totalCost);
        const marginPct = totalRevenue.gt(0) ? profit.div(totalRevenue).times(100) : new MoneyDecimal(0);

        return {
          containerId: container.id,
          containerNumber: container.containerNumber,
          totalCost: cents(totalCost),
          totalRevenue: cents(totalRevenue),
          profit: cents(profit),
          marginPct: cents(marginPct),
        };
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching container profitability:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // 6. Alerts
  // ───────────────────────────────────────────────
}
