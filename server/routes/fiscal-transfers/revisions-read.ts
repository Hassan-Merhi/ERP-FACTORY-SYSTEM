/**
 * fiscalTransferRoutes: StockTransferRevisionRead endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { stockTransferVouchers, stockTransferRevisions, stockTransferRevisionItems, vouchers } from "@shared/schema";
import { eq, asc } from "drizzle-orm";

export function registerStockTransferRevisionReadRoutes(app: Express) {
  // Stock Transfers - PATCH endpoint (notes-only update)
  app.patch("/api/stock-transfers/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ message: "Transfer ID is required" });
      const { notes } = req.body;
      const [updatedTransfer] = await db
        .update(stockTransferVouchers)
        .set({ notes: notes ?? null })
        .where(eq(stockTransferVouchers.id, id))
        .returning({ voucherId: stockTransferVouchers.voucherId });
      if (!updatedTransfer) return res.status(404).json({ message: "Transfer not found" });

      await db
        .update(vouchers)
        .set({ description: notes ?? null })
        .where(eq(vouchers.id, updatedTransfer.voucherId));

      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Transfer Revisions - GET by voucherId (must be before :transferId route)
  app.get("/api/stock-transfers/by-voucher/:voucherId/revisions", requireAuth, async (req, res) => {
    try {
      const voucherId = parseInt(req.params.voucherId);
      if (!voucherId) return res.status(400).json({ message: "Voucher ID required" });
      const transfer = await storage.getStockTransferByVoucherId(voucherId);
      if (!transfer) return res.json([]);
      req.params.transferId = String(transfer.id);
      // Fall through to transferId revisions logic by re-routing internally
      const transferId = transfer.id;

      const revisionRows = await db
        .select()
        .from(stockTransferRevisions)
        .where(eq(stockTransferRevisions.transferId, transferId))
        .orderBy(asc(stockTransferRevisions.revisionNumber));

      const allRevWithItems = await Promise.all(
        revisionRows.map(async (rev) => {
          const items = await db
            .select()
            .from(stockTransferRevisionItems)
            .where(eq(stockTransferRevisionItems.revisionId, rev.id));
          return { ...rev, items };
        })
      );

      const optionalRevs = allRevWithItems.filter((r) => r.optional);
      const nonOptionalRevs = allRevWithItems.filter((r) => !r.optional);
      type RevisionResponseItem = Omit<(typeof allRevWithItems)[number]["items"][number], "id" | "revisionId"> & {
        id?: number;
        revisionId?: number;
      };
      type RevisionResponse = Omit<(typeof allRevWithItems)[number], "items"> & {
        items: RevisionResponseItem[];
        _mergedCount?: number;
      };
      let finalRevisions: RevisionResponse[] = [...nonOptionalRevs];

      if (optionalRevs.length > 0) {
        const netMap = new Map<
          string,
          {
            stockItemId: number;
            stockItemName: string;
            sourceLocationId: number | null;
            sourceLocationName: string | null;
            originalQuantity: string;
            newQuantity: string;
            delta: string;
          }
        >();

        for (const rev of optionalRevs) {
          for (const item of rev.items) {
            const key = `${item.stockItemId}:${item.sourceLocationId ?? ""}`;
            const existing = netMap.get(key);
            if (!existing) {
              netMap.set(key, {
                stockItemId: item.stockItemId,
                stockItemName: item.stockItemName,
                sourceLocationId: item.sourceLocationId,
                sourceLocationName: item.sourceLocationName,
                originalQuantity: item.originalQuantity,
                newQuantity: item.newQuantity,
                delta: item.delta,
              });
            } else {
              const netDelta = parseFloat(item.newQuantity) - parseFloat(existing.originalQuantity);
              netMap.set(key, {
                ...existing,
                newQuantity: item.newQuantity,
                delta: String(netDelta),
              });
            }
          }
        }

        const first = optionalRevs[0];
        const last = optionalRevs[optionalRevs.length - 1];
        const mergedOptional = {
          ...first,
          note: last.note,
          revisionDate: last.revisionDate,
          _mergedCount: optionalRevs.length,
          items: Array.from(netMap.values()),
        };
        finalRevisions = [mergedOptional, ...nonOptionalRevs];
      }

      res.json(finalRevisions);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Transfer Revisions - GET
  app.get("/api/stock-transfers/:transferId/revisions", requireAuth, async (req, res) => {
    try {
      const transferId = parseInt(req.params.transferId);
      if (!transferId) return res.status(400).json({ message: "Transfer ID required" });

      const revisionRows = await db
        .select()
        .from(stockTransferRevisions)
        .where(eq(stockTransferRevisions.transferId, transferId))
        .orderBy(asc(stockTransferRevisions.revisionNumber));

      // Fetch all items for all revisions
      const allRevWithItems = await Promise.all(
        revisionRows.map(async (rev) => {
          const items = await db
            .select()
            .from(stockTransferRevisionItems)
            .where(eq(stockTransferRevisionItems.revisionId, rev.id));
          return { ...rev, items };
        })
      );

      // Split optional (POS) and non-optional (admin) revisions
      const optionalRevs = allRevWithItems.filter((r) => r.optional);
      const nonOptionalRevs = allRevWithItems.filter((r) => !r.optional);

      type RevisionResponseItem = Omit<(typeof allRevWithItems)[number]["items"][number], "id" | "revisionId"> & {
        id?: number;
        revisionId?: number;
      };
      type RevisionResponse = Omit<(typeof allRevWithItems)[number], "items"> & {
        items: RevisionResponseItem[];
        _mergedCount?: number;
      };
      let finalRevisions: RevisionResponse[] = [...nonOptionalRevs];

      if (optionalRevs.length > 0) {
        // Merge all optional revisions into one, computing net delta per item
        // Key: `${stockItemId}:${sourceLocationId}`
        const netMap = new Map<
          string,
          {
            stockItemId: number;
            stockItemName: string;
            sourceLocationId: number | null;
            sourceLocationName: string | null;
            originalQuantity: string;
            newQuantity: string;
            delta: string;
          }
        >();

        for (const rev of optionalRevs) {
          for (const item of rev.items) {
            const key = `${item.stockItemId}:${item.sourceLocationId ?? ""}`;
            const existing = netMap.get(key);
            if (!existing) {
              // First time we see this item — take its originalQuantity as the baseline
              netMap.set(key, {
                stockItemId: item.stockItemId,
                stockItemName: item.stockItemName,
                sourceLocationId: item.sourceLocationId,
                sourceLocationName: item.sourceLocationName,
                originalQuantity: item.originalQuantity,
                newQuantity: item.newQuantity,
                delta: item.delta,
              });
            } else {
              // Update with latest newQuantity and recompute net delta
              const origQty = parseFloat(existing.originalQuantity);
              const newQty = parseFloat(item.newQuantity);
              const netDelta = newQty - origQty;
              netMap.set(key, {
                ...existing,
                newQuantity: String(newQty),
                delta: netDelta >= 0 ? `+${netDelta}` : String(netDelta),
              });
            }
          }
        }

        // Use the earliest optional revision as the "shell" for metadata
        const earliest = optionalRevs[0];
        const latest = optionalRevs[optionalRevs.length - 1];
        const mergedRevision = {
          ...earliest,
          revisionNumber: earliest.revisionNumber,
          revisionDate: latest.revisionDate,
          note: latest.note ?? earliest.note,
          items: Array.from(netMap.values()),
          // synthetic flag: how many optional revs were merged
          _mergedCount: optionalRevs.length,
        };

        finalRevisions = [mergedRevision, ...nonOptionalRevs].sort((a, b) => a.revisionNumber - b.revisionNumber);
      }

      res.json(finalRevisions);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
