/**
 * Request schemas for the rental write routes. registerRentalRoutes mounts
 * every route once per prefix (/api/properties/rental, /api/erp/rental and
 * /api/factory/rental), so each schema here covers all three.
 *
 * Every write under those prefixes is a Phase 5 operational voucher request
 * (shared/voucherPathIdentityPolicy.ts): the browser fetch guard
 * (client/src/lib/accountingRequestFetchGuard.ts) adds a `clientRequestId` to
 * the JSON body, bodyless POSTs and DELETEs included, and the voucher-path
 * boundary reads it as the request identity (or the X-Idempotency-Key header).
 * Every body schema therefore declares it.
 */
import { z } from "zod";
import { insertPropertyContractSchema, insertPropertyUnitSchema } from "@shared/schema";
import { emptyQuery, idParams, positiveIntParam, stringParam, type RequestSchemas } from "../../lib/validateRequest";

/** Phase 5 request identity added by the client fetch guard. */
const clientRequestId = z.string().optional();
/** Bodyless writes: no body (tests, scripts) or the fetch guard's `{ clientRequestId }`. */
const identityOnlyBody = z.union([z.undefined(), z.strictObject({ clientRequestId })]);
/** Amounts the handlers keep as decimal strings: callers send strings or numbers. */
const amountText = z.union([z.string(), z.number()]).transform((value) => String(value));
/** The posting services' own request-id rule for rental payments. */
const paymentRequestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .optional();

const actionInput = { query: emptyQuery, body: identityOnlyBody } satisfies RequestSchemas;

// ── Units ───────────────────────────────────────────────────────────────────

/** The handler re-parses insertPropertyUnitSchema with the session company; module comes from the prefix. */
export const createUnitInput = {
  query: emptyQuery,
  body: insertPropertyUnitSchema.omit({ companyId: true, module: true }).extend({ clientRequestId }).strict(),
} satisfies RequestSchemas;

export const updateUnitInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    // renameGroup: true renames the location heading of every matching unit.
    renameGroup: z.boolean().optional(),
    unitNumber: z.string().optional(),
    size: z.string().nullable().optional(),
    dimensions: z.string().nullable().optional(),
    locationGroup: z.string().optional(),
    notes: z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
    active: z.boolean().optional(),
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const deleteUnitInput = { params: idParams, ...actionInput } satisfies RequestSchemas;

// ── Contracts ───────────────────────────────────────────────────────────────

/** The handler re-parses insertPropertyContractSchema with the session company; module comes from the prefix. */
export const createContractInput = {
  query: emptyQuery,
  body: insertPropertyContractSchema.omit({ companyId: true, module: true }).extend({ clientRequestId }).strict(),
} satisfies RequestSchemas;

export const modifyRentInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    newAmount: amountText,
    effectiveFrom: z.enum(["current", "next"]).default("current"),
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const editContractInfoInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    tenantName: z.string().min(1),
    startDate: z.string().min(1),
    guaranteeAmount: z.string().optional(),
    guaranteePeriod: z.string().optional(),
    isInternal: z.boolean().optional(),
    linkedCompanyId: z.number().nullable().optional(),
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const contractNoteInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ notes: z.string(), clientRequestId }),
} satisfies RequestSchemas;

export const contractStatementNoteInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ statementNote: z.string(), clientRequestId }),
} satisfies RequestSchemas;

export const endContractInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    endDate: z.string().min(1),
    notes: z.string().optional(),
    refundGuarantee: z.boolean().optional().default(false),
    refundAmount: amountText.optional(),
    refundCashAccountId: z.number().nullable().optional(),
    refundNotes: z.string().optional(),
    clientRequestId,
  }),
} satisfies RequestSchemas;

// ── Guarantees ──────────────────────────────────────────────────────────────

