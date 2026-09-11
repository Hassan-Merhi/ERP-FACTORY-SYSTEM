/**
 * stockMergeRoutes: StockMergeLog endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth, requireNonPOS } from "../../../auth";
import { logAudit } from "../../_helpers";
import { inventory, stockItems, stockItemCodeAliases, stockItemMergeLogs } from "@shared/schema";
import { eq, and, desc, inArray, sql } from "drizzle-orm";

export function registerStockMergeLogRoutes(app: Express) {
  // ── Merge Logs: GET /api/stock-items/merge-logs ──────────────────────────
  app.get("/api/stock-items/merge-logs", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const logs = await db
        .select()
        .from(stockItemMergeLogs)
        .where(eq(stockItemMergeLogs.companyId, companyId))
        .orderBy(desc(stockItemMergeLogs.mergedAt))
        .limit(50);
      return res.json(logs);
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Historical merge reconstruction: GET /api/stock-items/merge-logs/historical ──
  // Rebuilds pre-feature merge history from the alias breadcrumbs that the merge
  // logic always writes: aliasCode = merged item's code, description = "Merged from: …".
  // Excludes any merges already present in stock_item_merge_logs (already covered).
  app.get("/api/stock-items/merge-logs/historical", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rows = await db.execute(sql`
        SELECT
          a.stock_item_id        AS "keptItemId",
          si_kept.code           AS "keptItemCode",
          si_kept.name           AS "keptItemName",
          si_merged.id           AS "mergedItemId",
          si_merged.code         AS "mergedItemCode",
          REPLACE(si_merged.name, '[MERGED] ', '') AS "mergedItemName",
          COALESCE(si_merged.deleted_at, a.created_at) AS "mergedAt",
          a.description          AS "notes"
        FROM stock_item_code_aliases a
        JOIN stock_items si_kept
          ON si_kept.id = a.stock_item_id
         AND si_kept.company_id = a.company_id
        JOIN stock_items si_merged
          ON si_merged.code = a.alias_code
         AND si_merged.company_id = a.company_id
         AND si_merged.active = false
        WHERE a.company_id = ${companyId}
          AND a.description LIKE 'Merged from:%'
          AND si_merged.id NOT IN (
            SELECT merged_item_id FROM stock_item_merge_logs WHERE company_id = ${companyId}
          )
        ORDER BY COALESCE(si_merged.deleted_at, a.created_at) DESC
        LIMIT 200
      `);

      const data = (rows.rows ?? rows).map((r) => ({
        ...r,
        id: null,
        source: "historical",
      }));

      return res.json(data);
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Historical restore: POST /api/stock-items/merge-logs/historical-restore ──
  // Restores a historically merged item without a snapshot:
  //   1. Sets item active=true, clears deletedAt, strips "[MERGED] " from name
  //   2. Deletes the alias that was routing the old code → kept item
  // Inventory is NOT touched — user must manually redistribute quantities.
  app.post(
    "/api/stock-items/merge-logs/historical-restore",
    requireAuth,
    requireNonPOS,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { mergedItemId, keptItemId } = req.body;
        if (!mergedItemId || !keptItemId) {
          return res.status(400).json({ message: "mergedItemId and keptItemId are required" });
        }

        // Load the soft-deleted merged item
        const [mergedItem] = await db
          .select()
          .from(stockItems)
          .where(
            and(eq(stockItems.id, mergedItemId), eq(stockItems.companyId, companyId), eq(stockItems.active, false))
          )
          .limit(1);

        if (!mergedItem) {
          return res.status(404).json({ message: "Merged item not found or already active" });
        }

        // Strip the [MERGED] prefix from the name
        const restoredName = mergedItem.name.replace(/^\[MERGED\]\s*/i, "");

        // Step 1 — Restore the merged item
        await db
          .update(stockItems)
          .set({ active: true, deletedAt: null, name: restoredName })
          .where(and(eq(stockItems.id, mergedItemId), eq(stockItems.companyId, companyId)));

        // Step 2 — Remove the alias that routed the old code → kept item
        await db
          .delete(stockItemCodeAliases)
          .where(
            and(
              eq(stockItemCodeAliases.companyId, companyId),
              eq(stockItemCodeAliases.stockItemId, keptItemId),
              eq(stockItemCodeAliases.aliasCode, mergedItem.code)
            )
          );

        return res.json({
          success: true,
          restoredName,
          message: `"${restoredName}" has been restored as a separate active item. Its code alias has been removed. Please manually adjust inventory quantities between this item and the kept item.`,
        });
      } catch (error: unknown) {
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── Unmerge: POST /api/stock-items/merge-logs/:logId/unmerge ─────────────
  // Reverses a previous merge using the saved snapshotBefore.
  // Restores: item active status, inventory quantities/values, and the main code alias.
  // NOTE: Location prices deleted during merge and transferred aliases cannot be recovered.
  app.post(
    "/api/stock-items/merge-logs/:logId/unmerge",
    requireAuth,
    requireNonPOS,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const userId = String(req.user?.id ?? req.session.userId ?? "");

        const logId = parseInt(req.params.logId);
        if (isNaN(logId)) return res.status(400).json({ message: "Invalid log ID" });

        const [log] = await db
          .select()
          .from(stockItemMergeLogs)
          .where(and(eq(stockItemMergeLogs.id, logId), eq(stockItemMergeLogs.companyId, companyId)));
        if (!log) return res.status(404).json({ message: "Merge log not found" });

        const { keptItemId, mergedItemId, mergedItemName, mergedItemCode, snapshotBefore } = log;

        // Verify the merged item still exists and is soft-deleted (i.e. still unmerge-able)
        const [mergedItem] = await db
          .select()
          .from(stockItems)
          .where(and(eq(stockItems.id, mergedItemId), eq(stockItems.companyId, companyId)));
        if (!mergedItem) return res.status(404).json({ message: "Merged item record not found" });
        if (!mergedItem.deletedAt)
          return res.status(400).json({ message: "This item does not appear to be merged — it is currently active" });

        await db.transaction(async (tx) => {
          // Step 1 — Restore the merged item (undo soft-delete)
          await tx
            .update(stockItems)
            .set({ active: true, deletedAt: null, name: mergedItemName })
            .where(eq(stockItems.id, mergedItemId));

          // Step 2 — Restore inventory from snapshotBefore
          // The snapshot has entries keyed as `${stockItemId}_${locationId}`
          type SnapEntry = {
            stockItemId: number;
            locationId: number;
            quantity: string;
            averageRate: string;
            totalValue: string;
          };
          const snapEntries: SnapEntry[] = Object.values(snapshotBefore as Record<string, unknown>).map((v) => {
            const row = v as SnapEntry;
            return {
              stockItemId: Number(row.stockItemId),
              locationId: Number(row.locationId),
              quantity: String(row.quantity),
              averageRate: String(row.averageRate),
              totalValue: String(row.totalValue),
            };
          });

          // Collect the locations touched by either item in the snapshot
          const keptLocations = snapEntries.filter((e) => e.stockItemId === keptItemId).map((e) => e.locationId);
          const dupLocations = snapEntries.filter((e) => e.stockItemId === mergedItemId).map((e) => e.locationId);
          const allLocations = [...new Set([...keptLocations, ...dupLocations])];

          // Delete current inventory rows for both items at those locations (we'll re-insert from snapshot)
          if (allLocations.length > 0) {
            await tx
              .delete(inventory)
              .where(
                and(
                  eq(inventory.companyId, companyId),
                  inArray(inventory.locationId, allLocations),
                  inArray(inventory.stockItemId, [keptItemId, mergedItemId])
                )
              );
          }

          // Re-insert each snapshot row
          for (const entry of snapEntries) {
            // Check if a row already exists (e.g. at a location not in our delete list)
            const [existing] = await tx
              .select()
              .from(inventory)
              .where(
                and(
                  eq(inventory.stockItemId, entry.stockItemId),
                  eq(inventory.locationId, entry.locationId),
                  eq(inventory.companyId, companyId)
                )
              );
            if (existing) {
              await tx
                .update(inventory)
                .set({
                  quantity: entry.quantity,
                  averageRate: entry.averageRate,
                  totalValue: entry.totalValue,
                  lastUpdated: new Date(),
                })
                .where(
                  and(
                    eq(inventory.stockItemId, entry.stockItemId),
                    eq(inventory.locationId, entry.locationId),
                    eq(inventory.companyId, companyId)
                  )
                );
            } else {
              await tx.insert(inventory).values({
                companyId,
                stockItemId: entry.stockItemId,
                locationId: entry.locationId,
                quantity: entry.quantity,
                averageRate: entry.averageRate,
                totalValue: entry.totalValue,
                lastUpdated: new Date(),
              });
            }
          }

          // Step 3 — Delete the code alias created during merge (mergedItemCode → keptItemId)
          await tx
            .delete(stockItemCodeAliases)
            .where(
              and(
                eq(stockItemCodeAliases.stockItemId, keptItemId),
                eq(stockItemCodeAliases.aliasCode, mergedItemCode),
                eq(stockItemCodeAliases.companyId, companyId)
              )
            );

          // Step 4 — Delete the merge log so the same merge cannot be unmerged twice
          await tx.delete(stockItemMergeLogs).where(eq(stockItemMergeLogs.id, logId));
        });

        await logAudit({
          userId,
          username: req.session?.username || req.user?.username || "unknown",
          companyId,
          action: "update",
          tableName: "stock_items",
          recordId: mergedItemId,
          recordIdentifier: mergedItemName,
          changes: {
            unmerge: {
              old: null,
              new: { logId, keptItemId, mergedItemId, mergedItemName },
            },
          },
        });

        return res.json({ success: true, message: `"${mergedItemName}" has been restored as a separate item.` });
      } catch (error: unknown) {
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Bank Accounts
}
