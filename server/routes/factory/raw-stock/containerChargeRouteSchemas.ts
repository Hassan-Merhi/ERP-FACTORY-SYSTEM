/**
 * Request schemas for the factory container cost routes: duty confirmation,
 * post-offload charges (preview, create, edit, undo, legacy rebuild) and the
 * offload reversal.
 *
 * Amounts, ids and versions are read with parseMoneyInput/parseInt, so callers
 * send numbers or numeric strings. Fields whose absence the handler answers
 * with its own message stay optional so that message is kept.
 */
import { z } from "zod";
import { emptyQuery, idParams, positiveIntParam, type RequestSchemas } from "../../../lib/validateRequest";

const looseNumber = z.union([z.number(), z.string()]);
const optionalNumber = looseNumber.nullable().optional();
const optionalText = z.string().nullable().optional();

const chargeParams = z.strictObject({ id: positiveIntParam, chargeId: positiveIntParam });

// client/src/pages/factory/factory-containers/PostOffloadDialogDialogSection.tsx
// sends { txDate, charges: [{ description, amount, currencyCode, ledgerAccountId, supplierId }] }.
const chargeItem = z.strictObject({
  description: optionalText,
  amount: optionalNumber,
  currencyCode: optionalText,
  ledgerAccountId: optionalNumber,
  supplierId: optionalNumber,
});

const chargeListFields = {
  // The handlers answer a missing or empty list with their own message.
  charges: z.array(chargeItem).optional(),
  txDate: optionalText,
};

export const confirmDutyInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ dutyAmount: optionalNumber, dutyNotes: optionalText, txDate: optionalText }),
} satisfies RequestSchemas;

export const previewPostOffloadChargesInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject(chargeListFields),
} satisfies RequestSchemas;

export const createPostOffloadChargesInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    ...chargeListFields,
    // Added by client/src/lib/factoryApi.ts after the read-only preview;
    // checked by requirePostOffloadImpactPreview before this route runs.
    impactPreviewVersion: optionalNumber,
    impactPreviewToken: optionalText,
  }),
} satisfies RequestSchemas;

// client/src/pages/factory/factory-containers/usePostOffloadDialogState.ts handleSaveEdit.
export const editPostOffloadChargeInput = {
  params: chargeParams,
  query: emptyQuery,
  body: z.strictObject({
    description: optionalText,
    amount: optionalNumber,
    currencyCode: optionalText,
    ledgerAccountId: optionalNumber,
    supplierId: optionalNumber,
    txDate: optionalText,
    expectedVersion: optionalNumber,
    legacyBaselineRate: optionalNumber,
  }),
} satisfies RequestSchemas;

// usePostOffloadDialogState.ts handleConfirmUndo sends { undoDate, expectedVersion, legacyBaselineRate? }.
export const undoPostOffloadChargeInput = {
  params: chargeParams,
  query: emptyQuery,
  body: z
    .strictObject({ undoDate: optionalText, expectedVersion: optionalNumber, legacyBaselineRate: optionalNumber })
    .optional(),
} satisfies RequestSchemas;

// usePostOffloadDialogState.ts handleLegacyRebuild sends { legacyBaselineRate, expectedVersion }.
export const legacyRebuildPostOffloadChargeInput = {
  params: chargeParams,
  query: emptyQuery,
  body: z.strictObject({ legacyBaselineRate: optionalNumber, expectedVersion: optionalNumber }).optional(),
} satisfies RequestSchemas;

// client/src/pages/factory/factory-containers/ContainerDialogs.tsx sends {}; the fetch
// guard adds the Phase 5 `clientRequestId` the durable reversal replays on.
export const reverseOffloadInput = {
  params: idParams,
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({ clientRequestId: z.string().optional() })]),
} satisfies RequestSchemas;
