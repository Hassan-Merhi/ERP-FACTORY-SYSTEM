/**
 * validateRequest schemas for the Factory loading-dispatch lifecycle and
 * financial write routes (close/reopen, trip charges, trip finalize/reverse,
 * ERP PO export, all-truck reconciliation and the combined invoice).
 *
 * These only check the request shape. Every handler keeps its own business
 * checks (confirm === true, 64-hex fingerprints, reason length, positive ids)
 * and their coded refusals.
 */
import { z } from "zod";
import { emptyQuery, stringParam, type RequestSchemas } from "../../../lib/validateRequest";

// The handlers parse :id / :dispatchId / :chargeId themselves (after the
// Factory access check) and answer their own coded 400 for a bad id.
const orderParams = z.strictObject({ id: stringParam });
const dispatchParams = z.strictObject({ id: stringParam, dispatchId: stringParam });
const chargeParams = z.strictObject({ id: stringParam, dispatchId: stringParam, chargeId: stringParam });

// Ids and amounts go through Number(...) / String(...) in the handlers.
const numberLike = z.union([z.number(), z.string()]);

export const closeDispatchInput = {
  params: dispatchParams,
  query: emptyQuery,
  body: z.strictObject({
    confirm: z.boolean().optional(),
    fingerprint: z.string().optional(),
    discrepancyReason: z.string().nullable().optional(),
  }),
} satisfies RequestSchemas;

export const reopenDispatchInput = {
  params: dispatchParams,
  query: emptyQuery,
  body: z.strictObject({ reason: z.string().optional() }),
} satisfies RequestSchemas;

const chargeFingerprints = {
  expectedChargeFingerprint: z.string().optional(),
  expectedSourceFingerprint: z.string().optional(),
};

// validChargeInput (loadingDispatchFinancialChargeModel.ts) checks values.
const tripCharge = z.strictObject({
  name: z.string(),
  kind: z.string(),
  amount: numberLike,
  ledgerAccountId: numberLike,
  offsetLedgerAccountId: numberLike.nullable().optional(),
  erpChargeType: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const createTripChargeInput = {
  params: dispatchParams,
  query: emptyQuery,
  body: z.strictObject({ ...chargeFingerprints, charge: tripCharge }),
} satisfies RequestSchemas;

export const updateTripChargeInput = {
  params: chargeParams,
  query: emptyQuery,
  body: z.strictObject({ ...chargeFingerprints, charge: tripCharge }),
} satisfies RequestSchemas;

export const deleteTripChargeInput = {
  params: chargeParams,
  query: emptyQuery,
  body: z.strictObject(chargeFingerprints),
} satisfies RequestSchemas;

export const finalizeTripFinancialInput = {
  params: dispatchParams,
  query: emptyQuery,
  body: z.strictObject({
    confirm: z.boolean().optional(),
    sourceFingerprint: z.string().optional(),
    chargeFingerprint: z.string().optional(),
  }),
} satisfies RequestSchemas;

export const reverseTripFinancialInput = {
  params: dispatchParams,
  query: emptyQuery,
  body: z.strictObject({ confirm: z.boolean().optional(), reason: z.string().optional() }),
} satisfies RequestSchemas;

// buildTripPoExport (loadingDispatchPoExportModel.ts) validates every value.
const poChoice = z.strictObject({
  supplierCode: z.string(),
  rates: z.array(z.strictObject({ articleCode: z.string(), rate: z.string() })),
  charges: z.strictObject({
    freight: z.string(),
    surcharge: z.string(),
    fumigation: z.string(),
    discount: z.string(),
    documentCharges: z.string(),
  }),
});
const poPreviewFields = {
  expectedSourceFingerprint: z.string().optional(),
  expectedRevision: z.number().optional(),
  choice: poChoice,
};

export const poExportPreviewInput = {
  params: dispatchParams,
  query: emptyQuery,
  body: z.strictObject(poPreviewFields),
} satisfies RequestSchemas;

export const poExportDownloadInput = {
  params: dispatchParams,
  query: emptyQuery,
  body: z.strictObject({
    ...poPreviewFields,
    expectedExportFingerprint: z.string().optional(),
    confirmRatesReviewed: z.boolean().optional(),
    confirmChargesReviewed: z.boolean().optional(),
  }),
} satisfies RequestSchemas;

export const removeUnshippedInput = {
  params: orderParams,
  query: emptyQuery,
  body: z.strictObject({
    confirm: z.boolean().optional(),
    orderBaleIds: z.array(numberLike).optional(),
    expectedFingerprint: z.string().optional(),
    reason: z.string().optional(),
  }),
} satisfies RequestSchemas;

export const approveReconciliationInput = {
  params: orderParams,
  query: emptyQuery,
  body: z.strictObject({
    confirm: z.boolean().optional(),
    expectedFingerprint: z.string().optional(),
    reason: z.string().optional(),
  }),
} satisfies RequestSchemas;

export const finalizeCombinedInvoiceInput = {
  params: orderParams,
  query: emptyQuery,
  body: z.strictObject({
    confirm: z.boolean().optional(),
    confirmNoDuplicateReceivable: z.boolean().optional(),
    confirmTripChargesReviewed: z.boolean().optional(),
    expectedFingerprint: z.string().optional(),
    reason: z.string().optional(),
  }),
} satisfies RequestSchemas;
