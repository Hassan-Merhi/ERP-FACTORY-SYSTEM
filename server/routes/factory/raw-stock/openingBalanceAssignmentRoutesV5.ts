import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import Decimal from "decimal.js";
import { requireAuth } from "../../../auth";
import { pool } from "../../../db";
import { parseId } from "../../../lib/parseId";

function normalizeBaleIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.some((id) => !Number.isInteger(id) || id <= 0)) return null;
  const ids = [...new Set(value as number[])].sort((left, right) => left - right);
  return ids.length === value.length ? ids : null;
}

/**
 * Exact transaction-safe replacement for opening-balance bale assignment.
 * Consumption never recalculates or lazily backfills a supplier rate: it locks
 * and uses the already-persisted authoritative rate, or refuses the write.
 */
export function registerOpeningBalanceAssignmentRoutesV5(app: Express): void {
  app.post(
    "/api/factory/raw-stock/:rawStockId/assign-to-bales",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rawStockId = parseId(req.params.rawStockId);
      if (rawStockId == null) return res.status(400).json({ message: "Invalid raw stock id" });
      const baleIds = normalizeBaleIds(req.body?.baleIds);
      if (!baleIds) {
        return res.status(400).json({
          message: "baleIds must be a non-empty array of unique positive integers",
        });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        await client.query(`SELECT pg_advisory_xact_lock(9003, $1)`, [companyId]);
        await client.query(`SELECT pg_advisory_xact_lock(9004, $1)`, [companyId]);

        const rawStockResult = await client.query<{
          id: number;
          container_id: number;
          cost_per_kg_usd: string | null;
          used_kg: string;
          supplier_id: number | null;
        }>(
          `SELECT frs.id,
                  frs.container_id,
                  frs.cost_per_kg_usd,
                  frs.used_kg,
                  fc.supplier_id
           FROM factory_raw_stock frs
           JOIN factory_containers fc ON fc.id = frs.container_id
           WHERE frs.id = $1
             AND frs.company_id = $2
             AND fc.company_id = $2
             AND frs.deleted_at IS NULL
             AND fc.deleted_at IS NULL
             AND fc.status = 'OPENING_BALANCE'
           FOR UPDATE OF frs, fc`,
          [rawStockId, companyId]
        );
        const rawStock = rawStockResult.rows[0];
        if (!rawStock) {
          await client.query("ROLLBACK");
          return res.status(404).json({
            message: "Opening-balance raw stock was not found, is deleted, or belongs to another company",
          });
        }

        const baleResult = await client.query<{
          id: number;
          weight_kg: string;
          mix_batch_id: number | null;
          status: string;
        }>(
          `SELECT id, weight_kg, mix_batch_id, status
           FROM factory_bales
           WHERE company_id = $1
             AND id = ANY($2)
             AND deleted_at IS NULL
           ORDER BY id
           FOR UPDATE`,
          [companyId, baleIds]
        );
        if (baleResult.rows.length !== baleIds.length) {
          throw Object.assign(
            new Error("One or more bales no longer exist, are deleted, or belong to another company"),
            { statusCode: 409 }
          );
        }
        for (const bale of baleResult.rows) {
          if (bale.mix_batch_id != null || bale.status !== "IN_STOCK") {
            throw Object.assign(
              new Error(`Bale ${bale.id} is no longer an unlinked IN_STOCK bale`),
              { statusCode: 409 }
            );
          }
        }

        let costPerKgUsd: Decimal;
        if (rawStock.supplier_id != null) {
          const supplierResult = await client.query<{
            current_raw_material_cost_per_kg_usd: string | null;
          }>(
            `SELECT current_raw_material_cost_per_kg_usd
             FROM factory_suppliers
             WHERE id = $1 AND company_id = $2
             FOR UPDATE`,
            [rawStock.supplier_id, companyId]
          );
          const storedRate = supplierResult.rows[0]?.current_raw_material_cost_per_kg_usd;
          if (storedRate == null || new Decimal(storedRate).lt(0)) {
            throw Object.assign(
              new Error(
                "Supplier has no valid persisted authoritative USD raw-material rate. "
                + "Assignment was not applied because consumption must never create or change that rate."
              ),
              { statusCode: 409 }
            );
          }
          costPerKgUsd = new Decimal(storedRate);
        } else {
          if (rawStock.cost_per_kg_usd == null) {
            throw Object.assign(
              new Error(
                "Opening-balance direct source has no stored USD cost. Resolve its FX/cost before assigning bales."
              ),
              { statusCode: 409 }
            );
          }
          costPerKgUsd = new Decimal(rawStock.cost_per_kg_usd);
          if (costPerKgUsd.lt(0)) {
            throw Object.assign(new Error("Opening-balance source has an invalid direct USD cost"), { statusCode: 409 });
          }
        }

        const totalKg = baleResult.rows.reduce(
          (sum, bale) => sum.plus(new Decimal(bale.weight_kg || 0)),
          new Decimal(0)
        );
        if (totalKg.lte(0)) {
          throw Object.assign(new Error("Selected bales have no positive weight"), { statusCode: 400 });
        }
        const totalCost = totalKg.times(costPerKgUsd);
        const batchCode = `OB-ASSIGN-${rawStockId}-${Date.now()}`;

        const batchResult = await client.query<{ id: number }>(
          `INSERT INTO factory_mix_batches
             (company_id, batch_code, batch_number, name, total_weight_kg, used_kg,
              cost_per_kg, total_cost, status, updated_at)
           VALUES ($1, $2, $2, 'OB Stock Assignment', $3, $3, $4, $5, 'COMPLETED', NOW())
           RETURNING id`,
          [
            companyId,
            batchCode,
            totalKg.toDecimalPlaces(3).toFixed(3),
            costPerKgUsd.toDecimalPlaces(6).toFixed(6),
            totalCost.toDecimalPlaces(6).toFixed(6),
          ]
        );
        const mixBatchId = batchResult.rows[0]?.id;
        if (!mixBatchId) throw new Error("Failed to create opening-balance assignment batch");

        await client.query(
          `INSERT INTO factory_mix_batch_sources
             (mix_batch_id, container_id, supplier_id, source_type, weight_kg,
              quantity_kg, cost_per_kg, total_cost)
           VALUES ($1, $2, $3, $4, $5, $5, $6, $7)`,
          [
            mixBatchId,
            rawStock.container_id,
            rawStock.supplier_id,
            rawStock.supplier_id == null ? "CONTAINER_DIRECT" : "SUPPLIER_LOCKED_RATE",
            totalKg.toDecimalPlaces(3).toFixed(3),
            costPerKgUsd.toDecimalPlaces(6).toFixed(6),
            totalCost.toDecimalPlaces(6).toFixed(6),
          ]
        );

        for (const bale of baleResult.rows) {
          const baleTotalCost = new Decimal(bale.weight_kg || 0).times(costPerKgUsd);
          const update = await client.query(
            `UPDATE factory_bales
             SET mix_batch_id = $1,
                 cost_per_kg = $2,
                 total_cost = $3,
                 updated_at = NOW()
             WHERE id = $4
               AND company_id = $5
               AND mix_batch_id IS NULL
               AND status = 'IN_STOCK'
               AND deleted_at IS NULL`,
            [
              mixBatchId,
              costPerKgUsd.toDecimalPlaces(6).toFixed(6),
              baleTotalCost.toDecimalPlaces(6).toFixed(6),
              bale.id,
              companyId,
            ]
          );
          if (update.rowCount !== 1) {
            throw Object.assign(
              new Error(`Bale ${bale.id} changed during assignment`),
              { statusCode: 409 }
            );
          }
        }

        const rawStockUpdate = await client.query(
          `UPDATE factory_raw_stock
           SET used_kg = used_kg + $1
           WHERE id = $2
             AND company_id = $3
             AND container_id = $4
             AND deleted_at IS NULL`,
          [
            totalKg.toDecimalPlaces(3).toFixed(3),
            rawStockId,
            companyId,
            rawStock.container_id,
          ]
        );
        if (rawStockUpdate.rowCount !== 1) {
          throw Object.assign(new Error("Raw-stock row changed during assignment"), { statusCode: 409 });
        }

        await client.query(
          `INSERT INTO audit_log
             (user_id, username, company_id, action, table_name, record_id,
              record_identifier, changes, created_at)
           VALUES ($1, $2, $3, 'opening_balance_assign_to_bales',
                   'factory_raw_stock', $4, $5, $6::jsonb, NOW())`,
          [
            String(req.session.userId ?? ""),
            req.session.username ?? null,
            companyId,
            rawStockId,
            `opening balance assignment ${batchCode}`,
            JSON.stringify({
              mixBatchId,
              baleIds,
              totalKg: totalKg.toDecimalPlaces(3).toFixed(3),
              costPerKgUsd: costPerKgUsd.toDecimalPlaces(6).toFixed(6),
              supplierId: rawStock.supplier_id,
              supplierRateChanged: false,
            }),
          ]
        );

        await client.query("COMMIT");
        return res.json({
          success: true,
          mixBatchId,
          totalKg: totalKg.toNumber(),
          balesUpdated: baleIds.length,
        });
      } catch (error: unknown) {
        await client.query("ROLLBACK");
        logger.error("[opening-balance assignment v5] error:", { error: error });
        return res.status((error as { statusCode?: number }).statusCode ?? 500).json({
          message: getErrorMessage(error) || "Failed to assign opening-balance stock to bales",
        });
      } finally {
        client.release();
      }
    }
  );
}
