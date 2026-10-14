/**
 * SP migration routes - Migration preview, run history, rehearsal and rollback.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import {
  privilegedConcurrencyLimit,
  privilegedMutationRateLimit,
  privilegedReadRateLimit,
} from "../../middleware/privilegedEndpointSecurity";
import { sql } from "drizzle-orm";
import { buildGcMigrationPreview } from "./_helpers";

const spMigrationReadConcurrency = privilegedConcurrencyLimit({
  scope: "sp-migration-read",
  maxConcurrent: 2,
});

export function registerSpMigrationRunRoutes(app: Express) {
  // ── GET /api/sp/migration/preview ────────────────────────────────────────
  // Legacy alias — kept only for backward compatibility. Returns the exact same
  // shape as /gc-preview (see buildGcMigrationPreview) so no two preview
  // endpoints ever disagree on field names again.
  app.get(
    "/api/sp/migration/preview",
    requireAuth,
    requireRole("Developer"),
    privilegedReadRateLimit,
    spMigrationReadConcurrency,
    async (req: Request, res: Response) => {
      try {
        const sourceId = parseInt(String(req.query.sourceCompanyId ?? ""), 10);
        const targetId = parseInt(String(req.query.targetCompanyId ?? ""), 10);
        if (!sourceId || !targetId) {
          return res.status(400).json({ message: "sourceCompanyId and targetCompanyId are required" });
        }
        if (sourceId === targetId) {
          return res.status(400).json({ message: "Source and target companies must be different" });
        }
        const { status, body } = await buildGcMigrationPreview(sourceId, targetId);
        return res.status(status).json(body);
      } catch (err: unknown) {
        logger.error("[SP Migration] preview error:", { error: err });
        return res.status(500).json({ message: "Internal server error" });
      }
    }
  );

  // ── GET /api/sp/migration/runs ──────────────────────────────────────────
  app.get(
    "/api/sp/migration/runs",
    requireAuth,
    requireRole("Developer"),
    privilegedReadRateLimit,
    async (_req: unknown, res: import("express").Response) => {
      try {
        const runs = (
          await db.execute(sql`
        SELECT
          r.id, r.source_company_id, r.target_company_id,
          r.action, r.status, r.rows_created,
          r.created_at, r.completed_at, r.error_message, r.notes,
          sc.name AS source_name, tc.name AS target_name
        FROM sp_migration_rehearsal_runs r
        JOIN companies sc ON sc.id = r.source_company_id
        JOIN companies tc ON tc.id = r.target_company_id
        ORDER BY r.created_at DESC
        LIMIT 50
      `)
        ).rows;
        return res.json({ runs });
      } catch {
        return res.status(500).json({ message: "Internal server error" });
      }
    }
  );

  // ── POST /api/sp/migration/rehearsal ────────────────────────────────────
  // DISABLED: the old all-in-one rehearsal flow (default-warehouse + raw stock_item_id reuse +
  // source_type='opening_stock' + "recreate containers manually") is permanently retired.
  // Use the staged endpoints instead: gc-account-plan, gc-stock-master, gc-stock-opening,
  // gc-sales-readonly, gc-containers, gc-profit-opening, gc-reconciliation.
  app.post(
    "/api/sp/migration/rehearsal",
    requireAuth,
    requireRole("Developer"),
    privilegedMutationRateLimit,
    async (_req: unknown, res: import("express").Response) => {
      return res.status(410).json({
        message: "The old all-in-one GC migration flow is disabled. Use the staged migration steps instead.",
        code: "OLD_GC_REHEARSAL_DISABLED",
      });
    }
  );

  // Rehearsal rollback is owned by the Phase 2 migration router registered earlier.
}
