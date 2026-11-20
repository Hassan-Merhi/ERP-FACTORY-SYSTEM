/**
 * Request schemas for the raw-stock write routes (stock receipts, adjustments,
 * opening balances, offloads, planner, recalculation and repair endpoints).
 *
 * Every /api/factory/raw-stock/* write is a Phase 5 operational voucher request
 * (shared/voucherPathIdentityPolicy.ts): the browser fetch guard
 * (client/src/lib/accountingRequestFetchGuard.ts) adds a `clientRequestId` to
 * the JSON body, bodyless DELETEs included, and the voucher-path boundary reads
 * it as the request identity. Those schemas therefore declare it.
 *
 * The seven routes listed in services/security/rawStockSensitiveInputGuard.ts
 * are validated first by that guard, which rejects every field it does not
 * list (clientRequestId included) and only adds the `reason`/`idempotencyKey`
 * provenance fields. Their schemas mirror the guard exactly.
 */
import { z } from "zod";
import { emptyQuery, idParams, positiveIntParam, type RequestSchemas } from "../../../lib/validateRequest";

/** Handlers parse these with parseMoneyInput/Number/parseInt: callers send numbers or numeric strings. */
const looseNumber = z.union([z.number(), z.string()]);
const optionalNumber = looseNumber.nullable().optional();
const optionalText = z.string().nullable().optional();
/** Phase 5 request identity added by the client fetch guard. */
const clientRequestId = z.string().optional();
/** Bodyless writes: no body (tests, scripts) or the fetch guard's `{ clientRequestId }`. */
const identityOnlyBody = z.union([z.undefined(), z.strictObject({ clientRequestId })]);
/** Provenance fields rawStockSensitiveInputGuard allows on every guarded route. */
const provenance = { reason: z.string().optional(), idempotencyKey: z.string().optional() };
/** rawStockSensitiveInputGuard's positiveIntegerArray. */
const positiveIds = z.array(z.number().int().positive());

const rawStockIdParams = z.strictObject({ rawStockId: positiveIntParam });

// ── Adjustments and receipts ────────────────────────────────────────────────

export const deleteBatchSourceInput = {
  query: emptyQuery,
  // requireValidBatchSourceDeleteInput already requires both ids.
  body: z.strictObject({ batchId: looseNumber, supplierId: looseNumber, clientRequestId }),
} satisfies RequestSchemas;

export const deleteReceiptInput = {
  params: rawStockIdParams,
  query: emptyQuery,
  body: identityOnlyBody,
} satisfies RequestSchemas;

export const patchReceiptInput = {
  params: rawStockIdParams,
  query: emptyQuery,
  body: z.strictObject({ receivedKg: optionalNumber, clientRequestId }),
} satisfies RequestSchemas;

