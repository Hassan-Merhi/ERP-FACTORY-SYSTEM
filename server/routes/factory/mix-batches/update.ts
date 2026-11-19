/**
 * factoryMixBatchRoutes: FactoryMixBatchUpdate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { requireAuth } from "../../../auth";
import { validateRequest } from "../../../lib/validateRequest";
import { updateMixBatchInput } from "./mixBatchWriteSchemas";
import { sendFactoryCostBasisRefusal } from "../../../services/factory/baleCostBasis";
import { MixEditRequestError } from "../../../services/factory/mixBatchEditRequest";
import {
  CompletedMixBatchSourceEditError,
  handlePatchFactoryMixBatchesIdStep1,
} from "./handlePatchFactoryMixBatchesIdStep1";
import { handlePatchFactoryMixBatchesIdStep2 } from "./handlePatchFactoryMixBatchesIdStep2";

export function registerFactoryMixBatchUpdateRoutes(app: Express) {
  app.patch(
    "/api/factory/mix-batches/:id",
    requireAuth,
    validateRequest(updateMixBatchInput),
    async (req: Request, res: Response) => {
      try {
        const step1Result = await handlePatchFactoryMixBatchesIdStep1(req, res);
        if (step1Result.done) return step1Result.value;
        const { ZERO, batchDate, companyId, id, name, notes, reason, sourceInputs, weightOf } = step1Result;
        const { result } = await handlePatchFactoryMixBatchesIdStep2(
          { ZERO, batchDate, companyId, id, name, notes, reason, sourceInputs, weightOf },
          req
        );
        handlePatchFactoryMixBatchesIdStep3({ result }, res);
      } catch (error: unknown) {
        if (error instanceof MixEditRequestError) {
          return res.status(error.status).json({ code: error.code, message: error.message });
        }
        if (error instanceof CompletedMixBatchSourceEditError) {
          return res.status(409).json({ code: error.code, message: error.message });
        }
        if (sendFactoryCostBasisRefusal(res, error)) return;
        logger.error("Error updating mix batch:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}

function handlePatchFactoryMixBatchesIdStep3(
  { result }: Pick<Awaited<ReturnType<typeof handlePatchFactoryMixBatchesIdStep2>>, "result">,
  res: Response
) {
  res.json(result);
  return {};
}
