/**
 * Request schemas for the credit/debit note write routes. Shapes only: the
 * handlers keep their own required-field, item and currency checks (and their
 * messages), so most fields are optional here and numbers may arrive as
 * strings, which the handlers convert with toInventoryDecimal/Number.
 */
import { z } from "zod";
import { emptyQuery, stringParam, type RequestSchemas } from "../lib/validateRequest";

const numeric = z.union([z.number(), z.string()]);
const optionalNumeric = numeric.nullable().optional();

const noteItem = z.strictObject({
  stockItemId: optionalNumeric,
  locationId: optionalNumeric,
  quantity: optionalNumeric,
  refundRate: optionalNumeric,
  /** Fallback for refundRate/inventoryCost on create and in the edit audit. */
  rate: optionalNumeric,
  inventoryCost: optionalNumeric,
  /** The Kwacha price entered for a ZMW refund (checked by assertZmwImportPrices). */
  originalCurrencyRate: optionalNumeric,
});

const noteFields = {
  voucherDate: z.string().optional(),
  cashAccountId: optionalNumeric,
  cashAccountType: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  exchangeRate: optionalNumeric,
  items: z.array(noteItem).nullable().optional(),
};

export const createCreditNoteInput = {
  query: emptyQuery,
  body: z.strictObject({
    noteType: z.string().optional(),
    ...noteFields,
    /** Retry identity read by the voucher-path request boundary. */
    clientRequestId: z.string().optional(),
  }),
} satisfies RequestSchemas;

export const updateCreditNoteInput = {
  params: z.strictObject({ id: stringParam }),
  query: emptyQuery,
  body: z.strictObject({
    ...noteFields,
    // Ignored on edit: the handler keeps the stored voucher's type. Callers that
    // reuse the create payload (tests/phase22b-erp-writers-engine.test.ts) send it.
    noteType: z.unknown().optional(),
  }),
} satisfies RequestSchemas;
