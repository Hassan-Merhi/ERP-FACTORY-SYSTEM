/**
 * Compatibility route for the historical sales-voucher edit method.
 *
 * PUT is the canonical sale-edit endpoint. PATCH remains available while
 * older clients migrate, but both methods use the same validated handler.
 */
import type { Express } from "express";
import { requireAuth } from "../../../auth";
import { requirePosSaleEditWindow } from "../../../middleware/posSaleEditWindow";
import { validateRequest } from "../../../lib/validateRequest";
import { handlePosSaleEdit, posSaleEditInput } from "../../../routes/pos/posEditSaleRoutes";

export function registerVoucherSalesLineUpdateRoutes(app: Express) {
  app.patch(
    "/api/vouchers/:id/sales",
    requireAuth,
    requirePosSaleEditWindow,
    validateRequest(posSaleEditInput),
    async (req, res) => {
      return handlePosSaleEdit(req, res, { includeLegacyTopLevelVoucher: true });
    }
  );
}
