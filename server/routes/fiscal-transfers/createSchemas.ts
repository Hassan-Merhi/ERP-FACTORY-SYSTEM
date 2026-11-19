/**
 * Request schema for POST /api/stock-transfers and POST /api/stock-transfer-orders
 * (./create.ts). The handler keeps its own inventory-safety checks and their
 * messages; this schema fixes the accepted shape and rejects unknown fields.
 * Ids and amounts stay as the caller sent them (number or string): the
 * handler and createStockTransferTx compare and convert them themselves.
 */
import { z } from "zod";
import type { RequestSchemas } from "../../lib/validateRequest";

const idValue = z.union([z.number(), z.string()]);
const amount = z.union([z.number(), z.string()]);

const transferLine = z.strictObject({
  stockItemId: idValue.nullable().optional(),
  sourceLocationId: idValue.nullable().optional(),
  quantity: amount.nullable().optional(),
  rate: amount.nullable().optional(),
  stockItemName: z.unknown().optional(), // sent by client/src/pages/pos/postransferorders/components/CreateTransferDialog.tsx; not used
});

export const createStockTransferInput = {
  body: z.strictObject({
    voucherId: idValue.nullable().optional(),
    sourceLocationId: idValue.nullable().optional(),
    destinationLocationId: idValue.nullable().optional(),
    notes: z.string().nullable().optional(),
    items: z.array(transferLine).nullable().optional(),
    allowNegativeInventory: z.boolean().nullable().optional(),
    voucherDate: z.string().nullable().optional(),
    optional: z.boolean().nullable().optional(),
    // Offline outbox / request identity: the idempotency key for a replayed create.
    clientRequestId: z.string().nullable().optional(),
    // Refused by the handler with its own message: the route sets the workflow origin.
    workflowOrigin: z.unknown().optional(),
  }),
} satisfies RequestSchemas;
