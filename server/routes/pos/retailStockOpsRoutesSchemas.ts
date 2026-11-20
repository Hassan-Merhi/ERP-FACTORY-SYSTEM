import { z } from "zod";
import { emptyQuery, type RequestSchemas } from "../../lib/validateRequest";

// Request schemas for retailStockOpsRoutes.ts (kept here to hold that file under the line cap).
const idempotencyKeySchema = z.string().trim().min(8).max(191);

const paymentSchema = z.strictObject({
  method: z.enum(["cash", "card", "bank", "mobile", "other", "credit"]),
  amount: z.coerce.number().finite().positive(),
  tenderedAmount: z.coerce.number().finite().positive().nullable().optional(),
  reference: z.string().trim().max(191).optional(),
  ledgerAccountId: z.number().int().positive().nullable().optional(),
  bankAccountId: z.number().int().positive().nullable().optional(),
});

const receiveSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  variantId: z.coerce.number().int().positive(),
  locationId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().finite().positive().max(100000),
  unitCost: z.coerce.number().finite().nonnegative().optional(),
  reference: z.string().trim().max(191).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const retailExchangeSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  saleId: z.coerce.number().int().positive(),
  locationId: z.coerce.number().int().positive(),
  shiftId: z.coerce.number().int().positive().optional(),
  payments: z.array(paymentSchema).min(1).max(8).optional(),
  refundDestination: z.enum(["original", "account"]).default("original"),
  refundLedgerAccountId: z.number().int().positive().nullable().optional(),
  refundBankAccountId: z.number().int().positive().nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
  returnItems: z
    .array(
      z.strictObject({
        saleItemId: z.coerce.number().int().positive(),
        quantity: z.coerce.number().finite().positive(),
        restock: z.boolean().default(true),
      })
    )
    .min(1)
    .max(100),
  newItems: z
    .array(
      z.strictObject({ variantId: z.coerce.number().int().positive(), quantity: z.coerce.number().finite().positive() })
    )
    .min(1)
    .max(100),
});

export const retailReceiptInput = { query: emptyQuery, body: receiveSchema } satisfies RequestSchemas;
export const retailExchangeInput = { query: emptyQuery, body: retailExchangeSchema } satisfies RequestSchemas;
