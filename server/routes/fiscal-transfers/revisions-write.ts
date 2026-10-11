/**
 * fiscalTransferRoutes: StockTransferRevisionWrite endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { logger } from "../../lib/logger";
import {
  stockTransferVouchers,
  stockTransferRevisions,
  stockTransferRevisionItems,
  vouchers,
  locations,
} from "@shared/schema";
import { eq, and, desc, asc } from "drizzle-orm";
import { sendRevisedTransferWhatsApp } from "../../helpers/sendRevisedTransferWhatsApp";
import { toMoney } from "../../lib/money";

export function registerStockTransferRevisionWriteRoutes(app: Express) {
  // Transfer Revisions - POST (create or update existing optional revision)
  app.post("/api/stock-transfers/:transferId/revisions", requireAuth, async (req, res) => {
    try {
      const transferId = parseInt(req.params.transferId);
      if (!transferId) return res.status(400).json({ message: "Transfer ID required" });

      const { note, items, optional: optionalFlag } = req.body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "At least one changed item is required" });
      }

      const isOptional = optionalFlag === true;

      // If this is an optional (POS) revision, check if the SAME USER already has one pending
      // and update it in-place rather than creating a new revision.
      // Each POS user gets their own optional revision so multiple locations can coexist.
      let revision = null;
      if (isOptional && req.user?.id) {
        const [existingOptional] = await db
          .select()
          .from(stockTransferRevisions)
          .where(
            and(
              eq(stockTransferRevisions.transferId, transferId),
              eq(stockTransferRevisions.optional, true),
              eq(stockTransferRevisions.createdBy, req.user.id)
            )
          )
          .orderBy(asc(stockTransferRevisions.revisionNumber))
          .limit(1);

        if (existingOptional) {
          // Merge: upsert each incoming item into the existing revision.
          // Items already in the revision but NOT in this payload are kept as-is
          // (they were prior adjustments the user hasn't touched this session).
          const existingRevItems = await db
            .select()
            .from(stockTransferRevisionItems)
            .where(eq(stockTransferRevisionItems.revisionId, existingOptional.id));

          const existingByKey = new Map(
            existingRevItems.map((i) => [`${i.stockItemId}:${i.sourceLocationId ?? ""}`, i])
          );

          for (const item of items) {
            const key = `${item.stockItemId}:${item.sourceLocationId ?? ""}`;
            const existing = existingByKey.get(key);
            if (existing) {
              await db
                .update(stockTransferRevisionItems)
                .set({
                  delta: String(item.delta),
                  newQuantity: String(item.newQuantity),
                  stockItemName: item.stockItemName,
                })
                .where(eq(stockTransferRevisionItems.id, existing.id));
            } else {
              await db.insert(stockTransferRevisionItems).values({
                revisionId: existingOptional.id,
                stockItemId: item.stockItemId,
                stockItemName: item.stockItemName,
                sourceLocationId: item.sourceLocationId ?? null,
                sourceLocationName: item.sourceLocationName ?? null,
                originalQuantity: String(item.originalQuantity),
                delta: String(item.delta),
                newQuantity: String(item.newQuantity),
              });
            }
          }

          await db
            .update(stockTransferRevisions)
            .set({ note: note?.trim() || existingOptional.note, revisionDate: new Date() })
            .where(eq(stockTransferRevisions.id, existingOptional.id));
          revision = { ...existingOptional, note: note?.trim() || existingOptional.note };
        }
      }

      if (!revision) {
        // Create new revision
        const [latest] = await db
          .select({ revisionNumber: stockTransferRevisions.revisionNumber })
          .from(stockTransferRevisions)
          .where(eq(stockTransferRevisions.transferId, transferId))
          .orderBy(desc(stockTransferRevisions.revisionNumber))
          .limit(1);

        const nextNum = latest ? latest.revisionNumber + 1 : 1;

        const [newRev] = await db
          .insert(stockTransferRevisions)
          .values({
            transferId,
            revisionNumber: nextNum,
            note: note?.trim() || null,
            optional: isOptional,
            createdBy: req.user?.id ?? null,
          })
          .returning();
        revision = newRev;
      }

      await db.insert(stockTransferRevisionItems).values(
        items.map((item) => ({
          revisionId: revision.id,
          stockItemId: item.stockItemId,
          stockItemName: item.stockItemName,
          sourceLocationId: item.sourceLocationId ?? null,
          sourceLocationName: item.sourceLocationName ?? null,
          originalQuantity: String(item.originalQuantity),
          delta: String(item.delta),
          newQuantity: String(item.newQuantity),
        }))
      );

      const savedItems = await db
        .select()
        .from(stockTransferRevisionItems)
        .where(eq(stockTransferRevisionItems.revisionId, revision.id));

      res.json({ ...revision, items: savedItems });

      // Fire-and-forget: send revised transfer image for POS-submitted (optional) revisions only
      if (isOptional)
        setImmediate(async () => {
          try {
            const [transfer] = await db
              .select({
                destinationLocationId: stockTransferVouchers.destinationLocationId,
                voucherId: stockTransferVouchers.voucherId,
              })
              .from(stockTransferVouchers)
              .where(eq(stockTransferVouchers.id, transferId));
            if (!transfer) return;

            const [destLoc] = await db
              .select({ name: locations.name })
              .from(locations)
              .where(eq(locations.id, transfer.destinationLocationId));

            const [voucherRow] = await db
              .select({ voucherNumber: vouchers.voucherNumber, voucherDate: vouchers.voucherDate })
              .from(vouchers)
              .where(eq(vouchers.id, transfer.voucherId));
            if (!voucherRow) return;

            const uniqueSrcNames = [...new Set(items.map((i) => i.sourceLocationName).filter(Boolean))];
            const sourceName = uniqueSrcNames.length === 1 ? uniqueSrcNames[0] : "Multiple Sources";

            // Use the first item's sourceLocationId to route to the source WA group
            const srcLocationId = items.find((i) => i.sourceLocationId)?.sourceLocationId ?? null;
            if (!srcLocationId) return;

            const waItems = items.map((i) => ({
              stockItemId: Number(i.stockItemId),
              stockItemName: i.stockItemName ?? null,
              originalQuantity: toMoney(i.originalQuantity).toNumber(),
              delta: toMoney(i.delta).toNumber(),
              newQuantity: toMoney(i.newQuantity).toNumber(),
            }));
            if (waItems.length === 0) return;

            await sendRevisedTransferWhatsApp({
              sourceLocationId: Number(srcLocationId),
              sourceLocationName: sourceName,
              destLocationName: destLoc?.name ?? "Unknown",
              items: waItems,
              voucherNumber: voucherRow.voucherNumber,
              voucherDate: voucherRow.voucherDate,
            });
          } catch (e: unknown) {
            logger.error("[RevisedTransferWA] Failed to send (revision):", { error: getErrorMessage(e) });
          }
        });
    } catch (error: unknown) {
      logger.error("[Revision POST] Error:", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // PATCH /api/stock-transfer-revisions/:id/optional and
  // DELETE /api/stock-transfer-revisions/:id used to live here, mutating and
  // deleting revision rows directly. The lifecycle is immutable now: both paths
  // are answered by the tombstones in
  // server/routes/vouchers/immutableStockTransferRevisionRoutes.ts, which
  // registerVoucherRoutes registers first and which reject every call with 409.
  // These copies could never run, and leaving a live delete of revision history
  // one registration-order change away from waking up is not worth the lines.
}
