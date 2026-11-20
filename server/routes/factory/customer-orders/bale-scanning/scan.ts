/**
 * baleScanningRoutes: OrderBaleScan endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { EXPECTED_CLIENT_RESPONSE_CODES, markExpectedClientResponse } from "../../../../lib/expectedClientResponse";
import { requireAuth } from "../../../../auth";
import { advanceSatisfiedPriorityScanConfigs } from "../priorityScanQueue";
import { handlePostFactoryCustomerOrdersIdBalesStep1 } from "./handlePostFactoryCustomerOrdersIdBalesStep1";
import { handlePostFactoryCustomerOrdersIdBalesStep2 } from "./handlePostFactoryCustomerOrdersIdBalesStep2";
import { z } from "zod";
import { emptyQuery, idParams, validateRequest, type RequestSchemas } from "../../../../lib/validateRequest";

// The loading, invoice-create and Priority Scan screens send these. The
// handler String()s scanCode and parseInts locationId, and keeps its own
// required-field, location and Priority Scan bypass checks.
const scanBaleInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    scanCode: z.union([z.string(), z.number()]).optional(),
    locationId: z.union([z.number(), z.string()]).nullable().optional(),
    priorityScan: z.boolean().optional(),
    allowBypassProforma: z.boolean().optional(),
    allowBypassOverload: z.boolean().optional(),
  }),
} satisfies RequestSchemas;

export function registerOrderBaleScanRoutes(app: Express) {
  registerOrderBaleScanRoutesPart1(app);
}

function registerOrderBaleScanRoutesPart1(app: Express) {
  app.post(
    "/api/factory/customer-orders/:id/bales",
    requireAuth,
    validateRequest(scanBaleInput),
    async (req: Request, res: Response) => {
      try {
        const step1Result = await handlePostFactoryCustomerOrdersIdBalesStep1(req, res);
        if (step1Result.done) return step1Result.value;
        const {
          availableNameCondition,
          companyId,
          isPriorityScan,
          order,
          orderId,
          parsedLocationId,
          priorityScanBusinessDate,
          scanCode,
          scanLower,
          scannerName,
          uniqueIdentifierCondition,
        } = step1Result;
        const { result } = await handlePostFactoryCustomerOrdersIdBalesStep2(
          {
            availableNameCondition,
            companyId,
            isPriorityScan,
            order,
            orderId,
            parsedLocationId,
            priorityScanBusinessDate,
            scanCode,
            scanLower,
            scannerName,
            uniqueIdentifierCondition,
          },
          req
        );
        const step3Result = await handlePostFactoryCustomerOrdersIdBalesStep3(
          { companyId, order, orderId, result },
          req,
          res
        );
        if (step3Result.done) return step3Result.value;
      } catch (error: unknown) {
        logger.error("Error adding bale to order:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}

async function handlePostFactoryCustomerOrdersIdBalesStep3(
  {
    companyId,
    order,
    orderId,
    result,
  }: Pick<
    Extract<Awaited<ReturnType<typeof handlePostFactoryCustomerOrdersIdBalesStep1>>, { done: false }> &
      Awaited<ReturnType<typeof handlePostFactoryCustomerOrdersIdBalesStep2>>,
    "companyId" | "order" | "orderId" | "result"
  >,
  req: Request,
  res: Response
) {
  if (!result.ok) {
    if (result.body?.confirmationType === "overload") {
      markExpectedClientResponse(res, EXPECTED_CLIENT_RESPONSE_CODES.BALE_SCAN_OVERLOAD);
    } else if (result.body?.confirmationType === "not_in_proforma") {
      markExpectedClientResponse(res, EXPECTED_CLIENT_RESPONSE_CODES.BALE_SCAN_NOT_IN_PROFORMA);
    }
    return { done: true as const, value: res.status(result.httpStatus).json(result.body) };
  }

  let priorityScanAdvance = null;
  if (req.body.priorityScan === true) {
    try {
      priorityScanAdvance = await advanceSatisfiedPriorityScanConfigs(companyId, orderId);
    } catch (advanceError) {
      // The bale allocation has already committed. Never turn a successful
      // physical scan into a retryable 500 just because queue advancement
      // failed; the next Priority Scan route resolution will reconcile it.
      logger.error("Priority Scan auto-advance failed after bale allocation", {
        orderId,
        error: getErrorMessage(advanceError),
      });
    }
  }

  return {
    done: true as const,
    value: res.json({
      compactBaleScan: true,
      orderId,
      order: {
        ...order,
        ...result.totals,
      },
      bale: result.bale,
      line: result.line,
      totals: result.totals,
      priorityScanAdvance,
    }),
  };
  return { done: false as const };
}
