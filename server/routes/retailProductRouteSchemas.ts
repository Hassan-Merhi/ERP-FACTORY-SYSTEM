// Request schemas for the retail brand and product write routes
// (registerRetailRoutesPart1.ts). The product handlers still parse with
// retailProductWriteSchema; this is the same shape made strict at every depth.
import { z } from "zod";
import { retailProductWriteSchema, retailVariantInputSchema } from "@shared/schema";
import { emptyQuery, idParams, type RequestSchemas } from "../lib/validateRequest";

const retailVariantStock = z.strictObject({
  locationId: z.number().int().positive(),
  quantity: z.coerce.number().finite(),
  expectedQuantity: z.coerce.number().finite().optional(),
});

const retailProductBody = retailProductWriteSchema
  .extend({
    variants: z
      .array(retailVariantInputSchema.extend({ stocks: z.array(retailVariantStock).optional().default([]) }).strict())
      .min(1),
  })
  .strict();

// The handler keeps its "Brand name is required" check.
export const createRetailBrandInput = {
  query: emptyQuery,
  body: z.strictObject({ name: z.string().nullable().optional() }),
} satisfies RequestSchemas;

export const createRetailProductInput = { query: emptyQuery, body: retailProductBody } satisfies RequestSchemas;

export const updateRetailProductInput = {
  params: idParams,
  query: emptyQuery,
  body: retailProductBody,
} satisfies RequestSchemas;
