/**
 * factoryReportRoutes: FactoryMixBatchesByDate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, RequestHandler } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { pool, type Database } from "../../db";
import {} from "@shared/schema";

export function registerFactoryMixBatchesByDateRoutes(app: Express, requireAuth: RequestHandler, _db: Database) {
  // ── Mix batches by date ───────────────────────────────────────────────────
  app.get(
    "/api/factory/mix-batches-by-date",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session?.factoryCompanyId || req.session?.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const date = req.query.date as string;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return res.status(400).json({ message: "date query param required (YYYY-MM-DD)" });
        }

        const batchesResult = await pool.query(
          `
        SELECT b.id, b.batch_code, b.name, b.status, b.total_weight_kg, b.used_kg,
               b.cost_per_kg, b.total_cost, b.batch_date, b.created_at, b.notes
        FROM factory_mix_batches b
        WHERE b.company_id = $1
          AND b.deleted_at IS NULL
          AND (
            b.batch_date = $2::date
            OR (b.batch_date IS NULL AND DATE(b.created_at AT TIME ZONE 'UTC') = $2::date)
          )
        ORDER BY b.created_at DESC
      `,
          [companyId, date]
        );

        const batches = batchesResult.rows;
        const batchIds = batches.map((b) => b.id);

        let sources = [];
        if (batchIds.length > 0) {
          const sourcesResult = await pool.query(
            `
          SELECT
            s.id, s.mix_batch_id, s.container_id, s.supplier_id, s.source_batch_id,
            s.weight_kg, s.cost_per_kg, s.total_cost,
            c.container_number,
            COALESCE(sup_via_c.name, sup_direct.name, mb.batch_code, 'Unknown') AS source_name
          FROM factory_mix_batch_sources s
          LEFT JOIN factory_containers c ON c.id = s.container_id
          LEFT JOIN factory_suppliers sup_via_c ON sup_via_c.id = c.supplier_id
          LEFT JOIN factory_suppliers sup_direct ON sup_direct.id = s.supplier_id
          LEFT JOIN factory_mix_batches mb ON mb.id = s.source_batch_id
          WHERE s.mix_batch_id = ANY($1)
          ORDER BY s.id
        `,
            [batchIds]
          );
          sources = sourcesResult.rows;
        }

        // Historical print/share view: preserve the stored source costs exactly as
        // recorded when the batch was created. Do not re-price old sources from
        // today's raw-stock/supplier rate; that would make this view disagree with
        // Production Overview and can turn valid legacy batches into zero-cost rows.
        const enrichedSources = sources;

        const enriched = batches.map((b) => {
          const batchSources = enrichedSources.filter((s) => s.mix_batch_id === b.id);
          const totalWeight = parseFloat(b.total_weight_kg) || 0;
          const totalCost = parseFloat(b.total_cost) || 0;
          const costPerKg = parseFloat(b.cost_per_kg) || 0;
          return {
            id: b.id,
            batchCode: b.batch_code,
            name: b.name,
            status: b.status,
            totalWeightKg: totalWeight,
            totalCost,
            costPerKg,
            batchDate: b.batch_date,
            createdAt: b.created_at,
            sources: batchSources.map((s) => ({
              id: s.id,
              sourceName: s.source_name,
              containerNumber: s.container_number,
              weightKg: parseFloat(s.weight_kg) || 0,
              costPerKg: parseFloat(s.cost_per_kg) || 0,
              totalCost: parseFloat(s.total_cost) || 0,
              percentOfBatch: totalWeight > 0 ? ((parseFloat(s.weight_kg) || 0) / totalWeight) * 100 : 0,
            })),
          };
        });

        res.json(enriched);
      } catch (err: unknown) {
        logger.error("[mix-batches-by-date]", { error: err });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );
}
