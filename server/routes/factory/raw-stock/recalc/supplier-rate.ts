/**
 * rawStockRecalcRoutesLegacy: RawStockSupplierRate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { requireSessionUserId } from "../../../../lib/sessionUser";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { requireAuth, requireRole } from "../../../../auth";
import { logAudit } from "../../../helpers/auditHelpers";
import { getStableSupplierCost } from "../../../../services/factory/rawStockStableCost";
import { db } from "../../../../db";
import { factorySuppliers } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { pool } from "../../../../db";

import { ADMIN_ROLES } from "./_helpers";

export function registerRawStockSupplierRateRoutes(app: Express) {
  // ──────────────────────────────────────────────────────────────────────────
  // Retroactive supplier locked-rate recompute (admin-only)
  // POST /api/factory/raw-stock/supplier-rate/recompute
  // Body: { supplierId?: number, dryRun?: boolean }
  //   supplierId — omit to process ALL suppliers for this company
  //   dryRun     — when true, runs the full computation but skips writes; returns
  //                the same results array with dryRun: true so the UI can show a
  //                preview before the user explicitly confirms.
  //
  // Recalculates current_raw_material_cost_per_kg_usd using the receipt-weighted
  // stable cost across all factory_raw_stock rows (which must already carry the
  // correct cost_per_kg_usd from a prior recalc apply). Skips suppliers whose
  // stable cost is 0 (no raw-stock rows). Use after a recalc that ran while all
  // containers were fully used and the cascade skipped the locked-rate update.
  //
  // WARNING: this uses the all-time receipt-weighted average, which differs from
  // the moving-average formula used during real offloads. Use with care — prefer
  // "Restore from Audit Log" when recovering from an accidental recompute.
  // ──────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/factory/raw-stock/supplier-rate/recompute",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { supplierId, dryRun } = req.body;
      const isDryRun = dryRun === true;

      // DEFECT 13 FIX: The non-dryRun apply path is deprecated. Use Historical Replay.
      if (!isDryRun) {
        res.setHeader(
          "X-Deprecated",
          "This endpoint computes the all-time receipt-weighted stable average, not the timeline moving average. Prefer Historical Replay."
        );
        return res.status(410).json({
          message:
            "Applying supplier rate recompute is deprecated. Use the Historical Cost Replay tool instead. It uses the timeline moving-average rather than the all-time receipt-weighted average.",
          code: "USE_HISTORICAL_REPLAY",
        });
      }

      // FIX 6: Deprecation warning — this endpoint uses the all-time receipt-weighted
      // average, NOT the timeline moving-average. It can overwrite a correctly-computed
      // rate with a different value, making Historical Replay inconsistent. Prefer
      // "Historical Replay" (POST /recalc/historical-replay/apply) for any cost
      // correction. Only use this endpoint when restoring from an audit-log entry.
      res.setHeader(
        "X-Deprecated",
        "This endpoint computes the all-time receipt-weighted stable average, not the timeline moving average. Prefer Historical Replay."
      );

      try {
        // Resolve the list of supplier IDs to process
        let supplierIds: number[];
        if (supplierId != null) {
          const sid = parseInt(supplierId);
          if (isNaN(sid)) return res.status(400).json({ message: "Invalid supplierId" });
          supplierIds = [sid];
        } else {
          // Recompute all suppliers for this company
          const allSuppliers = await db
            .select({ id: factorySuppliers.id, name: factorySuppliers.name })
            .from(factorySuppliers)
            .where(eq(factorySuppliers.companyId, companyId));
          supplierIds = allSuppliers.map((s) => s.id);
        }

        const results: Array<{
          supplierId: number;
          supplierName: string;
          oldRate: number;
          newRate: number;
          rowCount: number;
          totalReceivedKg: number;
          skipped?: string;
        }> = [];

        for (const sid of supplierIds) {
          const [existing] = await db
            .select({
              currentRawMaterialCostPerKgUsd: factorySuppliers.currentRawMaterialCostPerKgUsd,
              name: factorySuppliers.name,
            })
            .from(factorySuppliers)
            .where(and(eq(factorySuppliers.id, sid), eq(factorySuppliers.companyId, companyId)));
          if (!existing) continue;

          const oldRate = parseFloat((existing.currentRawMaterialCostPerKgUsd as string) || "0");
          const supplierName = existing.name || `Supplier #${sid}`;
          const { costPerKgUsd, totalReceivedKg, rows } = await db.transaction(async (tx) => {
            return getStableSupplierCost(tx, companyId, sid);
          });

          if (costPerKgUsd <= 0) {
            results.push({
              supplierId: sid,
              supplierName,
              oldRate,
              newRate: 0,
              rowCount: 0,
              totalReceivedKg: 0,
              skipped: "No usable raw-stock rows",
            });
            continue;
          }
          if (Math.abs(costPerKgUsd - oldRate) < 0.000001) {
            results.push({
              supplierId: sid,
              supplierName,
              oldRate,
              newRate: costPerKgUsd,
              rowCount: rows.length,
              totalReceivedKg,
              skipped: "Already correct",
            });
            continue;
          }

          if (!isDryRun) {
            await db
              .update(factorySuppliers)
              .set({ currentRawMaterialCostPerKgUsd: String(costPerKgUsd), updatedAt: new Date() })
              .where(and(eq(factorySuppliers.id, sid), eq(factorySuppliers.companyId, companyId)));

            await logAudit({
              userId: requireSessionUserId(req),
              username: req.session.username || requireSessionUserId(req),
              companyId,
              action: "update",
              tableName: "factory_suppliers",
              recordId: sid,
              recordIdentifier: `supplier-rate/recompute — stable avg from ${rows.length} rows, totalReceived ${totalReceivedKg}kg`,
              changes: { currentRawMaterialCostPerKgUsd: { old: oldRate, new: costPerKgUsd } },
            });
          }
          results.push({
            supplierId: sid,
            supplierName,
            oldRate,
            newRate: costPerKgUsd,
            rowCount: rows.length,
            totalReceivedKg,
          });
        }

        res.json({
          dryRun: isDryRun,
          updated: isDryRun ? 0 : results.filter((r) => !r.skipped).length,
          wouldUpdate: results.filter((r) => !r.skipped).length,
          skipped: results.filter((r) => !!r.skipped).length,
          results,
        });
      } catch (err: unknown) {
        logger.error("[supplier-rate/recompute] error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) || "Failed to recompute supplier rate" });
      }
    }
  );

  // Read audit log for past supplier-rate/recompute events
  // GET /api/factory/raw-stock/supplier-rate/recompute-audit
  // Returns one row per supplier (most recent recompute event), with the old rate
  // that was overwritten so the user can restore it via restore-from-audit.
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    "/api/factory/raw-stock/supplier-rate/recompute-audit",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      try {
        // DISTINCT ON keeps the most-recent recompute event per supplier
        const result = await pool.query(
          `SELECT DISTINCT ON (al.record_id)
             al.record_id       AS supplier_id,
             al.record_identifier,
             al.created_at      AS overwritten_at,
             al.username        AS changed_by,
             al.changes,
             fs.name            AS supplier_name,
             fs.current_raw_material_cost_per_kg_usd AS current_rate
           FROM audit_log al
           JOIN factory_suppliers fs
             ON fs.id = al.record_id
            AND fs.company_id = $1
           WHERE al.table_name = 'factory_suppliers'
             AND al.record_identifier LIKE 'supplier-rate/recompute%'
             AND al.company_id = $1
           ORDER BY al.record_id, al.created_at DESC`,
          [companyId]
        );

        const rows = result.rows.map((r) => {
          const changes = typeof r.changes === "string" ? JSON.parse(r.changes) : (r.changes ?? {});
          const oldRate = parseFloat(changes?.old?.currentRawMaterialCostPerKgUsd ?? 0) || 0;
          const recomputedRate = parseFloat(changes?.new?.currentRawMaterialCostPerKgUsd ?? 0) || 0;
          const currentRate = parseFloat(r.current_rate ?? 0) || 0;
          // canRestore: true only when the current rate still matches what the recompute wrote
          // (i.e. nothing else has overwritten it since)
          const canRestore = oldRate > 0 && Math.abs(currentRate - recomputedRate) < 0.000001;
          return {
            supplierId: Number(r.supplier_id),
            supplierName: r.supplier_name ?? `Supplier #${r.supplier_id}`,
            oldRate,
            recomputedRate,
            currentRate,
            overwroteAt: r.overwritten_at,
            changedBy: r.changed_by,
            canRestore,
          };
        });

        res.json(rows);
      } catch (err: unknown) {
        logger.error("[supplier-rate/recompute-audit] error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) || "Failed to fetch recompute audit" });
      }
    }
  );

  // Restore supplier locked rates to the values recorded in the audit log
  // POST /api/factory/raw-stock/supplier-rate/restore-from-audit
  // Body: { restorations: [{ supplierId: number, rate: number }] }
  // ──────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/factory/raw-stock/supplier-rate/restore-from-audit",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { restorations } = req.body;
      if (!Array.isArray(restorations) || restorations.length === 0) {
        return res.status(400).json({ message: "restorations must be a non-empty array" });
      }

      try {
        const results: Array<{
          supplierId: number;
          supplierName: string;
          oldRate: number;
          restoredRate: number;
          status: "restored" | "error";
          reason?: string;
        }> = [];

        for (const entry of restorations) {
          const sid = parseInt(entry.supplierId);
          const rateNum = parseFloat(entry.rate);
          if (isNaN(sid) || isNaN(rateNum) || rateNum <= 0) {
            results.push({
              supplierId: sid || 0,
              supplierName: "",
              oldRate: 0,
              restoredRate: rateNum || 0,
              status: "error",
              reason: "Invalid supplierId or rate",
            });
            continue;
          }

          const [existing] = await db
            .select({
              id: factorySuppliers.id,
              name: factorySuppliers.name,
              currentRawMaterialCostPerKgUsd: factorySuppliers.currentRawMaterialCostPerKgUsd,
            })
            .from(factorySuppliers)
            .where(and(eq(factorySuppliers.id, sid), eq(factorySuppliers.companyId, companyId)));

          if (!existing) {
            results.push({
              supplierId: sid,
              supplierName: "",
              oldRate: 0,
              restoredRate: rateNum,
              status: "error",
              reason: "Supplier not found in this company",
            });
            continue;
          }

          const oldRate = parseFloat((existing.currentRawMaterialCostPerKgUsd as string) || "0");

          await db
            .update(factorySuppliers)
            .set({ currentRawMaterialCostPerKgUsd: String(rateNum), updatedAt: new Date() })
            .where(and(eq(factorySuppliers.id, sid), eq(factorySuppliers.companyId, companyId)));

          await logAudit({
            userId: requireSessionUserId(req),
            username: req.session.username || requireSessionUserId(req),
            companyId,
            action: "update",
            tableName: "factory_suppliers",
            recordId: sid,
            recordIdentifier: `supplier-rate/restore-from-audit — reverted to pre-recompute moving-average rate`,
            changes: { currentRawMaterialCostPerKgUsd: { old: oldRate, new: rateNum } },
          });

          results.push({
            supplierId: sid,
            supplierName: existing.name || `Supplier #${sid}`,
            oldRate,
            restoredRate: rateNum,
            status: "restored",
          });
        }

        res.json({
          restored: results.filter((r) => r.status === "restored").length,
          errors: results.filter((r) => r.status === "error").length,
          results,
        });
      } catch (err: unknown) {
        logger.error("[supplier-rate/restore-from-audit] error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) || "Failed to restore supplier rates" });
      }
    }
  );
}
