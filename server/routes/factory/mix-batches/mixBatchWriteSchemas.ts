/**
 * Request schemas for the factory mix-batch write routes
 * (/api/factory/mix-batches...). The handlers and the mix lifecycle services
 * keep their own business checks and messages; these schemas only pin the
 * shape of what clients send and reject unknown fields.
 */
import { z } from "zod";
import { emptyBody, emptyQuery, idParams, type RequestSchemas } from "../../../lib/validateRequest";

/** Ids and kilograms reach drizzle / mixKilograms, which read numbers and numeric strings. */
const numberOrString = z.union([z.number(), z.string()]);

/**
 * Older clients sent a costPerKg with each source. The server always resolves
 * rates itself and ignores it (see the create/top-up handlers), so it is
 * accepted and ignored.
 */
const ignoredClientCost = z.unknown().optional();

const supplierSource = z.strictObject({
  supplierId: numberOrString,
  weightKg: numberOrString.optional(),
  costPerKg: ignoredClientCost,
});

/** Legacy container-linked source. */
const containerSource = z.strictObject({
  containerId: numberOrString,
  weightKg: numberOrString.optional(),
  costPerKg: ignoredClientCost,
});

const batchSource = z.strictObject({
  sourceBatchId: numberOrString,
  weightKg: numberOrString.optional(),
  costPerKg: ignoredClientCost,
});

const sourceLists = {
  supplierSources: z.array(supplierSource).optional(),
  sources: z.array(containerSource).optional(),
  batchSources: z.array(batchSource).optional(),
};

export const createMixBatchInput = {
  query: emptyQuery,
  body: z.strictObject({
    ...sourceLists,
    openingBatchId: numberOrString.nullable().optional(),
    name: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    operatorUser: z.string().nullable().optional(),
    batchDate: z.string().nullable().optional(),
  }),
} satisfies RequestSchemas;

export const topUpMixBatchInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ ...sourceLists, txDate: z.string().nullable().optional() }),
} satisfies RequestSchemas;

/** parseMixEditSelection checks ids are positive integers and weights are kg amounts. */
const editSupplierSource = z.strictObject({
  supplierId: z.number(),
  weightKg: numberOrString,
  costPerKg: ignoredClientCost,
});
const editBatchSource = z.strictObject({
  sourceBatchId: z.number(),
  weightKg: numberOrString,
  costPerKg: ignoredClientCost,
});

export const updateMixBatchInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    name: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    batchDate: z.string().nullable().optional(),
    supplierSources: z.array(editSupplierSource).optional(),
    batchSources: z.array(editBatchSource).optional(),
    sourceEditPreview: z.boolean().optional(),
    sourceEditReason: z.string().optional(),
    sourceEditReviewHash: z.string().optional(),
    confirmSourceEdit: z.boolean().optional(),
  }),
} satisfies RequestSchemas;

export const finalizeMixBatchInput = {
  params: idParams,
  query: emptyQuery,
  // requireMixFinalizeDecision reads these; an empty body finalizes a batch
  // with nothing remaining.
  body: z.union([
    z.undefined(),
    z.strictObject({
      confirmRemainderAsWaste: z.boolean().optional(),
      wasteKg: numberOrString.optional(),
      wasteReason: z.string().optional(),
    }),
  ]),
} satisfies RequestSchemas;

export const deleteMixBatchInput = {
  params: idParams,
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export const assignBalesInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ baleIds: z.array(numberOrString).optional() }),
} satisfies RequestSchemas;

/** validateMixLifecycleUsageRequest checks ids, kilograms, dates and lengths. */
export const consumeMixBatchesInput = {
  query: emptyQuery,
  body: z.strictObject({
    usages: z.array(
      z.strictObject({
        batchId: z.number(),
        kgUsed: numberOrString,
        notes: z.string().nullable().optional(),
      })
    ),
    usedDate: z.string(),
    operatorUser: z.string().nullable().optional(),
  }),
} satisfies RequestSchemas;
