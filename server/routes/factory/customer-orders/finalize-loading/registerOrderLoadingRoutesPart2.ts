// Extracted from ./loading.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { dispatchNotification } from "../../../../lib/notificationService";
import { requireAuth } from "../../../../auth";
import { handlePostFactoryCustomerOrdersIdFinalizeLoadingStep1 } from "./handlePostFactoryCustomerOrdersIdFinalizeLoadingStep1";
import { handlePostFactoryCustomerOrdersIdFinalizeLoadingStep2 } from "./handlePostFactoryCustomerOrdersIdFinalizeLoadingStep2";
import { z } from "zod";
import { emptyQuery, idParams, validateRequest, type RequestSchemas } from "../../../../lib/validateRequest";

// createContinuation is the legacy name of createCarryoverProforma that an
// older bundle or the offline queue may still send. Step 1 keeps its date and
// flag-combination checks.
const finalizeLoadingInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    txDate: z.string().optional(),
    overrideLoadingDate: z.boolean().optional(),
    createCarryoverProforma: z.boolean().optional(),
    createContinuation: z.boolean().optional(),
    createNextLoading: z.boolean().optional(),
  }),
} satisfies RequestSchemas;
export function registerOrderLoadingRoutesPart2(app: Express) {
  app.post(
    "/api/factory/customer-orders/:id/finalize-loading",
    requireAuth,
    validateRequest(finalizeLoadingInput),
    async (req: Request, res: Response) => {
      try {
        const step1Result = handlePostFactoryCustomerOrdersIdFinalizeLoadingStep1(req, res);
        if (step1Result.done) return step1Result.value;
        const {
          companyId,
          createCarryoverProforma,
          createNextLoading,
          effectiveFinalizedAt,
          orderId,
          overrideLoadingDate,
          txDate,
        } = step1Result;
        const { finalized } = await handlePostFactoryCustomerOrdersIdFinalizeLoadingStep2(
          {
            companyId,
            createCarryoverProforma,
            createNextLoading,
            effectiveFinalizedAt,
            orderId,
            overrideLoadingDate,
            txDate,
          },
          req
        );
        handlePostFactoryCustomerOrdersIdFinalizeLoadingStep3({ companyId, finalized, orderId }, req, res);
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        if (message.startsWith("DISPATCH_CONSOLIDATION_REQUIRED:")) {
          return res.status(409).json({ code: "DISPATCH_CONSOLIDATION_REQUIRED", message });
        }
        logger.error("Error finalizing loading:", { error });
        res.status(400).json({ message });
      }
    }
  );
}

function handlePostFactoryCustomerOrdersIdFinalizeLoadingStep3(
  {
    companyId,
    finalized,
    orderId,
  }: Pick<
    Extract<Awaited<ReturnType<typeof handlePostFactoryCustomerOrdersIdFinalizeLoadingStep1>>, { done: false }> &
      Awaited<ReturnType<typeof handlePostFactoryCustomerOrdersIdFinalizeLoadingStep2>>,
    "companyId" | "finalized" | "orderId"
  >,
  req: Request,
  res: Response
) {
  const lsMsg = `${finalized.baleCount} bale${finalized.baleCount !== 1 ? "s" : ""} verified for ${finalized.customerName}`;
  dispatchNotification({
    eventType: "LOADING_FINALIZED",
    title: "Loading Finalized",
    message: lsMsg,
    entityType: "customer_order",
    entityId: orderId,
    triggeredByUserId: req.session?.userId ?? null,
    companyId,
  }).catch(() => {});

  if (finalized.nextLoading) {
    dispatchNotification({
      eventType: "LOADING_STARTED",
      title: "Loading Started",
      message: `Continuation loading #${finalized.nextLoading.id} started for ${finalized.customerName}`,
      entityType: "customer_order",
      entityId: finalized.nextLoading.id,
      triggeredByUserId: req.session?.userId ?? null,
      companyId,
    }).catch(() => {});
  }

  res.json({
    ...finalized.updated,
    ...(finalized.carriedOverProforma ? { carriedOverProforma: finalized.carriedOverProforma } : {}),
    ...(finalized.nextLoading ? { nextLoading: finalized.nextLoading } : {}),
  });
  return {};
}
