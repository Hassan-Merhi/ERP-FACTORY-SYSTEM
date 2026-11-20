/**
 * Request schemas for the pressing routes in ./balesPressingRoutes.ts. The
 * handlers keep their own required-field, quantity (parseBaleQuantity) and
 * product checks and messages; these pin the shape. Ids, quantities and
 * weights arrive as numbers or strings (tests and the pressing screens send
 * weightPerBale as a string), and the handlers convert them.
 */
import { z } from "zod";
import { emptyQuery, type RequestSchemas } from "../../../lib/validateRequest";

const numberOrString = z.union([z.number(), z.string()]);

const pressingFields = {
  productId: numberOrString.nullable().optional(),
  quantity: numberOrString.nullable().optional(),
  weightPerBale: numberOrString.nullable().optional(),
};

/** POST /api/factory/pressing/create-and-print */
export const createAndPrintInput = {
  query: emptyQuery,
  body: z.strictObject({ ...pressingFields, txDate: z.string().optional() }),
} satisfies RequestSchemas;

/**
 * POST /api/factory/pressing/create-multi. The legacy browser offline queue
 * replays this URL, so `qty` (the handler's fallback for `quantity`) stays.
 */
export const createMultiInput = {
  query: emptyQuery,
  body: z.strictObject({
    items: z.array(z.strictObject({ ...pressingFields, qty: numberOrString.nullable().optional() })).optional(),
    txDate: z.string().optional(),
  }),
} satisfies RequestSchemas;

/** POST /api/factory/bales/create-batch (no daybook date). */
export const createBatchInput = {
  query: emptyQuery,
  body: z.strictObject(pressingFields),
} satisfies RequestSchemas;

/** POST /api/factory/finalize in ./balesFinalizeRoutes.ts. */
export const finalizeInput = {
  query: emptyQuery,
  body: z.strictObject({
    pressingBatchId: numberOrString.nullable().optional(),
    scannedBaleIds: z.array(numberOrString).nullable().optional(),
    erpLocationId: numberOrString.nullable().optional(),
    mixBatchId: numberOrString.nullable().optional(),
    txDate: z.string().optional(),
  }),
} satisfies RequestSchemas;
