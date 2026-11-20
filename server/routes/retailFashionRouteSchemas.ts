// Request schemas for the retail fashion write routes (registerRetailFashionRoutes.ts).
// The handlers still parse with retailQuickAddSchema / labelRequestSchema; these
// are the same shapes made strict at every depth, so re-parsing is a no-op.
import { z } from "zod";
import { emptyQuery, idParams, type RequestSchemas } from "../lib/validateRequest";
import { labelRequestSchema, retailQuickAddSchema } from "./validateQuickAddVariants";

export const retailQuickAddInput = {
  query: emptyQuery,
  body: retailQuickAddSchema
    .extend({ variants: z.array(retailQuickAddSchema.shape.variants.element.strict()).min(1).max(100) })
    .strict(),
} satisfies RequestSchemas;

export const retailLabelsInput = {
  query: emptyQuery,
  body: labelRequestSchema
    .extend({ items: z.array(labelRequestSchema.shape.items.element.strict()).min(1).max(500) })
    .strict(),
} satisfies RequestSchemas;

/** Archive / restore a variant or a product. */
export const retailActiveInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ active: z.boolean() }),
} satisfies RequestSchemas;
