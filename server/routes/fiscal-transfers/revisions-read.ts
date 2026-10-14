/**
 * fiscalTransferRoutes: stock-transfer notes update.
 *
 * The revision readers that used to live here were shadowed by
 * vouchers/immutableStockTransferRevisionRoutes.ts (registered earlier by
 * voucherRoutes.ts and terminal on every path) and were removed in the
 * dead-code cleanup (Phase 3).
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { stockTransferVouchers, vouchers } from "@shared/schema";
import { eq } from "drizzle-orm";

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
}
