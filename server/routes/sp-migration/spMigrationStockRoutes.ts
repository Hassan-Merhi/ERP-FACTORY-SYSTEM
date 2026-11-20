/**
 * SP migration routes - Stock master data copy and the location-aware stock opening step.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { logger } from "../../lib/logger";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getCompanyRow, logRun, ensureTargetStockItems } from "./_helpers";
import { registerSpMigrationStockRoutesPart1 } from "./registerSpMigrationStockRoutesPart1";
import { validateRequest, type RequestSchemas } from "../../lib/validateRequest";

// Requires { sourceCompanyId, targetCompanyId, companyNameConfirm, confirmation: "MIGRATE" };
// the handler keeps its own checks and messages for each, so they are optional here.
const gcStockMasterInput = {
  body: z.strictObject({
    sourceCompanyId: z.union([z.number(), z.string()]).nullable().optional(),
    targetCompanyId: z.union([z.number(), z.string()]).nullable().optional(),
    companyNameConfirm: z.string().optional(),
    confirmation: z.string().optional(),
  }),
} satisfies RequestSchemas;

export function registerSpMigrationStockRoutes(app: Express) {
  // POST /api/sp/migration/gc-stock-master
  // Explicit, standalone staged step: creates/reuses target stock groups, grades,
  // categories and stock items (with opening qty/rate/value, reorder level, selling
  // price and active flag copied over) WITHOUT posting any opening-stock movements or
  // touching inventory. This lets the master data be reviewed/corrected before the
  // location-aware stock-opening step runs.
  // Requires: { sourceCompanyId, targetCompanyId, companyNameConfirm, confirmation: "MIGRATE" }
  app.post(
    "/api/sp/migration/gc-stock-master",
    requireAuth,
    requireRole("Developer"),
    validateRequest(gcStockMasterInput),
    async (req: Request, res: Response) => {
      const { sourceCompanyId, targetCompanyId, companyNameConfirm, confirmation } = req.body ?? {};
      if (confirmation !== "MIGRATE") {
        return res.status(400).json({ message: 'Requires confirmation = "MIGRATE"' });
      }
      const sourceId = parseInt(String(sourceCompanyId ?? ""), 10);
      const targetId = parseInt(String(targetCompanyId ?? ""), 10);
      if (!sourceId || !targetId)
        return res.status(400).json({ message: "sourceCompanyId and targetCompanyId required" });

      const sourceComp = await getCompanyRow(sourceId);
      const targetComp = await getCompanyRow(targetId);
      if (!sourceComp) return res.status(404).json({ message: "Source company not found" });
      if (!targetComp) return res.status(404).json({ message: "Target company not found" });
      if (sourceComp.company_type !== "erp")
        return res.status(400).json({ message: "Source company must be type 'erp'" });
      if (targetComp.company_type !== "supplier_partner")
        return res.status(400).json({ message: "Target company must be type 'supplier_partner'" });
      if (!companyNameConfirm || companyNameConfirm.trim() !== sourceComp.name) {
        return res.status(400).json({ message: `Company name confirmation must match exactly: "${sourceComp.name}"` });
      }

      const runId = await logRun(
        sourceId,
        targetId,
        "gc_stock_master",
        "running",
        0,
        null,
        `User: ${req.session?.userId ?? "unknown"} | Source: ${sourceComp.name} | Target: ${targetComp.name}`
      );

      try {
        const { map, groupsCreated, gradesCreated, categoriesCreated, itemsCreated, itemsReused } =
          await ensureTargetStockItems(sourceId, targetId, runId);
        const rowsCreated = groupsCreated + gradesCreated + categoriesCreated + itemsCreated;

        await db.execute(sql`
          UPDATE sp_migration_rehearsal_runs SET status = 'completed', rows_created = ${rowsCreated}, completed_at = now() WHERE id = ${runId}
        `);

        return res.json({
          success: true,
          runId,
          rowsCreated,
          summary: [
            `Stock groups: ${groupsCreated} created`,
            `Stock grades: ${gradesCreated} created`,
            `Stock categories: ${categoriesCreated} created`,
            `Stock items: ${itemsCreated} created, ${itemsReused} reused (already existed/linked)`,
            `Total stock items now mapped: ${map.size}`,
          ],
          warnings: [
            "This step only creates master data (groups, grades, categories, items with opening/reorder/selling-price fields) — no opening-stock movements or inventory rows were touched.",
            "Per-location selling prices (stock_item_location_prices) are not migrated here — set them manually per target location if needed.",
          ],
        });
      } catch (err: unknown) {
        await db
          .execute(
            sql`UPDATE sp_migration_rehearsal_runs SET status = 'failed', error_message = ${getErrorMessage(err)}, completed_at = now() WHERE id = ${runId}`
          )
          .catch(() => {});
        logger.error("[SP Migration] gc-stock-master error:", { error: err });
        return res.status(500).json({ message: "Stock master migration failed", runId });
      }
    }
  );

  registerSpMigrationStockRoutesPart1(app);
}
