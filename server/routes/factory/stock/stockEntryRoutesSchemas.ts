// Extracted from ./stockEntryRoutes.ts: request schemas for the factory stock entry, bale import and
// stock removal write routes. These routes are also replayed from the legacy browser offline queue
// (client/src/lib/offlineQueue.ts), so the shapes accept what the current forms send.
import { z } from "zod";
import { emptyQuery, type RequestSchemas } from "../../../lib/validateRequest";

const numberLike = z.union([z.number(), z.string()]);
const optionalNumberLike = numberLike.nullable().optional();
const optionalText = z.string().nullable().optional();

/**
 * One cart line. client/src/pages/factory/bale-stock-entry/useStockEntryTabStatePart3.ts sends
 * { productId, qty, weightPerBaleKg, finalizedBy, productionPositionId };
 * client/src/pages/factory/useWipersReEntryStatePart1.ts sends { productId, quantity, weightPerBale, finalizedBy }.
 */
const stockEntryItem = z.strictObject({
  productId: optionalNumberLike,
  qty: optionalNumberLike,
  quantity: optionalNumberLike,
  weightPerBale: optionalNumberLike,
  weightPerBaleKg: optionalNumberLike,
  finalizedBy: optionalNumberLike,
  productionPositionId: optionalNumberLike,
});

export const stockEntryInput = {
  query: emptyQuery,
  body: z.strictObject({
    items: z.array(stockEntryItem).nullable().optional(),
    erpLocationId: optionalNumberLike,
    mixBatchId: optionalNumberLike,
    entryDate: optionalText,
    customerId: z.unknown().optional(), // sent by client/src/pages/factory/bale-stock-entry/useStockEntryTabStatePart3.ts; not used
    logoId: z.unknown().optional(), // sent by client/src/pages/factory/bale-stock-entry/useStockEntryTabStatePart3.ts; not used
  }),
} satisfies RequestSchemas;

/** One parsed Excel row from client/src/pages/factory/bale-stock-entry/ImportBalesTab.tsx (ImportBaleRow). */
const importedBale = z.strictObject({
  itemName: optionalText,
  weight: optionalNumberLike,
  barcode: optionalText,
  quantity: optionalNumberLike,
  productionDate: optionalText,
  refNumber: optionalText,
});

export const baleImportInput = {
  query: emptyQuery,
  body: z.strictObject({
    erpLocationId: optionalNumberLike,
    bales: z.array(importedBale).nullable().optional(),
  }),
} satisfies RequestSchemas;

const supervisorFields = {
  supervisorUsername: optionalText,
  supervisorPassword: optionalText,
  reason: optionalText,
};

// useRemoveFromStockTabState.ts, useBalesHistoryModelPart2.ts, useWipersReEntryStatePart1.ts.
export const removeBalesInput = {
  query: emptyQuery,
  body: z.strictObject({ baleIds: z.array(z.number()).nullable().optional(), ...supervisorFields }),
} satisfies RequestSchemas;

// client/src/pages/factory/useFactoryLocationInventoryPart2.ts.
export const removeBalesByProductInput = {
  query: emptyQuery,
  body: z.strictObject({
    productId: z.number().nullable().optional(),
    locationId: z.number().nullable().optional(),
    qty: z.number().nullable().optional(),
    ...supervisorFields,
  }),
} satisfies RequestSchemas;
