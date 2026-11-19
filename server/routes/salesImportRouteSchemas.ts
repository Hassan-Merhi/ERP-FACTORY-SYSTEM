// Request schemas for the POS sales import and credit sales import routes
// (registerPosImportRoutes.ts, registerCreditSalesImportRoutesPart1/2.ts).
//
// The client (client/src/pages/pos/posimport) round-trips lines: the parse
// endpoint emits them, validate echoes them back annotated, and import receives
// those annotated lines, USD-converted with the typed native price for non-USD
// sales. Every annotation is therefore accepted on validate and import.
import { z } from "zod";
import { emptyBody, emptyQuery, type RequestSchemas } from "../lib/validateRequest";

const numeric = z.union([z.number(), z.string()]);
const id = z.union([z.number(), z.string()]);

const importLine = z.strictObject({
  rowNum: numeric.nullable().optional(),
  barcode: z.union([z.string(), z.number()]).nullable().optional(),
  quantity: numeric.nullable().optional(),
  rate: numeric.nullable().optional(),
  value: numeric.nullable().optional(),
  // The typed ZMW/CFA price (toUsdItems); assertZmwImportPrices and
  // exactCfaSaleAmounts read it.
  originalCurrencyRate: numeric.nullable().optional(),
  // Annotations added by the validate endpoint.
  stockItemId: id.nullable().optional(),
  stockItemName: z.string().nullable().optional(),
  stockItemUom: z.string().nullable().optional(),
  costPrice: numeric.nullable().optional(),
  currentStock: numeric.nullable().optional(),
  remainingStock: numeric.nullable().optional(),
  error: z.string().nullable().optional(),
  warning: z.string().nullable().optional(),
  // Sent by tests/import-regression.test.ts and tests/body-id-tenant-scope.test.ts;
  // validate echoes them back, nothing reads them.
  sellingPrice: z.unknown().optional(),
  price: z.unknown().optional(),
});

// multer leaves only form fields in req.body; the client sends just the file.
export const salesImportParseInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

// The handlers keep their "Missing required fields" checks.
export const salesImportValidateInput = {
  query: emptyQuery,
  body: z.strictObject({
    locationId: id.nullable().optional(),
    saleDate: z.unknown().optional(), // sent by client/src/pages/pos/posimport/usePosImportModelPart2.ts; not used
    items: z.array(importLine).nullable().optional(),
  }),
} satisfies RequestSchemas;

const importFields = {
  locationId: id.nullable().optional(),
  saleDate: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  exchangeRate: numeric.nullable().optional(),
  items: z.array(importLine).nullable().optional(),
  // Request identity: resolveFinancialOperationKey / erpRequestSourceId read
  // clientRequestId; the voucher-path boundary keys deterministic replays on
  // importBatchId.
  clientRequestId: z.string().optional(),
  importBatchId: z.string().optional(),
};

export const posSalesImportInput = {
  query: emptyQuery,
  body: z.strictObject({ ...importFields, cashAccountId: id.nullable().optional() }),
} satisfies RequestSchemas;

export const creditSalesImportInput = {
  query: emptyQuery,
  body: z.strictObject({ ...importFields, customerId: id.nullable().optional() }),
} satisfies RequestSchemas;
