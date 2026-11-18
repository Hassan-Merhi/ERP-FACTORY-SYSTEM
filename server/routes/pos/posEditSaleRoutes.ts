import { type Express, type Request, type Response } from "express";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { requireAuth } from "../../auth";
import { requirePosSaleEditWindow } from "../../middleware/posSaleEditWindow";
import { companyBusinessDate } from "../../services/accounting/companyBusinessDate";
import { getActiveCompanyPermissionContext } from "../../services/security/activeCompanyPermissionContext";
import { updatePosSale } from "../../services/pos/edit/updateSaleService";
import { classifyGoldenCoastPosConfigurationError } from "../../services/pos/goldenCoastPosConfigurationError";

export function registerPosEditSaleRoutes(app: Express): void {
  app.get("/api/pos/daybook-edit-status", requireAuth, async (req, res) => {
    try {
      const access = await getActiveCompanyPermissionContext(req);
      const businessDate = await companyBusinessDate(access.companyId);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        role: access.role,
        daybookEditDays: access.daybookEditDays,
        posViewOnly: access.posViewOnly,
        businessDate,
      });
    } catch (error) {
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
  // Update existing sales voucher
  app.put("/api/vouchers/:id/sales", requireAuth, requirePosSaleEditWindow, async (req, res) => {
    return handlePosSaleEdit(req, res);
  });
}

/**
 * Shared sale-edit handler used by the canonical PUT endpoint and the
 * temporary PATCH compatibility alias. Keeping both methods on this handler
 * prevents the old editor from drifting from POS edits.
 */
export async function handlePosSaleEdit(
  req: Request,
  res: Response,
  options: { includeLegacyTopLevelVoucher?: boolean } = {}
): Promise<Response | void> {
  const _t = Date.now();
  const _uid = req.session.userId;
  const _cid = req.session.currentCompanyId;
  try {
    logger.info("POS sale update started", { module: "pos", action: "updateSale", userId: _uid, companyId: _cid });
    const voucherId = parseInt(req.params.id);
    if (isNaN(voucherId)) {
      return res.status(400).json({ message: "Invalid voucher ID" });
    }

    if (!req.session.currentCompanyId) {
      return res.status(400).json({ message: "No company selected" });
    }

    const result = await updatePosSale({
      voucherId,
      currentCompanyId: req.session.currentCompanyId,
      userId: req.session.userId!,
      username: req.session.username || "unknown",
      userRole: req.user?.role,
      canSellNegativeStock: req.user?.canSellNegativeStock || false,
      posDaybookEditAuthorization: req.posDaybookEditAuthorization,
      body: req.body,
    });

    if (result.status === 200) {
      logger.info("POS sale update succeeded", {
        module: "pos",
        action: "updateSale",
        userId: _uid,
        companyId: _cid,
        voucherId: result.body?.voucher?.id,
        durationMs: Date.now() - _t,
      });
      // Phase 21 (B): updatePosSale writes the edit audit inside the edit's
      // transaction; the duplicate after-commit summary row here is gone.
    }
    // Editing another cashier's assigned-location sale must not expose COGS,
    // profits, ledger accounts or internal stock valuations in the response.
    if (req.user?.role === "POS" && result.status === 200 && result.body?.voucher) {
      const voucher = result.body.voucher;
      const safeVoucher = {
        id: voucher.id,
        voucherNumber: voucher.voucherNumber,
        voucherType: voucher.voucherType,
        voucherDate: voucher.voucherDate,
        locationId: voucher.locationId,
        totalAmount: voucher.totalAmount,
        currency: voucher.currency,
        exchangeRate: voucher.exchangeRate,
        isCreditSale: voucher.isCreditSale,
      };
      const items = Array.isArray(result.body.items) ? result.body.items : [];
      return res.status(200).json({
        ...(options.includeLegacyTopLevelVoucher ? safeVoucher : {}),
        voucher: safeVoucher,
        location: { id: voucher.locationId },
        items: items.map((item: Record<string, unknown>) => ({
          id: item.id,
          stockItemId: item.stockItemId,
          stockItemName: item.stockItemName,
          quantity: item.quantity,
          sellingPrice: item.sellingPrice,
          rate: item.rate,
          rateUSD: item.rateUSD,
          totalSales: item.totalSales,
        })),
        grandTotal: result.body.grandTotal,
        voucherNumber: result.body.voucherNumber,
        saleDate: result.body.saleDate,
        isCreditSale: result.body.isCreditSale,
      });
    }
    const responseBody =
      options.includeLegacyTopLevelVoucher && result.body?.voucher
        ? { ...result.body.voucher, ...result.body }
        : result.body;
    res.status(result.status).json(responseBody);
  } catch (error: unknown) {
    logger.error("POS sale update failed", {
      module: "pos",
      action: "updateSale",
      userId: _uid,
      companyId: _cid,
      durationMs: Date.now() - _t,
      error,
    });

    const configurationError = classifyGoldenCoastPosConfigurationError(error);
    if (configurationError) {
      return res.status(configurationError.status).json(configurationError.body);
    }

    if (getErrorMessage(error).includes("Inventory not found")) {
      return res.status(404).json({ message: getErrorMessage(error) });
    }
    if (getErrorMessage(error).includes("Insufficient stock")) {
      return res.status(400).json({ message: getErrorMessage(error) });
    }
    res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
  }
}
