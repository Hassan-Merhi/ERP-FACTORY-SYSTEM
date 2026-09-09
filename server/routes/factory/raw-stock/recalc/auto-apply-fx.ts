/**
 * rawStockRecalcRoutesLegacy: RawStockAutoApplyFx endpoints.
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
import { pool } from "../../../../db";

import { ADMIN_ROLES } from "./_helpers";

export function registerRawStockAutoApplyFxRoutes(app: Express) {
  // ──────────────────────────────────────────────────────────────────────────
  // Auto-apply FX rates from factory_fx_rates for UNRESOLVED_FX containers
  // POST /api/factory/raw-stock/recalc/auto-apply-fx
  // Body: { containerIds: number[] }
  // ──────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/factory/raw-stock/recalc/auto-apply-fx",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { containerIds } = req.body as { containerIds: number[] };
      if (!Array.isArray(containerIds) || containerIds.length === 0)
        return res.status(400).json({ message: "containerIds must be a non-empty array" });

      try {
        const cRows = await pool.query<{
          id: number;
          container_number: string;
          currency_code: string;
          fx_rate_date_import: string | null;
          fx_rate_confirmed: boolean;
          freight_fx_rate_confirmed: boolean;
          commission_fx_rate_confirmed: boolean;
        }>(
          `SELECT id, container_number, currency_code,
                  fx_rate_date_import, fx_rate_confirmed,
                  freight_fx_rate_confirmed, commission_fx_rate_confirmed
           FROM factory_containers
           WHERE id = ANY($1) AND company_id = $2 AND deleted_at IS NULL`,
          [containerIds, companyId]
        );

        const results: { containerNumber: string; rate: number | null; applied: boolean; reason?: string }[] = [];

        for (const c of cRows.rows) {
          if (c.currency_code === "USD") {
            results.push({
              containerNumber: c.container_number,
              rate: null,
              applied: false,
              reason: "USD container — no FX needed",
            });
            continue;
          }

          // Best rate: most recent on/before import date, manual preferred over auto
          const refDate = c.fx_rate_date_import ?? new Date().toISOString().slice(0, 10);
          const rateRow = await pool.query<{ rate_to_usd: number; effective_date: string; source: string }>(
            `SELECT rate_to_usd, effective_date, source
             FROM factory_fx_rates
             WHERE company_id = $1 AND currency_code = $2 AND effective_date <= $3
             ORDER BY (source = 'manual') DESC, effective_date DESC
             LIMIT 1`,
            [companyId, c.currency_code, refDate]
          );

          if (rateRow.rows.length === 0) {
            results.push({
              containerNumber: c.container_number,
              rate: null,
              applied: false,
              reason: `No ${c.currency_code} rate on file on or before ${refDate}`,
            });
            continue;
          }

          const rate = Number(rateRow.rows[0].rate_to_usd);

          const updates: Record<string, unknown> = {
            fx_rate_to_usd: rate,
            fx_rate_confirmed: true,
          };
          if (!c.freight_fx_rate_confirmed) {
            updates.freight_fx_rate_to_usd = rate;
            updates.freight_fx_rate_confirmed = true;
          }
          if (!c.commission_fx_rate_confirmed) {
            updates.commission_fx_rate_to_usd = rate;
            updates.commission_fx_rate_confirmed = true;
          }

          const setClauses = Object.keys(updates)
            .map((k, i) => `${k} = ${i + 2}`)
            .join(", ");
          await pool.query(`UPDATE factory_containers SET ${setClauses} WHERE id = $1`, [
            c.id,
            ...Object.values(updates),
          ]);

          await logAudit({
            userId: requireSessionUserId(req),
            username: req.session.username || requireSessionUserId(req),
            companyId,
            action: "update",
            tableName: "factory_containers",
            recordId: c.id,
            recordIdentifier: `auto-apply-fx-rate — container ${c.container_number}`,
            changes: {
              rate: { new: rate },
              source: { new: rateRow.rows[0].source },
              effectiveDate: { new: rateRow.rows[0].effective_date },
            },
          });

          results.push({ containerNumber: c.container_number, rate, applied: true });
        }

        res.json({ results, applied: results.filter((r) => r.applied).length });
      } catch (err: unknown) {
        logger.error("[recalc auto-apply-fx] error:", { error: err });
        res.status(500).json({ message: getErrorMessage(err) || "Failed to auto-apply FX rates" });
      }
    }
  );
}
