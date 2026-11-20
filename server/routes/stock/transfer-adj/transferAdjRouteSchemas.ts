/**
 * Request schemas for the stock-item write routes in this folder
 * (item-write.ts, code-aliases.ts, imports.ts, price-groups.ts). Handlers keep
 * their own checks and messages (per-row import errors included); these
 * schemas fix the accepted shape and reject unknown fields.
 */
import { z } from "zod";
import { emptyBody, stringIdParams, type RequestSchemas } from "../../../lib/validateRequest";

const idValue = z.union([z.number(), z.string()]);
const text = z.union([z.string(), z.number()]);
const notUsed = z.unknown().optional();

/** PATCH /api/stock-items/:id */
export const updateStockItemInput = {
  params: stringIdParams,
  body: z.strictObject({
    code: text.optional(),
    name: text.optional(),
    uom: text.optional(),
    stockGroupId: idValue.nullable().optional(),
    sellingPrice: text.nullable().optional(),
    active: z.boolean().optional(),
    gradeId: idValue.nullable().optional(),
    categoryId: idValue.nullable().optional(),
    // stock_items has no barcode column; the handler ignores it (see item-write.ts).
    barcode: notUsed, // sent by client/src/components/StockItemEditDialog.tsx and stockitemdetailsdialog; not used
  }),
} satisfies RequestSchemas;

/** DELETE /api/stock-items/:id, DELETE /api/stock-item-code-aliases/:id */
export const deleteByIdInput = { params: stringIdParams, body: emptyBody } satisfies RequestSchemas;

/** POST /api/stock-items/:id/code-aliases (the handler parses insertStockItemCodeAliasSchema itself). */
export const createCodeAliasInput = {
  params: stringIdParams,
  body: z.strictObject({ aliasCode: z.string().optional(), description: z.string().optional() }),
} satisfies RequestSchemas;

/**
 * POST /api/stock-items/import: each item is spread into insertStockItemSchema
 * (with the session company), and a row it cannot accept becomes a per-row
 * error, so the item fields stay loose here.
 */
export const importStockItemsInput = {
  body: z.strictObject({
    items: z
      .array(
        z.strictObject({
          code: z.string().optional(),
          name: z.string().optional(),
          uom: z.string().optional(),
          stockGroupId: idValue.nullable().optional(),
          gradeId: idValue.nullable().optional(),
          categoryId: idValue.nullable().optional(),
          openingQty: text.nullable().optional(),
          openingRate: text.nullable().optional(),
          openingValue: text.nullable().optional(),
          reorderLevel: text.nullable().optional(),
          sellingPrice: text.nullable().optional(),
          active: z.boolean().optional(),
          companyId: notUsed, // sent by client/src/pages/useNewItemsTabState.ts; replaced by the session company
        })
      )
      .optional(),
  }),
} satisfies RequestSchemas;

export const importBarcodesInput = {
  body: z.strictObject({
    rows: z
      .array(z.strictObject({ itemCode: z.string().nullable().optional(), barcode: z.string().nullable().optional() }))
      .optional(),
  }),
} satisfies RequestSchemas;

export const updateCategoriesInput = {
  body: z.strictObject({
    rows: z
      .array(z.strictObject({ itemCode: text.nullable().optional(), categoryName: text.nullable().optional() }))
      .optional(),
  }),
} satisfies RequestSchemas;

/** POST /api/stock-items/import-grade-category-template: multipart, the file only. */
export const importGradeCategoryTemplateInput = { body: emptyBody } satisfies RequestSchemas;

/** PUT /api/location-price-groups */
export const replacePriceGroupsInput = {
  body: z.strictObject({
    groups: z
      .array(z.strictObject({ masterLocationId: z.number(), followerLocationIds: z.array(z.number()) }))
      .optional(),
  }),
} satisfies RequestSchemas;
