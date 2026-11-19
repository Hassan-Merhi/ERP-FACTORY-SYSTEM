/**
 * voucherTransferRoutes: VoucherTransferOnly endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 *
 * PATCH /api/vouchers/:id/transfer is served first by
 * ../exactStockTransferEditRoute (posted transfers) and then by
 * ../stockTransferLifecycleRoutes (every other "Stock Transfer",
 * "StockTransfer" or "Transfer" voucher). Both only fall through for a voucher
 * that is not found or is not a stock transfer, so this last handler answers
 * just those requests; the old single-source edit logic it once held could
 * never run and was removed.
 */
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../../lib/httpHandlers";
import { storage } from "../../../storage";
import { requireAuth, requireNonPOS } from "../../../auth";

export function registerVoucherTransferOnlyRoutes(app: Express) {
  app.patch("/api/vouchers/:id/transfer", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid voucher ID" });
      }

      const { sourceLocationId, destinationLocationId, items } = req.body;

      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "At least one item is required" });
      }

      if (!sourceLocationId || !destinationLocationId) {
        return res.status(400).json({ message: "Source and destination locations are required" });
      }

      const existingVoucher = await storage.getVoucherById(id);
      if (!existingVoucher) {
        return res.status(404).json({ message: "Voucher not found" });
      }

      if (existingVoucher.voucherType !== "Stock Transfer") {
        return res.status(400).json({
          message: "This endpoint only updates Stock Transfer vouchers",
        });
      }

      // Unreachable while the stock-transfer routes above are registered first.
      return res.status(409).json({
        message: "Stock Transfer vouchers are edited through the stock transfer lifecycle",
      });
    } catch (error: unknown) {
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
