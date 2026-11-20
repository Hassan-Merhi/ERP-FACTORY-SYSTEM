/**
 * Request schemas for the purchase-order write routes in this folder. The
 * handlers keep reading req.params (tests call them directly), so params are
 * only checked here.
 */
import { z } from "zod";
import { emptyBody, emptyQuery, idParams, type RequestSchemas } from "../../lib/validateRequest";

/** Money and ids arrive as numbers or numeric strings (storedCents / Number / amountInput). */
const looseNumber = z.union([z.number(), z.string()]);

const purchaseOrderItem = z.strictObject({
  id: looseNumber.nullable().optional(),
  stockItemId: looseNumber.nullable().optional(),
  itemName: z.string().nullable().optional(),
  quantity: looseNumber.nullable().optional(),
  rate: looseNumber.nullable().optional(),
});

/** PATCH /api/purchase-orders/:id (containerFreightWriteRoutesStep, purchaseOrderItemsUpdate*, purchaseOrderZmwEdit). */
export const updatePurchaseOrderInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    poNumber: z.string().optional(),
    itemsTotal: looseNumber.optional(),
    currency: z.string().optional(),
    status: z.string().optional(),
    freight: looseNumber.optional(),
    surcharge: looseNumber.optional(),
    fumigation: looseNumber.optional(),
    documentCharges: looseNumber.optional(),
    discount: looseNumber.optional(),
    otherCharges: looseNumber.optional(),
    freightPaidBy: z.string().optional(),
    freightOwnAccountId: looseNumber.nullable().optional(),
    freightParentAccountId: looseNumber.nullable().optional(),
    // Checked against the locked rate of a native-Kwacha PO (purchaseOrderZmwEdit).
    exchangeRate: looseNumber.nullable().optional(),
    items: z.array(purchaseOrderItem).nullable().optional(),
  }),
} satisfies RequestSchemas;

export const deletePurchaseOrderInput = {
  params: idParams,
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export const syncParentVoucherInput = { params: idParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export const poImportBackfillInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;
