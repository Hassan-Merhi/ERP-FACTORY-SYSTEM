// Extracted from ./supplier-rate.ts
import type { Express, Request, Response } from "express";
import { requireSessionUserId } from "../../../../lib/sessionUser";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { requireAuth, requireRole } from "../../../../auth";
import { validateRequest } from "../../../../lib/validateRequest";
import { supplierRateRestoreInput } from "../rawStockWriteRouteSchemas";
import { logAudit } from "../../../helpers/auditHelpers";
import { db } from "../../../../db";
import { factorySuppliers } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { pool } from "../../../../db";
import { ADMIN_ROLES } from "./_helpers";
import { parseMoneyInput, toMoney } from "../../../../lib/money";

export function registerRawStockSupplierRateRoutesPart1(app: Express) {
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
          const oldRate = toMoney(changes?.old?.currentRawMaterialCostPerKgUsd).toNumber();
          const recomputedRate = toMoney(changes?.new?.currentRawMaterialCostPerKgUsd).toNumber();
          const currentRate = toMoney(r.current_rate).toNumber();
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
    validateRequest(supplierRateRestoreInput),
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
          const rate = parseMoneyInput(entry.rate);
          const rateNum = rate?.toNumber() ?? NaN;
          if (isNaN(sid) || !rate || rate.lte(0)) {
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

          const oldRate = toMoney(existing.currentRawMaterialCostPerKgUsd as string).toNumber();

          // Phase 21 (B): the write and its audit commit together.
          await db.transaction(async (tx) => {
            await tx
              .update(factorySuppliers)
              .set({ currentRawMaterialCostPerKgUsd: rate.toFixed(), updatedAt: new Date() })
              .where(and(eq(factorySuppliers.id, sid), eq(factorySuppliers.companyId, companyId)));

            await logAudit(
              {
                userId: requireSessionUserId(req),
                username: req.session.username || requireSessionUserId(req),
                companyId,
                action: "update",
                tableName: "factory_suppliers",
                recordId: sid,
                recordIdentifier: `supplier-rate/restore-from-audit — reverted to pre-recompute moving-average rate`,
                changes: { currentRawMaterialCostPerKgUsd: { old: oldRate, new: rateNum } },
              },
              tx
            );
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