export const createAdjustmentInput = {
  query: emptyQuery,
  body: z.strictObject({
    type: z.string().optional(),
    kg: optionalNumber,
    costPerKg: optionalNumber,
    currencyCode: optionalText,
    supplierId: optionalNumber,
    materialLabel: optionalText,
    notes: optionalText,
    reference: optionalText,
    date: optionalText,
    createVoucher: z.boolean().optional(),
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const deleteAdjustmentInput = {
  params: idParams,
  query: emptyQuery,
  body: identityOnlyBody,
} satisfies RequestSchemas;

export const deductReceivedInput = {
  query: emptyQuery,
  body: z.strictObject({
    supplierId: optionalNumber,
    kg: optionalNumber,
    notes: optionalText,
    reference: optionalText,
    costPerKg: optionalNumber,
    currencyCode: optionalText,
    txDate: optionalText,
    clientRequestId,
  }),
} satisfies RequestSchemas;

/** Retired (410). Accepts the legacy body so callers keep getting the 410. */
export const updateCostInput = {
  query: emptyQuery,
  body: z.union([
    z.undefined(),
    z.strictObject({
      supplierId: z.unknown().optional(), // legacy update-cost body (tests/phase19c, tests/raw-stock-cost-exact); not used
      newCostPerKg: z.unknown().optional(), // legacy update-cost body; not used
      clientRequestId,
    }),
  ]),
} satisfies RequestSchemas;

// ── Opening balances ────────────────────────────────────────────────────────

export const createOpeningBalanceInput = {
  query: emptyQuery,
  body: z.strictObject({
    supplierName: z.union([z.string(), z.number()]).nullable().optional(),
    supplierId: optionalNumber,
    receivedKg: optionalNumber,
    costPerKg: optionalNumber,
    currencyCode: optionalText,
    fxRateToUsd: optionalNumber,
    notes: optionalText,
    commissionAmount: optionalNumber,
    commissionCurrencyCode: optionalText,
    commissionFxRateToUsd: optionalNumber,
    txDate: optionalText,
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const updateOpeningBalanceInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    supplierId: optionalNumber,
    supplierName: z.union([z.string(), z.number()]).nullable().optional(),
    receivedKg: optionalNumber,
    costPerKg: optionalNumber,
    currencyCode: optionalText,
    fxRateToUsd: optionalNumber,
    notes: optionalText,
    commissionAmount: optionalNumber,
    commissionCurrencyCode: optionalText,
    commissionPersonName: optionalText,
    commissionNotes: optionalText,
    commissionFxRateToUsd: optionalNumber,
    rawStockId: z.unknown().optional(), // sent by client/src/pages/factory/factory-suppliers/useFactorySuppliersModelPart2.ts; not used
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const deleteOpeningBalanceInput = {
  params: idParams,
  query: emptyQuery,
  body: identityOnlyBody,
} satisfies RequestSchemas;

export const assignToBalesInput = {
  params: rawStockIdParams,
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({ baleIds: z.array(z.number()).optional(), clientRequestId })]),
} satisfies RequestSchemas;

const confirmOnlyBody = z.union([z.undefined(), z.strictObject({ confirm: z.boolean().optional(), clientRequestId })]);

export const recalculateUsedInput = { query: emptyQuery, body: confirmOnlyBody } satisfies RequestSchemas;
export const recalculateBaleCostsInput = { query: emptyQuery, body: confirmOnlyBody } satisfies RequestSchemas;

// ── Fixed production planner ────────────────────────────────────────────────

export const savePlannerInput = {
  query: emptyQuery,
  body: z.strictObject({
    // Supplier ids, "cat:<id>" or "cat:uncategorized"; the handler checks the keys.
    allocations20t: z.record(z.string(), z.number()).optional(),
    expectedRevision: z.number().optional(),
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const unlockPlannerInput = {
  query: emptyQuery,
  body: z.strictObject({ expectedRevision: z.number().optional(), clientRequestId }),
} satisfies RequestSchemas;

// ── Offload ─────────────────────────────────────────────────────────────────

const offloadCommission = z.strictObject({
  personName: optionalText,
  commissionType: optionalText,
  commissionRate: optionalNumber,
  currencyCode: optionalText,
  ledgerAccountId: optionalNumber,
  fxRateToUsd: z.unknown().optional(), // sent by client/src/pages/factory/production-raw-stock/offloadFormCalculations.ts; not used (server resolves the rate)
  fxRateDate: z.unknown().optional(), // sent by the same client builder; not used
});

const offloadAdditionalCharge = z.strictObject({
  description: optionalText,
  amount: optionalNumber,
  currencyCode: optionalText,
  fxRateToUsd: optionalNumber,
  ledgerAccountId: optionalNumber,
  supplierId: optionalNumber,
});

const offloadMixBatchAllocation = z.strictObject({ mixBatchId: optionalNumber, weightKg: optionalNumber });

export const offloadInput = {
  query: emptyQuery,
  body: z.strictObject({
    containerId: optionalNumber,
    receivedKg: optionalNumber,
    costPerKg: optionalNumber,
    commission: offloadCommission.nullable().optional(),
    currencyCode: optionalText,
    fxRateToUsd: optionalNumber,
    freight: optionalNumber,
    freightAccountId: optionalNumber,
    freightSupplierId: optionalNumber,
    freightCurrencyCode: optionalText,
    freightFxRate: optionalNumber,
    otherCharges: optionalNumber,
    otherChargesAccountId: optionalNumber,
    otherChargesSupplierId: optionalNumber,
    otherChargesCurrencyCode: optionalText,
    otherChargesFxRate: optionalNumber,
    dutyAmount: optionalNumber,
    dutyAccountId: optionalNumber,
    dutyStatus: optionalText,
    dutyNotes: optionalText,
    additionalCharges: z.array(offloadAdditionalCharge).nullable().optional(),
    offloadDate: optionalText,
    mixBatchAllocations: z.array(offloadMixBatchAllocation).nullable().optional(),
    destination: optionalText,
    idempotencyKey: optionalText,
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const postOffloadRepairInput = {
  query: emptyQuery,
  body: z.union([
    z.undefined(),
    z.strictObject({
      dryRun: z.boolean().optional(),
      confirmationToken: optionalText,
      supplierIds: z.array(looseNumber).nullable().optional(),
      clientRequestId,
    }),
  ]),
} satisfies RequestSchemas;

// ── Recalculation (guarded routes mirror rawStockSensitiveInputGuard) ──────

export const recalcApplyInput = {
  query: emptyQuery,
  body: z.strictObject({
    containerIds: positiveIds,
    confirm: z.boolean().optional(),
    confirmationToken: z.string().optional(),
    includeCompletedBatches: z.boolean().optional(),
    includeHistoricalContainers: z.boolean().optional(),
    ...provenance,
  }),
} satisfies RequestSchemas;

export const recalcApplyAllSafeInput = {
  query: emptyQuery,
  body: z.strictObject({
    confirm: z.boolean().optional(),
    confirmationToken: z.string().optional(),
    includeHistoricalContainers: z.boolean().optional(),
    includeCompletedBatches: z.boolean().optional(),
    ...provenance,
  }),
} satisfies RequestSchemas;

/** Retired (410); the guard still requires its old body. */
export const recalcAutoApplyFxInput = {
  query: emptyQuery,
  body: z.strictObject({ containerIds: positiveIds, ...provenance }),
} satisfies RequestSchemas;

/** Retired (410); the guard admits only the provenance fields. */
export const recalcFixSourceMismatchesInput = {
  query: emptyQuery,
  body: z.strictObject(provenance),
} satisfies RequestSchemas;

export const recalcZeroCostSourcesApplyInput = {
  query: emptyQuery,
  body: z.strictObject({
    sourceIds: positiveIds,
    // Source id -> manual USD rate; the guard checks keys against sourceIds.
    manualRates: z.record(z.string(), z.number()).optional(),
    confirm: z.boolean().optional(),
    confirmationToken: z.string().optional(),
    ...provenance,
  }),
} satisfies RequestSchemas;

export const recalcUndoInput = {
  query: emptyQuery,
  body: z.strictObject({ undoLogId: z.number().int().positive(), ...provenance }),
} satisfies RequestSchemas;

export const supplierRateRecomputeInput = {
  query: emptyQuery,
  body: z.strictObject({
    supplierId: z.number().int().positive().optional(),
    // Read by the handler; rawStockSensitiveInputGuard currently rejects it before this runs.
    dryRun: z.boolean().optional(),
    ...provenance,
  }),
} satisfies RequestSchemas;

// ── Recalculation (unguarded) ───────────────────────────────────────────────

export const mixBatchesPreviewInput = {
  query: emptyQuery,
  body: z.strictObject({
    containerIds: z.array(looseNumber).optional(),
    includeCompletedBatches: z.boolean().optional(),
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const partialOffloadScanApplyInput = {
  query: emptyQuery,
  body: z.union([
    z.undefined(),
    z.strictObject({ confirm: z.boolean().optional(), confirmationToken: z.string().optional(), clientRequestId }),
  ]),
} satisfies RequestSchemas;

export const supplierRateRestoreInput = {
  query: emptyQuery,
  body: z.strictObject({
    restorations: z.array(z.strictObject({ supplierId: optionalNumber, rate: optionalNumber })).optional(),
    clientRequestId,
  }),
} satisfies RequestSchemas;

// ── Historical replay ───────────────────────────────────────────────────────

/**
 * POST .../historical-replay/apply is registered four times; the first three
 * layers (phase 8 readiness, full-company scope, phase 6 guard) pass through
 * with next() and may rewrite supplierIds, forceSupplierIds,
 * includeCompletedBatches and includeFinalizedBales. This schema sits on the
 * terminal V4 handler and accepts everything those layers let through.
 */
export const historicalReplayApplyInput = {
  query: emptyQuery,
  body: z.strictObject({
    dryRun: z.boolean().optional(),
    confirmationToken: optionalText,
    supplierIds: z.array(looseNumber).optional(),
    forceSupplierIds: z.array(looseNumber).optional(),
    includeCompletedBatches: z.boolean().optional(),
    includeFinalizedBales: z.boolean().optional(),
    applyAuthorizationToken: z.string().optional(),
    productionReleaseId: z.string().optional(),
    algorithmVersion: z.unknown().optional(), // sent by client/src/lib/historicalReplayPreparedRequest.ts; not used (the signed token carries it)
    fingerprint: z.unknown().optional(), // sent by the same client helper; not used
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const adjustmentValuationBasisInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    valuationBasis: z.string().optional(),
    basisEvidence: z.string().optional(),
    clientRequestId,
  }),
} satisfies RequestSchemas;
