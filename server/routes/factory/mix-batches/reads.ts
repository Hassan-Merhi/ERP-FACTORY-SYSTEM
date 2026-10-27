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
import { db, pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryMixBatches } from "@shared/schema";
import { eq, and, desc, isNull } from "drizzle-orm";
import { toMoney } from "../../../lib/money";

export function registerFactoryMixBatchReadRoutes(app: Express) {
  app.get("/api/factory/mix-batches", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const where = and(eq(factoryMixBatches.companyId, companyId), isNull(factoryMixBatches.deletedAt));

      // Summary/picker consumers only need the batch identity and utilization
      // fields. Skip source-row loading and supplier-rate recomputation entirely.
      if (req.query.profile === "summary") {
        const rows = await db
          .select({
            id: factoryMixBatches.id,
            batchCode: factoryMixBatches.batchCode,
            name: factoryMixBatches.name,
            status: factoryMixBatches.status,
            totalWeightKg: factoryMixBatches.totalWeightKg,
            usedKg: factoryMixBatches.usedKg,
            costPerKg: factoryMixBatches.costPerKg,
            batchDate: factoryMixBatches.batchDate,
            createdAt: factoryMixBatches.createdAt,
          })
          .from(factoryMixBatches)
          .where(where)
          .orderBy(desc(factoryMixBatches.createdAt));

        return res.json(
          rows.map((batch) => ({
            ...batch,
            remainingKg: toMoney(batch.totalWeightKg).minus(toMoney(batch.usedKg)).toFixed(3),
          }))
        );
      }

      const results = await db.select().from(factoryMixBatches).where(where).orderBy(desc(factoryMixBatches.createdAt));

      // Mix-batch list is a historical ledger view. Use the persisted batch
      // valuation exactly as Production Overview does; never re-price old batches
      // from the supplier's current locked rate. Current supplier rates can change
      // after later offloads/corrections and some legacy suppliers have no current
      // stock rate at all, which previously made valid historical batches display
      // as $0.0000/kg here even though their stored batch valuation was correct.
      const enriched = results.map((b) => {
        const total = toMoney(b.totalWeightKg);
        const used = toMoney(b.usedKg);

        return {
          ...b,
          remainingKg: total.minus(used).toFixed(3),
          displayTotalWeightKg: total.toFixed(3),
          displayTotalCost: toMoney(b.totalCost).toFixed(6),
          displayCostPerKg: toMoney(b.costPerKg).toFixed(6),
        };
      });

      res.set("X-ERP-Payload-Profile", "mix-batches-historical-stored-costs");
      res.set("Cache-Control", "private, max-age=10");
      res.json(enriched);
    } catch (error: unknown) {
      logger.error("Error fetching mix batches:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Batch source valuation as historically recorded, scoped to the selected
  // company. Used by the Raw Materials per-supplier daily cost Excel export.
  // One joined query avoids a per-batch request and never reprices inventory.
  app.get("/api/factory/mix-batches/cost-sources", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const result = await pool.query(
        `SELECT s.id,
                s.mix_batch_id AS "mixBatchId",
                COALESCE(sup_direct.id, sup_via_c.id) AS "supplierId",
                COALESCE(NULLIF(sup_direct.name, ''), NULLIF(sup_via_c.name, ''),
                  CASE WHEN s.source_batch_id IS NOT NULL THEN 'Source batch: ' || prior.batch_code END,
                  'Unassigned supplier') AS "supplierName",
                COALESCE(category.name, 'Uncategorized') AS "categoryName",
                c.container_number AS "containerNumber",
                s.source_batch_id AS "sourceBatchId",
                s.weight_kg AS "weightKg",
                s.total_cost AS "totalCost",
                s.cost_per_kg AS "costPerKg"
         FROM factory_mix_batch_sources s
         JOIN factory_mix_batches b ON b.id = s.mix_batch_id
         LEFT JOIN factory_containers c
           ON c.id = s.container_id AND c.company_id = b.company_id
         LEFT JOIN factory_suppliers sup_direct
           ON sup_direct.id = s.supplier_id AND sup_direct.company_id = b.company_id
         LEFT JOIN factory_suppliers sup_via_c
           ON sup_via_c.id = c.supplier_id AND sup_via_c.company_id = b.company_id
         LEFT JOIN factory_mix_batches prior
           ON prior.id = s.source_batch_id AND prior.company_id = b.company_id
         LEFT JOIN factory_supplier_categories category
           ON category.id = COALESCE(sup_direct.supplier_category_id, sup_via_c.supplier_category_id)
          AND category.company_id = b.company_id
         WHERE b.company_id = $1 AND b.deleted_at IS NULL
           AND b.carry_forward_from_id IS NULL
         ORDER BY b.id DESC, s.id`,
        [companyId],
      );
      res.set("Cache-Control", "private, no-store");
      res.json(result.rows);
    } catch (error: unknown) {
      logger.error("Error fetching historical mix batch cost sources:", { error });
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

      res.set("Cache-Control", "private, max-age=30");
      res.json({ ...batch, remainingKg: toMoney(batch.totalWeightKg).minus(toMoney(batch.usedKg)).toFixed(3) });
    } catch (error: unknown) {
      logger.error("Error fetching mix batch:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
