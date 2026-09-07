import { type Express, type Request, type Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { requireAuth, canModifyDate } from "../../auth";
import { updatePosSale } from "../../services/pos/edit/updateSaleService";
import { classifyGoldenCoastPosConfigurationError } from "../../services/pos/goldenCoastPosConfigurationError";
import { logAudit } from "../helpers/auditHelpers";

export function registerPosEditSaleRoutes(app: Express): void {
  // Update existing sales voucher
  app.put("/api/vouchers/:id/sales", requireAuth, canModifyDate("voucherDate"), async (req, res) => {
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
      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "update",
          tableName: "vouchers",
          recordId: voucherId,
          recordIdentifier: result.body?.voucher?.voucherNumber ?? null,
          changes: null,
        });
      } catch (auditErr) {
        logger.error("[POS edit audit] non-fatal:", { error: auditErr });
      }
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
    res.status(500).json({ message: getErrorMessage(error) });
  }
}
