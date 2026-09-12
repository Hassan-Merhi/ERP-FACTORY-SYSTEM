/**
 * stockMergeRoutes: StockItemReconcile endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth, requireNonPOS } from "../../../auth";
import { stockItems, stockItemCodeAliases, stockItemMergeLogs, poLineItems } from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";

export function registerStockItemReconcileRoutes(app: Express) {
  // ── Reconcile OTW Names: POST /api/stock-items/reconcile-otw-names ──────────
  // Re-points any po_line_items that still reference a merged/deleted stock item
  // to the kept item, updating both stockItemId and itemName in one pass.
  app.post("/api/stock-items/reconcile-otw-names", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      let totalFixed = 0;

      // ── Pass 1: fix via merge logs (mergedItemId → keptItemId) ───────────
      const mergeLogs = await db.select().from(stockItemMergeLogs).where(eq(stockItemMergeLogs.companyId, companyId));

      const coveredByLog = new Set<number>(); // deleted item IDs already handled by a log

      for (const log of mergeLogs) {
        coveredByLog.add(log.mergedItemId);
        const [keptItem] = await db
          .select({ id: stockItems.id, name: stockItems.name })
          .from(stockItems)
          .where(eq(stockItems.id, log.keptItemId));
        if (!keptItem) continue;

        const updated = await db
          .update(poLineItems)
          .set({ stockItemId: keptItem.id, itemName: keptItem.name })
          .where(eq(poLineItems.stockItemId, log.mergedItemId))
          .returning({ id: poLineItems.id });

        totalFixed += updated.length;
      }

      // ── Pass 2: fix po_line_items that reference a deleted stock item with
      //            no merge log — resolve via stockItemCodeAliases fallback ──
      // Find distinct deleted stockItemIds referenced by po_line_items
      const deletedRefsRaw = await db.execute(
        sql`SELECT DISTINCT pli.stock_item_id AS "stockItemId", si.code AS "code"
            FROM po_line_items pli
            JOIN stock_items si ON si.id = pli.stock_item_id
            WHERE si.company_id = ${companyId}
              AND si.deleted_at IS NOT NULL`
      );
      const deletedRefs: { stockItemId: number; code: string }[] =
        (deletedRefsRaw as unknown as { rows: { stockItemId: number; code: string }[] }).rows ??
        ((deletedRefsRaw as unknown));

      // Only process those NOT already handled by a merge log
      const uncovered = deletedRefs.filter((r) => !coveredByLog.has(r.stockItemId));

      for (const ref of uncovered) {
        // Look up the kept item via stockItemCodeAliases:
        // when a merge happens, the old code is stored as an alias on the kept item
        const [alias] = await db
          .select({ stockItemId: stockItemCodeAliases.stockItemId })
          .from(stockItemCodeAliases)
          .where(and(eq(stockItemCodeAliases.companyId, companyId), eq(stockItemCodeAliases.aliasCode, ref.code)));

        if (!alias) continue;

        const [keptItem] = await db
          .select({ id: stockItems.id, name: stockItems.name })
          .from(stockItems)
          .where(and(eq(stockItems.id, alias.stockItemId), isNull(stockItems.deletedAt)));
        if (!keptItem) continue;

        const updated = await db
          .update(poLineItems)
          .set({ stockItemId: keptItem.id, itemName: keptItem.name })
          .where(eq(poLineItems.stockItemId, ref.stockItemId))
          .returning({ id: poLineItems.id });

        totalFixed += updated.length;
      }

      return res.json({ fixed: totalFixed, mergesChecked: mergeLogs.length, aliasesChecked: uncovered.length });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
