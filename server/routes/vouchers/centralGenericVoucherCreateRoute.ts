import type { Express, NextFunction, Request, Response } from "express";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { errorBody, errorStatus } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { autoReallocateLoansAccounts } from "../../lib/transporterAllocation";
import { PostingValidationError } from "../../services/accounting/centralPostingEngine";
import { postCentralGenericVoucherTx } from "../../services/accounting/centralGenericVoucherCreate";
import { captureEdgeVoucherTx } from "../../edge/edgeVoucherOutbox";
import { supportsCentralGenericVoucher } from "../../services/accounting/genericVoucherPosting";
import { stockVoucherTypeRefusal } from "../../services/accounting/stockVoucherTypes";
import { triggerIntercompanyNotifications } from "../intercompanyNotificationRoutes";
import { getCurrentExchangeRate } from "../_helpers";

function postingStatus(error: PostingValidationError): number {
  return error.code === "POSTING_IDEMPOTENCY_CORRUPT" ? 409 : 400;
}

async function createCentralGenericVoucher(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Wave 12: stock adjustment types come only from POST /api/stock-adjustments.
  const stockTypeRefusal = stockVoucherTypeRefusal(req.body?.voucher?.voucherType);
  if (stockTypeRefusal) {
    res.status(stockTypeRefusal.status).json(stockTypeRefusal.body);
    return;
  }
  if (!supportsCentralGenericVoucher(req.body)) {
    next();
    return;
  }

  const startedAt = Date.now();
  const companyId = req.session.currentCompanyId;
  const userId = req.session.userId;

  try {
    if (!companyId) {
      res.status(400).json({ message: "No company selected" });
      return;
    }

    const currentRate = await getCurrentExchangeRate(companyId);
    const suppliedRate = req.body.voucher?.exchangeRate;
    const voucherExchangeRate =
      suppliedRate != null ? String(suppliedRate) : currentRate != null ? String(currentRate) : null;

    const result = await db.transaction(async (tx) => {
      // The posting itself (linked ledgers, central engine, employee balances,
      // audit) is the shared service, also used by the offline replay.
      const created = await postCentralGenericVoucherTx(tx, {
        companyId,
        clientRequestId: req.body.clientRequestId,
        voucher: req.body.voucher,
        entries: req.body.entries,
        exchangeRate: voucherExchangeRate,
        actor: {
          userId: userId as string,
          username: req.session.username || "unknown",
          reason: "Generic voucher creation",
        },
      });
      if (!created.posted.replayed) {
        // Phase 8: only the central protected path is approved for new LAN
        // vouchers. Capture immutable evidence in this SAME transaction;
        // if its outbox insert fails, rollback the voucher and its audit.
        await captureEdgeVoucherTx(tx, {
          companyId,
          actorUserId: String(userId),
          localVoucherId: created.posted.voucher.id,
          requestId: created.clientRequestId,
          voucher: created.posted.voucher,
          entries: created.posted.entries,
        });
      }
      return created;
    });

    const { posted, clientRequestId } = result;
    if (!posted.replayed) {
      triggerIntercompanyNotifications(
        companyId,
        posted.voucher.id,
        posted.voucher.voucherNumber,
        posted.voucher.voucherDate,
        posted.voucher.totalAmount || "0",
        posted.voucher.description,
        posted.entries.map((entry) => entry.ledgerAccountId),
        posted.voucher.voucherType
      ).catch(() => {});

      autoReallocateLoansAccounts(
        companyId,
        posted.entries.map((entry) => entry.ledgerAccountId)
      ).catch(() => {});
    }

    logger.info("Central generic voucher create succeeded", {
      module: "vouchers",
      action: "createWithEntriesCentral",
      userId,
      companyId,
      voucherId: posted.voucher.id,
      replayed: posted.replayed,
      durationMs: Date.now() - startedAt,
    });

    res.json({
      voucher: posted.voucher,
      entries: posted.entries,
      replayed: posted.replayed,
      clientRequestId,
    });
  } catch (error: unknown) {
    logger.error("Central generic voucher create failed", {
      module: "vouchers",
      action: "createWithEntriesCentral",
      userId,
      companyId,
      durationMs: Date.now() - startedAt,
      error,
    });

    if (error instanceof PostingValidationError) {
      res.status(postingStatus(error)).json({ message: error.message, code: error.code });
      return;
    }

    res.status(errorStatus(error)).json(errorBody(error));
  }
}

export function registerCentralGenericVoucherCreateRoute(app: Express): void {
  app.post(
    "/api/vouchers/with-entries",
    requireAuth,
    requireNonPOS,
    (req, res, next) => void createCentralGenericVoucher(req, res, next)
  );
}
