/**
 * Request schemas for the bale-product catalog and pending-barcode write
 * routes in baleProductRoutes.ts. The handlers still run their own
 * shared/schema insert parses (which supply the business messages); these
 * schemas only fix the accepted shape and reject unknown fields.
 */
import { z } from "zod";
import { emptyBody, stringIdParams, type RequestSchemas } from "../lib/validateRequest";

const optionalText = z.string().nullable().optional();

const pendingBarcodeFields = {
  barcode: z.string().optional(),
  category: optionalText,
  grade: optionalText,
  origin: optionalText,
  printed: z.boolean().optional(),
  used: z.boolean().optional(),
};

export const createPendingBarcodeInput = {
  body: z.strictObject(pendingBarcodeFields),
} satisfies RequestSchemas;

const importedBarcode = z.union([
  z.string(),
  z.strictObject({
    barcode: z.string().optional(),
    code: z.string().optional(),
    category: optionalText,
    grade: optionalText,
    origin: optionalText,
  }),
]);

export const importPendingBarcodesInput = {
  body: z.strictObject({ barcodes: z.array(importedBarcode).optional() }),
} satisfies RequestSchemas;

// storage.updatePendingBarcode writes the body as-is, so companyId is accepted
// (and written) today.
export const updatePendingBarcodeInput = {
  params: stringIdParams,
  body: z.strictObject({ ...pendingBarcodeFields, companyId: z.number().optional() }),
} satisfies RequestSchemas;

export const markBarcodesPrintedInput = {
  body: z.strictObject({ ids: z.array(z.number()) }),
} satisfies RequestSchemas;

export const deleteByIdInput = {
  params: stringIdParams,
  body: emptyBody,
} satisfies RequestSchemas;

export const createCategoryInput = {
  body: z.strictObject({ name: z.string(), isActive: z.boolean().optional() }),
} satisfies RequestSchemas;

// storage.updateBaleProductCategory writes the body as-is (companyId included).
export const updateCategoryInput = {
  params: stringIdParams,
  body: z.strictObject({
    name: z.string().optional(),
    isActive: z.boolean().optional(),
    companyId: z.number().optional(),
  }),
} satisfies RequestSchemas;

export const createBaleProductInput = {
  body: z.strictObject({
    itemNumber: z.union([z.number(), z.string()]).nullable().optional(),
    articleCode: z.string().nullable().optional(),
    code: z.string().nullable().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    weightPerBaleKg: z.string().optional(),
    categoryId: z.number().nullable().optional(),
    active: z.boolean().optional(),
  }),
} satisfies RequestSchemas;

// The handler parses with insertBaleProductSchema.partial(), which accepts companyId.
export const updateBaleProductInput = {
  params: stringIdParams,
  body: z.strictObject({
    companyId: z.number().optional(),
    code: z.string().optional(),
    articleCode: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    weightPerBaleKg: z.string().optional(),
    categoryId: z.number().nullable().optional(),
    active: z.boolean().optional(),
  }),
} satisfies RequestSchemas;

export const importBaleProductsExcelInput = { body: emptyBody } satisfies RequestSchemas;
