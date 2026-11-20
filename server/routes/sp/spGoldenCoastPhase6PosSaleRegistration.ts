import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../../auth";
import { validateRequest, type RequestSchemas } from "../../lib/validateRequest";
import { privilegedMutationRateLimit, privilegedReadRateLimit } from "../../middleware/privilegedEndpointSecurity";
import { amountish, numberish, spWriteFields } from "./spRequestSchemas";
import {
  handlePostSale,
  handleReadiness,
  PHASE6_READINESS_PATH,
  PHASE6_SALE_PATH,
  phase6RequestBudget,
} from "./spGoldenCoastPhase6PosSaleRoutes";

// parseGoldenCoastPhase5SaleInput keeps every value and presence check (and
// its coded GC_PHASE5_* refusals); this only fixes the shape. clientRequestId
// (the sale's idempotency key) comes from spWriteFields. The handler refuses
// any non-null saleSideAccount with its own retired-override code.
const phase6SaleInput = {
  body: z.strictObject({
    ...spWriteFields,
    locationId: numberish.optional(),
    saleDate: z.string().optional(),
    customerName: z.string().optional(),
    notes: z.string().nullable().optional(),
    lines: z
      .array(
        z.strictObject({
          stockItemId: numberish.optional(),
          qty: amountish.optional(),
          unitPriceUsd: amountish.optional(),
          description: z.string().nullable().optional(),
        })
      )
      .optional(),
    saleSideAccount: z.unknown().optional(),
  }),
} satisfies RequestSchemas;

export function registerSpGoldenCoastPhase6PosSaleRoutes(app: Express): void {
  app.get(PHASE6_READINESS_PATH, privilegedReadRateLimit, requireAuth, (req, res) => void handleReadiness(req, res));
  app.post(
    PHASE6_SALE_PATH,
    privilegedMutationRateLimit,
    phase6RequestBudget,
    requireAuth,
    validateRequest(phase6SaleInput),
    (req, res) => void handlePostSale(req, res)
  );
}
