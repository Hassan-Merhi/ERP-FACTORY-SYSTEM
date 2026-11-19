/**
 * Request schemas for the factory bale-product write routes
 * (productWriteRoutes.ts, productBulkRoutes.ts, productCascadeRoutes.ts,
 * productImageRoutes.ts). Handlers keep their own business checks and
 * messages; these schemas fix the accepted shape and reject unknown fields.
 */
import { z } from "zod";
import { emptyBody, stringIdParams, type RequestSchemas } from "../../../lib/validateRequest";

const idValue = z.union([z.number(), z.string()]);
const numericText = z.union([z.number(), z.string()]);
const notUsed = z.unknown().optional();

/** POST /api/factory/bale-products */
export const createFactoryProductInput = {
  body: z.strictObject({
    name: z.string().optional(),
    code: z.string().nullable().optional(),
    articleCode: z.string().nullable().optional(),
    grade: z.string().nullable().optional(),
    active: z.boolean().optional(),
    description: z.string().nullable().optional(),
    weightPerBaleKg: numericText.nullable().optional(),
    categoryId: idValue.nullable().optional(),
    sellingPrice: numericText.nullable().optional(),
    productionPrice: numericText.nullable().optional(),
    labelDesignColor: z.string().nullable().optional(),
    adminAuth: z.strictObject({ username: z.string(), password: z.string() }).optional(),
    nameEn: notUsed, // sent by client/src/components/CreateBaleProductDialog.tsx; not used
    nameAr: notUsed, // sent by client/src/components/CreateBaleProductDialog.tsx; not used
    descriptionEn: notUsed, // sent by client/src/components/CreateBaleProductDialog.tsx; not used
    descriptionAr: notUsed, // sent by client/src/components/CreateBaleProductDialog.tsx; not used
  }),
} satisfies RequestSchemas;

/**
 * PATCH /api/factory/bale-products/:id writes the body straight into
 * factory_bale_products (scoped to the session company), so every column of
 * that table is accepted, companyId included.
 */
export const updateFactoryProductInput = {
  params: stringIdParams,
  body: z.strictObject({
    companyId: z.number().optional(),
    code: z.string().optional(),
    articleCode: z.string().nullable().optional(),
    name: z.string().optional(),
    nameAr: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    descriptionAr: z.string().nullable().optional(),
    weightPerBaleKg: numericText.nullable().optional(),
    categoryId: idValue.nullable().optional(),
    sellingPrice: numericText.nullable().optional(),
    productionPrice: numericText.nullable().optional(),
    labelDesignColor: z.string().nullable().optional(),
    active: z.boolean().optional(),
    deletedAt: z.null().optional(),
  }),
} satisfies RequestSchemas;

/** POST /api/factory/bale-products/:id/cascade-update */
export const cascadeUpdateInput = {
  params: stringIdParams,
  body: z.strictObject({
    name: z.string().nullable().optional(),
    weightPerBaleKg: numericText.nullable().optional(),
    articleCode: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    categoryId: idValue.nullable().optional(),
    grade: z.string().nullable().optional(),
    productionPrice: numericText.nullable().optional(),
    sellingPrice: numericText.nullable().optional(),
    labelDesignColor: z.string().nullable().optional(),
  }),
} satisfies RequestSchemas;

/** DELETE /api/factory/bale-products/:id, DELETE /api/factory/bale-product-images/:id */
export const deleteFactoryByIdInput = { params: stringIdParams, body: emptyBody } satisfies RequestSchemas;

export const bulkToggleActiveInput = {
  body: z.strictObject({ ids: z.array(idValue).optional(), active: z.boolean().optional() }),
} satisfies RequestSchemas;

export const bulkRenamePreviewInput = {
  body: z.strictObject({
    codePrefix: z.string().optional(),
    find: z.string().optional(),
    replace: z.string().optional(),
  }),
} satisfies RequestSchemas;

export const bulkRenameApplyInput = {
  body: z.strictObject({
    items: z
      .array(
        z.strictObject({
          id: idValue,
          newName: z.string().optional(),
          code: notUsed, // sent by client/src/pages/factory/factorysettings (preview row); not used
          currentName: notUsed, // sent by client/src/pages/factory/factorysettings (preview row); not used
        })
      )
      .optional(),
  }),
} satisfies RequestSchemas;

export const mergeProductsInput = {
  body: z.strictObject({ targetId: idValue.optional(), sourceIds: z.array(idValue).optional() }),
} satisfies RequestSchemas;

export const bulkUpdatePricesInput = {
  body: z.strictObject({
    prices: z
      .array(
        z.strictObject({
          id: idValue.nullable().optional(),
          sellingPrice: numericText.nullable().optional(),
          productionPrice: numericText.nullable().optional(),
        })
      )
      .optional(),
  }),
} satisfies RequestSchemas;

/** POST /api/factory/bale-product-images: multipart form fields beside the image. */
export const uploadProductImageInput = {
  body: z.union([
    z.undefined(),
    z.strictObject({ articleCode: z.string().optional(), productId: z.string().optional() }),
  ]),
} satisfies RequestSchemas;
