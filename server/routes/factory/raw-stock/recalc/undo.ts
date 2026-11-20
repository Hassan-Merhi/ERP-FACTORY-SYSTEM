/**
 * rawStockRecalcRoutesLegacy: RawStockRecalcUndo endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { requireAuth, requireRole } from "../../../../auth";
import { validateRequest } from "../../../../lib/validateRequest";
import { recalcUndoInput } from "../rawStockWriteRouteSchemas";
import { pool } from "../../../../db";

import { ADMIN_ROLES } from "./_helpers";

export function registerRawStockRecalcUndoRoutes(app: Express) {
  // ── Undo log — list recent applies ─────────────────────────────────────────
  app.get(
    "/api/factory/raw-stock/recalc/undo-log",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { rows } = await pool.query(
          `SELECT id, company_id AS "companyId", user_id AS "userId", username,
                  description, container_count AS "containerCount",
                  container_numbers AS "containerNumbers",
                  applied_at AS "appliedAt",
                  undone_at AS "undoneAt",
                  undone_by_user_id AS "undoneByUserId",
                  undone_by_username AS "undoneByUsername"
           FROM factory_recalc_undo_log
           WHERE company_id = $1
           ORDER BY applied_at DESC
           LIMIT 30`,
          [companyId]
        );
        res.json(rows);
      } catch (err: unknown) {
        logger.error("[recalc undo-log] error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) || "Failed to load undo log" });
      }
    }
  );

  // ── Undo — restore a previous apply from its snapshot ──────────────────────
  app.post(
    "/api/factory/raw-stock/recalc/undo",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    validateRequest(recalcUndoInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { undoLogId } = req.body;
        if (!undoLogId || isNaN(parseInt(undoLogId))) {
          return res.status(400).json({ message: "undoLogId is required" });
        }

        // Load the snapshot row
        const { rows } = await pool.query(`SELECT * FROM factory_recalc_undo_log WHERE id = $1 AND company_id = $2`, [
          parseInt(undoLogId),
          companyId,
        ]);
        const logRow = rows[0];
        if (!logRow) return res.status(404).json({ message: "Undo log entry not found" });
        if (logRow.undone_at) {
          return res.status(400).json({ message: "This recalculation has already been undone." });
        }

        const snapshot = logRow.snapshot as {
          containers: Array<{
            id: number;
            finalPayableAmount: string;
            ratePerKgUsd: string;
            finalPayableAmountUsd: string;
          }>;
          rawStockRows: Array<{ id: number; costPerKg: string; costPerKgUsd: string }>;
          mixBatchSources: Array<{ id: number; costPerKg: string; totalCost: string }>;
          mixBatches: Array<{ id: number; costPerKg: string; totalCost: string }>;
          bales: Array<{ id: number; costPerKg: string; totalCost: string }>;
          suppliers: Array<{ id: number; currentRawMaterialCostPerKgUsd: string }>;
        };

        // DEFECT 5 FIX: Apply the undo in a single atomic transaction with
        // advisory lock + row-level FOR UPDATE to prevent concurrent double-undo.
        // The mark-as-undone is now inside the same transaction as the restore writes.
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SELECT pg_advisory_xact_lock(9003, $1)`, [companyId]);

          // Re-verify inside the lock to prevent TOCTOU double-undo.
          const { rows: lockedRows } = await client.query(
            `SELECT id, undone_at, snapshot FROM factory_recalc_undo_log
             WHERE id = $1 AND company_id = $2 FOR UPDATE`,
            [parseInt(undoLogId), companyId]
          );
          if (!lockedRows[0]) throw Object.assign(new Error("Undo log entry not found"), { undoStatus: 404 });
          if (lockedRows[0].undone_at)
            throw Object.assign(new Error("This recalculation has already been undone."), { undoStatus: 400 });

          const lockedSnapshot = lockedRows[0].snapshot as {
            containers: Array<{
              id: number;
              finalPayableAmount: string;
              ratePerKgUsd: string;
              finalPayableAmountUsd: string;
            }>;
            rawStockRows: Array<{ id: number; costPerKg: string; costPerKgUsd: string }>;
            mixBatchSources: Array<{ id: number; costPerKg: string; totalCost: string }>;
            mixBatches: Array<{ id: number; costPerKg: string; totalCost: string }>;
            bales: Array<{ id: number; costPerKg: string; totalCost: string }>;
            suppliers: Array<{ id: number; currentRawMaterialCostPerKgUsd: string }>;
          };

          // All undo UPDATEs include company_id guard.
          // FIX 9: Check rowCount === 1 after each UPDATE; if 0, rollback (row disappeared
          // or belongs to another company — signals a serious data integrity issue).
          for (const c of lockedSnapshot.containers) {
            const { rowCount: rc } = await client.query(
              `UPDATE factory_containers
               SET final_payable_amount = $1, rate_per_kg_usd = $2, final_payable_amount_usd = $3, updated_at = NOW()
               WHERE id = $4 AND company_id = $5`,
              [c.finalPayableAmount, c.ratePerKgUsd, c.finalPayableAmountUsd, c.id, companyId]
            );
            if (!rc || rc === 0)
              throw Object.assign(new Error(`Undo: container ${c.id} not found or belongs to another company.`), {
                undoStatus: 400,
              });
          }
          for (const rs of lockedSnapshot.rawStockRows) {
            const { rowCount: rc } = await client.query(
              `UPDATE factory_raw_stock SET cost_per_kg = $1, cost_per_kg_usd = $2
               WHERE id = $3 AND company_id = $4`,
              [rs.costPerKg, rs.costPerKgUsd, rs.id, companyId]
            );
            if (!rc || rc === 0)
              throw Object.assign(new Error(`Undo: raw_stock ${rs.id} not found.`), { undoStatus: 400 });
          }
          for (const src of lockedSnapshot.mixBatchSources) {
            // Sources have no direct company_id — gate via their parent batch.
            const { rowCount: rc } = await client.query(
              `UPDATE factory_mix_batch_sources SET cost_per_kg = $1, total_cost = $2
               WHERE id = $3
                 AND mix_batch_id IN (SELECT id FROM factory_mix_batches WHERE company_id = $4)`,
              [src.costPerKg, src.totalCost, src.id, companyId]
            );
            if (!rc || rc === 0)
              throw Object.assign(new Error(`Undo: source ${src.id} not found.`), { undoStatus: 400 });
          }
          for (const b of lockedSnapshot.mixBatches) {
            const { rowCount: rc } = await client.query(
              `UPDATE factory_mix_batches SET cost_per_kg = $1, total_cost = $2, updated_at = NOW()
               WHERE id = $3 AND company_id = $4`,
              [b.costPerKg, b.totalCost, b.id, companyId]
            );
            if (!rc || rc === 0)
              throw Object.assign(new Error(`Undo: mix_batch ${b.id} not found.`), { undoStatus: 400 });
          }
          for (const bale of lockedSnapshot.bales) {
            const { rowCount: rc } = await client.query(
              `UPDATE factory_bales SET cost_per_kg = $1, total_cost = $2, updated_at = NOW()
               WHERE id = $3 AND company_id = $4`,
              [bale.costPerKg, bale.totalCost, bale.id, companyId]
            );
            if (!rc || rc === 0)
              throw Object.assign(new Error(`Undo: bale ${bale.id} not found.`), { undoStatus: 400 });
          }
          for (const sup of lockedSnapshot.suppliers) {
            const { rowCount: rc } = await client.query(
              `UPDATE factory_suppliers SET current_raw_material_cost_per_kg_usd = $1, updated_at = NOW()
               WHERE id = $2 AND company_id = $3`,
              [sup.currentRawMaterialCostPerKgUsd, sup.id, companyId]
            );
            if (!rc || rc === 0)
              throw Object.assign(new Error(`Undo: supplier ${sup.id} not found.`), { undoStatus: 400 });
          }

          // DEFECT 7 FIX: Mark as undone atomically with the restore writes.
          await client.query(
            `UPDATE factory_recalc_undo_log
             SET undone_at = NOW(), undone_by_user_id = $1, undone_by_username = $2
             WHERE id = $3 AND company_id = $4`,
            [req.session.userId ?? null, req.session.username ?? null, parseInt(undoLogId), companyId]
          );

          // DEFECT 7 FIX: Insert undo audit log inside the same transaction.
          await client.query(
            `INSERT INTO audit_log
               (user_id, username, company_id, action, table_name, record_id, record_identifier, changes, created_at)
             VALUES ($1, $2, $3, 'undo', 'factory_recalc_undo_log', $4, $5, $6::jsonb, NOW())`,
            [
              req.session.userId ?? null,
              req.session.username ?? null,
              companyId,
              parseInt(undoLogId),
              `historical-replay undo — log ${undoLogId}`,
              JSON.stringify({
                containersRestored: lockedSnapshot.containers.length,
                rawStockRowsRestored: lockedSnapshot.rawStockRows.length,
                sourcesRestored: lockedSnapshot.mixBatchSources.length,
                batchesRestored: lockedSnapshot.mixBatches.length,
                balesRestored: lockedSnapshot.bales.length,
                suppliersRestored: lockedSnapshot.suppliers.length,
              }),
            ]
          );

          await client.query("COMMIT");
        } catch (txErr: unknown) {
          await client.query("ROLLBACK");
          if ((txErr as { undoStatus?: number }).undoStatus === 404)
            return res.status(404).json({ message: getErrorMessage(txErr) });
          if ((txErr as { undoStatus?: number }).undoStatus === 400)
            return res.status(400).json({ message: getErrorMessage(txErr) });
          throw txErr;
        } finally {
          client.release();
        }

        res.json({
          success: true,
          containersRestored: snapshot.containers.length,
          rawStockRowsRestored: snapshot.rawStockRows.length,
          mixBatchSourcesRestored: snapshot.mixBatchSources.length,
          mixBatchesRestored: snapshot.mixBatches.length,
          balesRestored: snapshot.bales.length,
          suppliersRestored: snapshot.suppliers.length,
        });
      } catch (err: unknown) {
        logger.error("[recalc undo] error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) || "Failed to undo recalculation" });
      }
    }
  );
}
