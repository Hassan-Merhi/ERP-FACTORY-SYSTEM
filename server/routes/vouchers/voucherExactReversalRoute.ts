import type { Express, Request, Response } from "express";

import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getClientDate } from "../../lib/dateUtils";
import { logger } from "../../lib/logger";
import { PostingValidationError } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { createDatabaseVoucherReversalLoader } from "../../services/accounting/databaseVoucherReversalLoader";
import { sendInventoryCutoverRefusal } from "../../services/accounting/perpetualInventory/cutoverRefusal";
import { assertExactReversalAllowedTx, reverseVoucherExactlyTx } from "../../services/accounting/voucherReversal";

const postingDependencies = createDatabasePostingDependencies();
const reversalLoader = createDatabaseVoucherReversalLoader();

function postingStatus(error: PostingValidationError): number {
  // A corrupt idempotency record is a conflict to resolve, not a bad request.
  return error.code === "POSTING_IDEMPOTENCY_CORRUPT" ? 409 : 400;
}

/**
 * Exact reversal of a posted voucher.
 *
 * The reversal is derived entirely from the immutable original, which is locked
 * inside this transaction before anything is read from it: accounting targets,
 * both currency sides, location and source module are inherited, and only the
 * debit and credit sides are swapped. The caller may supply the reversal's
 * identity and date and nothing else — it cannot restate an amount, retarget an
 * account, or reverse a voucher belonging to another company.
 *
 * The reversal is append-only. The original is never edited or deleted, so the
 * history shows both the posting and its reversal.
 *
 * Retries are safe: the engine keys on `voucher-reversal:<company>:<original>`,
 * so a double submission returns the first reversal rather than posting a
 * second one. Reversal-of-reversal chains fail closed.
 */
export function registerVoucherExactReversalRoute(app: Express): void {
  app.post(
    "/api/vouchers/:voucherId/exact-reversal",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ code: "COMPANY_REQUIRED", message: "No company selected" });
      }

      const originalVoucherId = Number(req.params.voucherId);
      if (!Number.isInteger(originalVoucherId) || originalVoucherId <= 0) {
        return res.status(400).json({ code: "VOUCHER_ID_INVALID", message: "Invalid voucher id in request path." });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const reversalDate = typeof body.reversalDate === "string" ? body.reversalDate : getClientDate(req);
      const reversalVoucherNumber =
        typeof body.reversalVoucherNumber === "string" && body.reversalVoucherNumber.trim()
          ? body.reversalVoucherNumber.trim()
          : `REV-${originalVoucherId}`;

      try {
        const result = await db.transaction(async (tx) => {
          await assertExactReversalAllowedTx(tx, companyId, originalVoucherId);
          return reverseVoucherExactlyTx(
            tx,
            {
              companyId,
              originalVoucherId,
              reversalVoucherNumber,
              reversalDate,
              description: typeof body.description === "string" ? body.description : null,
              actor: {
                userId: req.session.userId,
                username: req.session.username || "unknown",
              },
            },
            reversalLoader,
            postingDependencies
          );
        });

        logger.info("Exact voucher reversal posted", {
          module: "accounting",
          action: "voucher-reversal",
          companyId,
          userId: req.session.userId,
          originalVoucherId,
          replayed: result.replayed === true,
        });

        return res.status(result.replayed === true ? 200 : 201).json(result);
      } catch (error: unknown) {
        if (sendInventoryCutoverRefusal(res, error)) return;
        if (error instanceof PostingValidationError) {
          logger.warn("Exact voucher reversal refused", {
            module: "accounting",
            action: "voucher-reversal",
            companyId,
            userId: req.session.userId,
            originalVoucherId,
            code: error.code,
          });
          return res.status(postingStatus(error)).json({ code: error.code, message: error.message });
        }
        throw error;
      }
    }
  );
}
