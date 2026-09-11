/**
 * factoryMixBatchRoutes: FactoryMixBatchRead endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryMixBatches, factoryMixBatchSources } from "@shared/schema";
import { eq, and, desc, inArray, isNull } from "drizzle-orm";
import { getLockedSupplierRatesReadOnlyBulk } from "../../../services/factory/rawStockLockedRateBulk";
import Decimal from "decimal.js";

export function registerFactoryMixBatchReadRoutes(app: Express) {
  app.get("/api/factory/mix-batches", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const results = await db
        .select()
        .from(factoryMixBatches)
        .where(and(eq(factoryMixBatches.companyId, companyId), isNull(factoryMixBatches.deletedAt)))
        .orderBy(desc(factoryMixBatches.createdAt));

      // ── Display-blend calculation (read-only, no DB writes) ──
      const batchIds = results.map((b) => b.id);
      type MixBatchSourceRow = {
        mixBatchId: number;
        sourceBatchId: number | null;
        supplierId: number | null;
        weightKg: string;
        costPerKg: string;
      };
      let sourceRows: MixBatchSourceRow[] = [];
      if (batchIds.length > 0) {
        // Only read the fields needed to compute list display totals. The old
        // select() materialized every source column even though none of the
        // source records themselves are returned by this endpoint.
        sourceRows = await db
          .select({
            mixBatchId: factoryMixBatchSources.mixBatchId,
            sourceBatchId: factoryMixBatchSources.sourceBatchId,
            supplierId: factoryMixBatchSources.supplierId,
            weightKg: factoryMixBatchSources.weightKg,
            costPerKg: factoryMixBatchSources.costPerKg,
          })
          .from(factoryMixBatchSources)
          .where(inArray(factoryMixBatchSources.mixBatchId, batchIds));
      }

      const uniqueSupplierIds = [
        ...new Set(sourceRows.filter((s) => s.supplierId != null).map((s) => Number(s.supplierId))),
      ].filter((id) => Number.isInteger(id) && id > 0);

      // Phase 3: persisted supplier locked rates are loaded in one query rather
      // than one query per supplier. Legacy NULL-rate suppliers still use the
      // same stable historical derivation as before, read-only and concurrently.
      const supplierRateMap = await getLockedSupplierRatesReadOnlyBulk(db, Number(companyId), uniqueSupplierIds);

      const sourcesByBatch = new Map();
      for (const src of sourceRows) {
        if (!sourcesByBatch.has(src.mixBatchId)) sourcesByBatch.set(src.mixBatchId, []);
        sourcesByBatch.get(src.mixBatchId)!.push(src);
      }

      const enriched = results.map((b) => {
        const total = parseFloat(b.totalWeightKg) || 0;
        const used = parseFloat(b.usedKg) || 0;

        // Compute display totals using the same source rules as EditMixBatchDialog:
        //   A. sourceBatchId exists → use source row's stored costPerKg
        //   B. supplierId exists (incl. FIFO rows with containerId+supplierId) → current locked rate
        //   C. neither → fall back to source row's stored costPerKg
        const sources = sourcesByBatch.get(b.id) || [];
        let displayTotalWeightKg = new Decimal(0);
        let displayTotalCost = new Decimal(0);
        for (const src of sources) {
          const w = new Decimal(src.weightKg || 0);
          let effectiveCostPerKg: Decimal;
          if (src.sourceBatchId != null) {
            effectiveCostPerKg = new Decimal(src.costPerKg || 0);
          } else if (src.supplierId != null) {
            effectiveCostPerKg = new Decimal(supplierRateMap.get(Number(src.supplierId)) || 0);
          } else {
            effectiveCostPerKg = new Decimal(src.costPerKg || 0);
          }
          displayTotalWeightKg = displayTotalWeightKg.plus(w);
          displayTotalCost = displayTotalCost.plus(w.times(effectiveCostPerKg));
        }

        let displayCostPerKg: Decimal;
        if (displayTotalWeightKg.gt(0)) {
          displayCostPerKg = displayTotalCost.dividedBy(displayTotalWeightKg);
        } else {
          // No source rows → fall back to stored batch values
          displayTotalWeightKg = new Decimal(b.totalWeightKg || 0);
          displayTotalCost = new Decimal(b.totalCost || 0);
          displayCostPerKg = new Decimal(b.costPerKg || 0);
        }

        return {
          ...b,
          remainingKg: (total - used).toFixed(3),
          displayTotalWeightKg: displayTotalWeightKg.toFixed(3),
          displayTotalCost: displayTotalCost.toFixed(6),
          displayCostPerKg: displayCostPerKg.toFixed(6),
        };
      });

      res.set("X-ERP-Payload-Profile", "mix-batches-bulk-locked-rates");
      res.set("Cache-Control", "private, max-age=10");
      res.json(enriched);
    } catch (error: unknown) {
      logger.error("Error fetching mix batches:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/mix-batches/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [batch] = await db
        .select()
        .from(factoryMixBatches)
        .where(and(eq(factoryMixBatches.id, id), eq(factoryMixBatches.companyId, companyId)));

      if (!batch) return res.status(404).json({ message: "Mix batch not found" });

      const total = parseFloat(batch.totalWeightKg) || 0;
      const used = parseFloat(batch.usedKg) || 0;
      res.set("Cache-Control", "private, max-age=30");
      res.json({ ...batch, remainingKg: (total - used).toFixed(3) });
    } catch (error: unknown) {
      logger.error("Error fetching mix batch:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