export const guaranteeToStatementInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    amount: amountText,
    cashAccountId: z.number().nullable().optional(),
    paymentDate: z.string().optional(),
    notes: z.string().optional(),
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const resetGuaranteeToStatementInput = { params: idParams, ...actionInput } satisfies RequestSchemas;

/** erpRequestSourceId(req) reads body.clientRequestId as the voucher source identity. */
export const guaranteeToCashInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    amount: amountText,
    cashAccountId: z.number(),
    paymentDate: z.string().optional(),
    notes: z.string().optional(),
    clientRequestId,
  }),
} satisfies RequestSchemas;

/** erpRequestSourceId(req) reads body.clientRequestId as the voucher source identity. */
export const guaranteeToRentInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    amount: amountText,
    paymentDate: z.string().min(1),
    notes: z.string().optional(),
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const undoGuaranteeAsRentInput = { params: idParams, ...actionInput } satisfies RequestSchemas;

// ── Payments and accruals ───────────────────────────────────────────────────

const paymentFields = {
  contractId: z.number(),
  cashAccountId: z.number().nullable().optional(),
  amount: amountText,
  paymentDate: z.string().min(1),
  notes: z.string().optional(),
  currency: z.string().optional().default("USD"),
  // Phase 19 (B), PE2: not used for posting (the recorded dated rate is).
  exchangeRate: amountText.optional(),
  scheduleFuturePayment: z.boolean().optional().default(false),
  clientRequestId: paymentRequestId,
};

export const createPaymentInput = {
  query: emptyQuery,
  body: z.strictObject(paymentFields),
} satisfies RequestSchemas;

const bulkPaymentItems = z.array(z.strictObject(paymentFields)).min(1);

/**
 * Current callers send `{ items }` so the fetch guard can attach the top-level
 * clientRequestId; older callers sent the bare array with the identity header.
 */
export const bulkPaymentInput = {
  query: emptyQuery,
  body: z.union([bulkPaymentItems, z.strictObject({ items: bulkPaymentItems, clientRequestId })]),
} satisfies RequestSchemas;

export const deletePaymentInput = { params: idParams, ...actionInput } satisfies RequestSchemas;

export const cancelScheduledPaymentGroupInput = {
  params: z.strictObject({ groupId: stringParam }),
  ...actionInput,
} satisfies RequestSchemas;

/** POST cashbox/ensure, accrue, payments/post-scheduled, run-monthly and re-accrue take no input. */
export const rentalActionInput = actionInput;

export const reverseAccrualInput = {
  params: z.strictObject({ rowId: positiveIntParam }),
  ...actionInput,
} satisfies RequestSchemas;

export const createAutoTransferConfigInput = {
  query: emptyQuery,
  body: z.strictObject({
    destCompanyId: z.number().min(1),
    destLedgerAccountId: z.number().min(1),
    sourceCashAccountIds: z.array(z.number()).default([]),
    enabled: z.boolean().default(true),
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const deleteAutoTransferConfigInput = { params: idParams, ...actionInput } satisfies RequestSchemas;

// ── Owner / Admin tools scoped by resolveRequestCompanyId ───────────────────

/**
 * resolveRequestCompanyId(req) reads body.companyId or query.companyId and
 * refuses one that is not the session's company.
 */
const requestCompanyId = z.union([z.number(), z.string()]).nullable().optional();
const companyScopedQuery = z.strictObject({ companyId: z.string().optional() });

export const postDueRentalInput = {
  query: companyScopedQuery,
  body: z.union([z.undefined(), z.strictObject({ companyId: requestCompanyId, clientRequestId })]),
} satisfies RequestSchemas;

/** The handlers keep their own "confirm must be true" and plan-hash checks. */
export const applyReviewedPlanInput = {
  query: companyScopedQuery,
  body: z.strictObject({
    confirm: z.boolean().optional(),
    planHash: z.string().optional(),
    companyId: requestCompanyId,
    clientRequestId,
  }),
} satisfies RequestSchemas;
