// Request schemas for ./loadingDispatchScanRoutes.ts (kept apart for the source-size cap).
import { z } from "zod";
import { emptyQuery, positiveIntParam, type RequestSchemas } from "../../../lib/validateRequest";

const tripParams = z.strictObject({ id: positiveIntParam, dispatchId: positiveIntParam });

// validBarcode keeps its INVALID_BARCODE answer for an empty or long code.
export const addDispatchScanInput = {
  params: tripParams,
  query: emptyQuery,
  body: z.strictObject({ scanCode: z.string().optional() }),
} satisfies RequestSchemas;

// The scanner sends { reason, all: true } or { reason, scanIds } (string ids);
// the handler keeps its reason, selection and id-format checks.
export const bulkRemoveDispatchScansInput = {
  params: tripParams,
  query: emptyQuery,
  body: z.strictObject({
    reason: z.string().optional(),
    all: z.boolean().optional(),
    scanIds: z.array(z.union([z.string(), z.number()])).optional(),
  }),
} satisfies RequestSchemas;

export const removeDispatchScanInput = {
  params: z.strictObject({ id: positiveIntParam, dispatchId: positiveIntParam, scanId: positiveIntParam }),
  query: emptyQuery,
  body: z.strictObject({ reason: z.string().optional() }),
} satisfies RequestSchemas;
