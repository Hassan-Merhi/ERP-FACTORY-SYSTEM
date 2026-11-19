// Extracted from ./merge-logs.ts
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth, requireNonPOS } from "../../../auth";
import { logAudit } from "../../_helpers";
import { inventory, stockItems, stockItemCodeAliases, stockItemMergeLogs } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { inventoryCutoverRefusal } from "../../../services/accounting/perpetualInventory/cutoverRefusal";
import { restoreRepointedLinesTx } from "./repointDocumentLines";

export function registerStockMergeLogRoutesPart1(app: Express) {
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

        const { keptItemId, mergedItemId, mergedItemName, mergedItemCode, snapshotBefore, snapshotAfter } = log;

        // Wave 15: an unmerge rewrites both items' inventory rows from the
        // snapshot with no journal, so it is refused after the cut-over.
        const refusal = await inventoryCutoverRefusal(db, companyId, "stock-item-unmerge");
        if (refusal) return res.status(refusal.status).json(refusal.body);

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

          // Wave 15 (M9): the document lines the merge repointed go back to the merged item.
          await restoreRepointedLinesTx(
            tx,
            keptItemId,
            mergedItemId,
            (snapshotAfter as Record<string, unknown> | null)?.repointedLines
          );

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

          await logAudit(
            {
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
            },
            tx
          );
          // Step 4 — Delete the merge log so the same merge cannot be unmerged twice
          await tx.delete(stockItemMergeLogs).where(eq(stockItemMergeLogs.id, logId));
        });

        return res.json({ success: true, message: `"${mergedItemName}" has been restored as a separate item.` });
      } catch (error: unknown) {
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
