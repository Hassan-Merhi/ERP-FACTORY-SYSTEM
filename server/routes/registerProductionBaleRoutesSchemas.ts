// Request schemas for the production bale write routes
// (registerProductionBaleRoutesPart2.ts and registerProductionBaleRoutesPart3.ts).
import { z } from "zod";
import { insertProductionBaleSchema } from "@shared/schema";
import { emptyBody, emptyQuery, stringParam, type RequestSchemas } from "../lib/validateRequest";

const looseNumber = z.union([z.number(), z.string()]);
/** The handlers parse the body with insertProductionBaleSchema after setting companyId from the session. */
const productionBaleBody = insertProductionBaleSchema.omit({ companyId: true }).strict();
/** parseInt(req.params.id): any string reaches the handler, which answers 400 for NaN. */
const baleIdParams = z.strictObject({ id: stringParam });

export const finalizeInput = {
  query: emptyQuery,
  body: z.strictObject({
    pressingBatchId: looseNumber.nullable().optional(),
    scannedBaleIds: z.array(looseNumber).optional(),
    locationId: looseNumber.nullable().optional(),
    mixBatchId: looseNumber.nullable().optional(),
  }),
} satisfies RequestSchemas;
export const createInput = { query: emptyQuery, body: productionBaleBody } satisfies RequestSchemas;
export const bulkCreateInput = {
  query: emptyQuery,
  body: z.strictObject({ bales: z.array(productionBaleBody).nullable().optional() }),
} satisfies RequestSchemas;
export const scanInput = {
  query: emptyQuery,
  body: z.strictObject({
    barcodeValue: z.string().optional(),
    weightKg: looseNumber.optional(),
    category: z.string().optional(),
    grade: z.string().optional(),
    warehouseLocation: z.string().nullable().optional(),
  }),
} satisfies RequestSchemas;
export const generateBarcodeInput = {
  query: emptyQuery,
  body: z.strictObject({ text: z.union([z.string(), z.number()]).optional() }),
} satisfies RequestSchemas;
export const deleteInput = { params: baleIdParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;
export const statusInput = {
  params: baleIdParams,
  query: emptyQuery,
  body: z.strictObject({ status: z.string().optional() }),
} satisfies RequestSchemas;
