import type { Request, Response } from "express";
import type { Express } from "express";

import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { logger } from "../../../lib/logger";
import { getErrorMessage } from "../../../lib/httpHandlers";
import {
  financialOperationErrorStatus,
  financialOperationRequestPayload,
} from "../../../services/accounting/financialOperationRequest";
import {
  DurableFinancialOperationError,
  financialOperationFingerprint,
  withDurableFinancialOperation,
} from "../../../services/accounting/durableFinancialOperation";
import { FactoryFxRateRequiredError } from "../../../services/factory/factoryDocumentFxRate";
import {
  ReverseOffloadError,
  handlePostFactoryContainersIdReverseOffloadStep1,
  type ReverseOffloadOutcome,
} from "./findConsumingMixBatchCodes";
import { handlePostFactoryContainersIdReverseOffloadStep2 } from "./handlePostFactoryContainersIdReverseOffloadStep2";
import { validateRequest } from "../../../lib/validateRequest";
import { reverseOffloadInput } from "./containerChargeRouteSchemas";

/**
 * POST /api/factory/containers/:id/reverse-offload — undoes an offload,
 * unwinding the raw stock, its receipts, commissions, additional charges and
 * every voucher and daybook entry the offload posted.
 *
 * It is the inverse of the offload handler rather than part of it: the two
 * shared a file but no code. Registered from the same point in the same order,
 * so config/route-manifest.json is unchanged.
 */
export function registerRawStockReverseOffloadRoute(app: Express) {
  app.post(
    "/api/factory/containers/:id/reverse-offload",
    requireAuth,
    validateRequest(reverseOffloadInput),
    async (req, res) => {
      try {
        const step1Result = await handlePostFactoryContainersIdReverseOffloadStep1(req, res);
        if (step1Result.done) return step1Result.value;
        const { companyId, containerId, requestId } = step1Result;
        const { reverseOffload } = handlePostFactoryContainersIdReverseOffloadStep2({ companyId, containerId }, req);
        await handlePostFactoryContainersIdReverseOffloadStep3({ companyId, requestId, reverseOffload }, req, res);
      } catch (error: unknown) {
        if (error instanceof ReverseOffloadError) {
          return res.status(error.status).json({ message: error.message });
        }
        if (error instanceof FactoryFxRateRequiredError) return res.status(409).json(error.body);
        if (error instanceof DurableFinancialOperationError) {
          return res.status(financialOperationErrorStatus(error)).json({ message: error.message });
        }
        logger.error("Error reversing offload:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}

async function handlePostFactoryContainersIdReverseOffloadStep3(
  {
    companyId,
    requestId,
    reverseOffload,
  }: Pick<
    Extract<Awaited<ReturnType<typeof handlePostFactoryContainersIdReverseOffloadStep1>>, { done: false }> &
      Awaited<ReturnType<typeof handlePostFactoryContainersIdReverseOffloadStep2>>,
    "companyId" | "requestId" | "reverseOffload"
  >,
  req: Request,
  res: Response
) {
  // The reversal is one indivisible unit of work. With a caller-supplied
  // request identity it also becomes a durable operation, so a client retry
  // after an uncertain response replays the stored outcome instead of running
  // the reversal a second time against a container that is no longer OFFLOADED.
  const outcome: ReverseOffloadOutcome = requestId
    ? (
        await withDurableFinancialOperation<ReverseOffloadOutcome>(
          {
            companyId,
            operationName: "factory.container.reverse-offload",
            idempotencyKey: requestId,
            requestFingerprint: financialOperationFingerprint({
              method: req.method,
              path: req.originalUrl,
              companyId,
              body: financialOperationRequestPayload(req.body),
            }),
          },
          async (tx) => ({ value: await reverseOffload(tx, requestId) })
        )
      ).value
    : await db.transaction((tx) => reverseOffload(tx, ""));

  res.json({ message: outcome.message });
  return {};
}
