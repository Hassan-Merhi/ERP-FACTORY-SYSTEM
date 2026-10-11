import type { Express, Request, Response } from "express";

import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { errorStatus, getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { PostingValidationError } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { sendInventoryCutoverRefusal } from "../../services/accounting/perpetualInventory/cutoverRefusal";
import { reverseVoucherTx, sendVoucherCorrectionRefusal } from "../../services/accounting/voucherCorrection";

const postingDependencies = createDatabasePostingDependencies();

/**
 * Phase 22 A (PE9/G10, owner decision): reversal of a posted voucher, the
 * correction a closed period allows (an edit there answers 409
 * VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD with this route). Owner/Admin.
 *
 * Body: `{ reason: string, reversalDate?: "YYYY-MM-DD" }` (date defaults to the
 * company's business date and must be in an open period). Posts one mirror
 * voucher through the central engine (gapless number), linked to the original
 * and audited with the reason; the original is never changed. A second
 * reversal of the same voucher is 409 VOUCHER_ALREADY_REVERSED.
 */
export function registerVoucherReverseRoute(app: Express): void {
  app.post(
    "/api/vouchers/:id/reverse",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ code: "COMPANY_REQUIRED", message: "No company selected" });
      const voucherId = Number(req.params.id);
      if (!Number.isInteger(voucherId) || voucherId <= 0) {
        return res.status(400).json({ code: "VOUCHER_ID_INVALID", message: "Invalid voucher ID" });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;

      try {
        const result = await db.transaction((tx) =>
          reverseVoucherTx(
            tx,
            {
              voucherId,
              companyId,
              reversalDate: typeof body.reversalDate === "string" ? body.reversalDate : null,
              reason: typeof body.reason === "string" ? body.reason : "",
              actor: { userId: req.session.userId, username: req.session.username || "unknown" },
            },
            postingDependencies
          )
        );
        logger.info("Voucher reversed", {
          module: "accounting",
          action: "voucher-reverse",
          companyId,
          userId: req.session.userId,
          voucherId,
          reversalVoucherId: result.reversal.id,
        });
        return res.status(201).json({
          originalVoucherId: result.original.id,
          reversal: result.reversal,
          entries: result.entries,
        });
      } catch (error: unknown) {
        if (sendVoucherCorrectionRefusal(res, error)) return;
        if (sendInventoryCutoverRefusal(res, error)) return;
        if (error instanceof PostingValidationError) {
          return res.status(400).json({ code: error.code, message: error.message });
        }
        logger.error("Voucher reversal failed", { module: "accounting", companyId, voucherId, error });
        return res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
      }
    }
  );
}
