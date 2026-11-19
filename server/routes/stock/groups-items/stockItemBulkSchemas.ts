/**
 * Request schemas for the stock item bulk routes in ./bulk-ops.ts. The
 * handlers keep their own required-field checks and messages.
 */
import { z } from "zod";
import { emptyBody, emptyQuery, type RequestSchemas } from "../../../lib/validateRequest";

/** Ids are read with parseInt / Number. */
const idLike = z.union([z.number(), z.string()]);
const ids = z.array(idLike).optional();

export const bulkDeleteStockItemsInput = {
  query: emptyQuery,
  body: z.strictObject({ ids }),
} satisfies RequestSchemas;

export const bulkAssignCategoryInput = {
  query: emptyQuery,
  // categoryId null removes the category.
  body: z.strictObject({ ids, categoryId: idLike.nullable().optional() }),
} satisfies RequestSchemas;

export const bulkUpdatePricesInput = {
  query: emptyQuery,
  body: z.strictObject({
    prices: z
      .array(
        z.strictObject({
          barcode: z.string().nullable().optional(),
          sellingPrice: z.union([z.string(), z.number()]).nullable().optional(),
          locationId: idLike.nullable().optional(),
        })
      )
      .optional(),
  }),
} satisfies RequestSchemas;

/** Amounts go through toMoney; a non-string barcode is skipped by the handler. */
const openingAmount = z.union([z.string(), z.number()]).nullable().optional();
export const importOpeningBalancesInput = {
  query: emptyQuery,
  body: z.strictObject({
    openingBalances: z
      .array(
        z.strictObject({
          barcode: z.union([z.string(), z.number()]).nullable().optional(),
          openingQty: openingAmount,
          openingRate: openingAmount,
          openingValue: openingAmount,
        })
      )
      .optional(),
  }),
} satisfies RequestSchemas;

export const bulkUpdateUomInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export const bulkRenameInput = {
  query: emptyQuery,
  body: z.strictObject({
    findText: z.string().optional(),
    replaceWith: z.string().optional(),
    itemIds: ids,
    wholeWordOnly: z.boolean().optional(),
    caseInsensitive: z.boolean().optional(),
  }),
} satisfies RequestSchemas;
