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
import { inventoryCutoverRefusal } from "../../services/accounting/perpetualInventory/cutoverRefusal";
import { requireAuth, requireRole } from "../../auth";
import { sql } from "drizzle-orm";
import {
  pn,
  getCompanyRow,
  logRun,
  trackRow,
  requireCompletedMigrationAction,
  ensureTargetStockItems,
  ensureTargetLocation,
} from "./_helpers";

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

  // POST /api/sp/migration/gc-stock-opening
  // Requires: { sourceCompanyId, targetCompanyId, companyNameConfirm, confirmation: "MIGRATE" }
  app.post(
    "/api/sp/migration/gc-stock-opening",
    requireAuth,
    requireRole("Developer"),
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
      const depError = await requireCompletedMigrationAction(sourceId, targetId, "gc_stock_opening");
      if (depError) return res.status(409).json({ message: depError });
      // Wave 11: writing opening stock with no journal is refused once the
      // target company has its perpetual-inventory cut-over applied.
      const inventoryRefusal = await inventoryCutoverRefusal(db, targetId, "sp-migration-stock-opening");
      if (inventoryRefusal) return res.status(inventoryRefusal.status).json(inventoryRefusal.body);

      const runId = await logRun(
        sourceId,
        targetId,
        "gc_stock_opening",
        "running",
        0,
        null,
        `User: ${req.session?.userId ?? "unknown"} | Source: ${sourceComp.name} | Target: ${targetComp.name}`
      );

      let rowsCreated = 0;
      const summary: string[] = [];
      try {
        const { map: stockItemMap } = await ensureTargetStockItems(sourceId, targetId, runId);

        const sourceLocs = (
          await db.execute<{ id: number; code: string; name: string }>(sql`
          SELECT id, code, name FROM locations WHERE company_id = ${sourceId} AND deleted_at IS NULL
        `)
        ).rows;
        const locMap = new Map<number, number>();
        for (const l of sourceLocs) await ensureTargetLocation(l, targetId, runId, locMap);

        // Per-location inventory in source (location_id may be null for legacy rows — group those into an "Unassigned" bucket)
        const invRows = (
          await db.execute(sql`
          SELECT inv.stock_item_id, inv.location_id, si.code, si.name AS item_name, inv.quantity, inv.average_rate
          FROM inventory inv
          JOIN stock_items si ON si.id = inv.stock_item_id
          WHERE inv.company_id = ${sourceId} AND inv.quantity > 0
        `)
        ).rows;

        let movementsCreated = 0,
          skipped = 0,
          mismatchedItems = 0;
        const perLocationRecon: Array<{ location: string; sourceQty: number; targetQty: number }> = [];

        for (const row of invRows) {
          const srcStockItemId = pn(row.stock_item_id);
          const targetStockItemId = stockItemMap.get(srcStockItemId);
          if (!targetStockItemId) {
            mismatchedItems++;
            continue;
          }
          const qty = pn(row.quantity);
          const avgRate = pn(row.average_rate);

          let targetLocId: number;
          if (row.location_id && locMap.has(pn(row.location_id))) {
            targetLocId = locMap.get(pn(row.location_id))!;
          } else {
            // Fall back to (create-once) "Unassigned" location for rows with no source location
            const unassigned = (
              await db.execute(sql`
              SELECT id FROM locations WHERE company_id = ${targetId} AND code = 'UNASSIGNED' AND deleted_at IS NULL LIMIT 1
            `)
            ).rows[0];
            if (unassigned) {
              targetLocId = pn(unassigned.id);
            } else {
              const [locRow] = (
                await db.execute(sql`
                INSERT INTO locations (company_id, code, name, active)
                VALUES (${targetId}, 'UNASSIGNED', 'Unassigned (migrated)', true)
                RETURNING id
              `)
              ).rows;
              targetLocId = pn(locRow.id);
              await trackRow(runId, "locations", targetLocId);
            }
          }

          // Idempotency: skip only if a movement from THIS specific GC migration source type already
          // exists for this exact (item, location) pair in the target — checking a narrow source_type
          // (instead of the generic 'opening_stock') avoids false-blocking on manually entered opening
          // stock and false-matching on unrelated migrations.
          const already = (
            await db.execute(sql`
            SELECT id FROM sp_stock_movements
            WHERE company_id = ${targetId} AND stock_item_id = ${targetStockItemId} AND location_id = ${targetLocId}
              AND source_type = 'migration_opening_stock' LIMIT 1
          `)
          ).rows[0];
          if (already) {
            skipped++;
            continue;
          }

          // Guard: if the target already has non-migration stock for this exact item/location
          // (e.g. manually entered), block this row instead of silently stacking quantities.
          const existingInv = (
            await db.execute(sql`
            SELECT id, quantity FROM inventory
            WHERE company_id = ${targetId} AND stock_item_id = ${targetStockItemId} AND location_id = ${targetLocId}
            LIMIT 1
          `)
          ).rows[0];
          if (existingInv && pn(existingInv.quantity) > 0) {
            mismatchedItems++;
            summary.push(
              `Blocked ${row.code} @ target location — target already has stock (qty ${pn(existingInv.quantity)}) for this item/location. Resolve or rollback before migration.`
            );
            continue;
          }

          const [movRow] = (
            await db.execute(sql`
            INSERT INTO sp_stock_movements
              (company_id, article_code, description, stock_item_id, location_id,
               qty_in, qty_remaining, base_unit_cost_usd, landed_unit_cost_usd, final_unit_cost_usd, source_type)
            VALUES
              (${targetId}, ${row.code}, ${"GC Migration opening stock (per-location) from " + sourceComp.name},
               ${targetStockItemId}, ${targetLocId}, ${qty}, ${qty},
               ${avgRate.toFixed(6)}, ${avgRate.toFixed(6)}, ${avgRate.toFixed(6)}, 'migration_opening_stock')
            RETURNING id
          `)
          ).rows;
          await trackRow(runId, "sp_stock_movements", pn(movRow.id));
          movementsCreated++;
          rowsCreated++;

          const totalVal = (qty * avgRate).toFixed(2);
          const [invRow] = (
            await db.execute(sql`
            INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
            VALUES (${targetId}, ${targetLocId}, ${targetStockItemId}, ${qty.toFixed(3)}, ${avgRate.toFixed(2)}, ${totalVal})
            ON CONFLICT (location_id, stock_item_id) DO NOTHING
            RETURNING id
          `)
          ).rows;
          if (invRow) {
            await trackRow(runId, "inventory", pn(invRow.id));
            rowsCreated++;
          }
        }

        // Reconciliation: compare per-location totals source vs target
        for (const [srcLocId, tgtLocId] of Array.from(locMap.entries())) {
          const srcTotal = (
            await db.execute(sql`
            SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory WHERE company_id = ${sourceId} AND location_id = ${srcLocId}
          `)
          ).rows[0];
          const tgtTotal = (
            await db.execute(sql`
            SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory WHERE company_id = ${targetId} AND location_id = ${tgtLocId}
          `)
          ).rows[0];
          const locNameRow = sourceLocs.find((l) => pn(l.id) === srcLocId);
          perLocationRecon.push({
            location: locNameRow?.name ?? `location #${srcLocId}`,
            sourceQty: Math.round(pn(srcTotal.q) * 1000) / 1000,
            targetQty: Math.round(pn(tgtTotal.q) * 1000) / 1000,
          });
        }

        summary.push(`Opening stock movements created: ${movementsCreated}, skipped (already existed): ${skipped}`);
        if (mismatchedItems) summary.push(`${mismatchedItems} row(s) had no target stock item mapping — skipped`);

        await db.execute(sql`
          UPDATE sp_migration_rehearsal_runs
          SET status = 'completed', rows_created = ${rowsCreated}, completed_at = now()
          WHERE id = ${runId}
        `);

        return res.json({
          success: true,
          runId,
          rowsCreated,
          summary,
          perLocationRecon,
          warnings: mismatchedItems
            ? ["Some inventory rows referenced stock items not migrated by the stock-master step — run it first."]
            : [],
        });
      } catch (err: unknown) {
        await db
          .execute(
            sql`UPDATE sp_migration_rehearsal_runs SET status = 'failed', error_message = ${getErrorMessage(err)}, completed_at = now() WHERE id = ${runId}`
          )
          .catch(() => {});
        logger.error("[SP Migration] gc-stock-opening error:", {
          sourceCompanyId: sourceId,
          targetCompanyId: targetId,
          runId,
          error: getErrorMessage(err),
        });
        return res.status(500).json({
          message: `Stock opening migration failed: ${getErrorMessage(err) || "Unknown error"}`,
          runId,
        });
      }
    }
  );
}
