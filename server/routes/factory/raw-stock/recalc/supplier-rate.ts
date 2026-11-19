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
import { validateRequest } from "../../../../lib/validateRequest";
import { supplierRateRecomputeInput } from "../rawStockWriteRouteSchemas";
import { logAudit } from "../../../helpers/auditHelpers";
import { getStableSupplierCost } from "../../../../services/factory/rawStockStableCost";
import { db } from "../../../../db";
import { factorySuppliers } from "@shared/schema";
import { eq, and } from "drizzle-orm";

import { ADMIN_ROLES } from "./_helpers";
import { toMoney } from "../../../../lib/money";
import { registerRawStockSupplierRateRoutesPart1 } from "./registerRawStockSupplierRateRoutesPart1";

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
    validateRequest(supplierRateRecomputeInput),
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

          const oldRate = toMoney(existing.currentRawMaterialCostPerKgUsd as string).toNumber();
          const supplierName = existing.name || `Supplier #${sid}`;
          const { costPerKgUsd, totalReceivedKg, rows, unvaluedRowIds } = await db.transaction(async (tx) => {
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
              // Wave 11: a row costed only in its native currency is never read as USD.
              skipped:
                unvaluedRowIds.length > 0
                  ? `Raw-stock rows without a USD cost: ${unvaluedRowIds.join(", ")}`
                  : "No usable raw-stock rows",
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
            // Phase 21 (B): the write and its audit commit together.
            await db.transaction(async (tx) => {
              await tx
                .update(factorySuppliers)
                .set({ currentRawMaterialCostPerKgUsd: String(costPerKgUsd), updatedAt: new Date() })
                .where(and(eq(factorySuppliers.id, sid), eq(factorySuppliers.companyId, companyId)));

              await logAudit(
                {
                  userId: requireSessionUserId(req),
                  username: req.session.username || requireSessionUserId(req),
                  companyId,
                  action: "update",
                  tableName: "factory_suppliers",
                  recordId: sid,
                  recordIdentifier: `supplier-rate/recompute — stable avg from ${rows.length} rows, totalReceived ${totalReceivedKg}kg`,
                  changes: { currentRawMaterialCostPerKgUsd: { old: oldRate, new: costPerKgUsd } },
                },
                tx
              );
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

  registerRawStockSupplierRateRoutesPart1(app);
}
