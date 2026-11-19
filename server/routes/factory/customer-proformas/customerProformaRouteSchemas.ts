/**
 * Request schemas for the customer proforma, proforma line and customer price
 * list write routes.
 *
 * Fields whose absence the handler answers with its own message stay optional
 * so that message is kept. Quantities and prices are read with parseInt,
 * String() or parseMoneyInput, so callers send numbers or numeric strings.
 */
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  idParams,
  positiveIntParam,
  stringParam,
  type RequestSchemas,
} from "../../../lib/validateRequest";
import { insertCustomerProformaLineSchema, insertCustomerProformaSchema } from "@shared/schema";

const looseNumber = z.union([z.number(), z.string()]);
const optionalNumber = looseNumber.nullable().optional();
const optionalText = z.string().nullable().optional();

/** Bodyless action routes: callers send `{}` or nothing. */
const actionInput = { params: idParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

// ── Proformas ──────────────────────────────────────────────────────────────

// client/src/pages/factory/factoryproformas/useFactoryProformasModelPart4.ts sends
// { customerId, name, destination, isActive }. The handler parses the same insert
// schema with the session company, so companyId is not a body field.
export const createProformaInput = {
  query: emptyQuery,
  body: insertCustomerProformaSchema.omit({ companyId: true }).strict(),
} satisfies RequestSchemas;

// useFactoryProformasModelPart2.ts sends { isActive }, { destination } or { name };
// useEditProformaV5DrawerState.ts sends { name, destination, isActive }.
export const updateProformaInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    name: z.string().optional(),
    isActive: z.boolean().optional(),
    // null reaches the handler's "A valid destination is required".
    destination: optionalText,
  }),
} satisfies RequestSchemas;

export const deleteProformaInput = actionInput;

// useFactoryProformasModelPart2.ts sends { targetCustomerId }.
export const transferProformaInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ targetCustomerId: optionalNumber }),
} satisfies RequestSchemas;

// useFactoryProformasModelPart1.ts sends { locationId }.
export const createLoadingInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ locationId: optionalNumber, orderDate: optionalText }),
} satisfies RequestSchemas;

export const applyAgreedPricesInput = actionInput;
export const applyCatalogPricesInput = actionInput;
export const applyProductionPricesInput = actionInput;

/** A line of the bulk create and replace-lines bodies; the handler skips incomplete lines. */
const replaceLineItem = z.strictObject({
  articleCode: optionalText,
  productName: optionalText,
  quantity: optionalNumber,
  pricePerBale: optionalNumber,
  pricingMode: optionalText,
  pricePerKg: optionalNumber,
});

// Callers: CreateProformaDrawerModel.ts, useCustomerLoadingStatePart2.ts,
// useFactoryLocationInventoryPart2.ts and the Excel import in useFactoryProformasModelPart3.ts.
export const bulkCreateProformaInput = {
  query: emptyQuery,
  body: z.strictObject({
    customerId: z.number().optional(),
    name: z.string().optional(),
    // null reaches the handler's "Invalid proforma destination".
    destination: optionalText,
    isActive: z.boolean().optional(),
    lines: z.array(replaceLineItem.extend({ productionPricePerBale: optionalNumber }).strict()).optional(),
  }),
} satisfies RequestSchemas;

// useFactoryLocationInventoryPart2.ts sends { lines: [{ articleCode, productName, quantity, pricePerBale }] }.
export const replaceProformaLinesInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ lines: z.array(replaceLineItem).optional() }),
} satisfies RequestSchemas;

// ── Proforma lines ─────────────────────────────────────────────────────────

// The handler parses insertCustomerProformaLineSchema. Callers:
// useFactoryProformasModelPart4.ts, useEditProformaV5DrawerState.ts, useProformaAddLineState.ts.
export const createProformaLineInput = {
  query: emptyQuery,
  body: insertCustomerProformaLineSchema
    .extend({
      weightPerBaleKg: z.unknown().optional(), // sent by client/src/pages/factory/useProformaAddLineState.ts; not used
    })
    .strict(),
} satisfies RequestSchemas;

// useFactoryProformasModelPart2.ts sends { pricePerBale, productName, quantity, weightPerBaleKg? }
// or { quantity }; useEditProformaV5DrawerState.ts sends { quantity, pricePerBale, pricingMode, pricePerKg }.
export const updateProformaLineInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    productName: z.string().optional(),
    quantity: looseNumber.optional(),
    pricePerBale: looseNumber.optional(),
    pricingMode: z.string().optional(),
    pricePerKg: optionalNumber,
    weightPerBaleKg: looseNumber.optional(),
  }),
} satisfies RequestSchemas;

export const deleteProformaLineInput = actionInput;

export const toggleProformaLineFixedInput = {
  params: z.strictObject({ lineId: positiveIntParam }),
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

// ── Customer price lists ───────────────────────────────────────────────────
// The handlers parseInt the customer and proforma ids and answer NaN themselves.

const destinationQuery = z.strictObject({ destination: z.string().optional() });

export const priceListFromProformaInput = {
  params: z.strictObject({ customerId: stringParam, proformaId: stringParam }),
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

// client/src/pages/factory/useFactoryCustomerStatementStatePart1.ts sends [{ articleCode, pricePerBale }].
export const savePriceListInput = {
  params: z.strictObject({ customerId: stringParam }),
  query: destinationQuery,
  body: z.array(z.strictObject({ articleCode: optionalText, pricePerBale: optionalNumber })),
} satisfies RequestSchemas;

export const deletePriceListEntryInput = {
  params: z.strictObject({ customerId: stringParam, articleCode: stringParam }),
  query: destinationQuery,
  body: emptyBody,
} satisfies RequestSchemas;
