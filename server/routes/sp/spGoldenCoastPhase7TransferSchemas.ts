/**
 * Request schema for POST /api/sp/golden-coast/phase7/sales-cash-transfer.
 *
 * Phase 16 (spGoldenCoastPhase16HadiTransferGuard.ts) answers every POST on
 * this path before the Phase 7 handler is reached; both read the body through
 * parseGoldenCoastPhase7TransferInput, so they share this schema.
 */
import { z } from "zod";
import { type RequestSchemas } from "../../lib/validateRequest";
import { amountish, numberish, spWriteFields } from "./spRequestSchemas";

const phase7CashAccount = z.strictObject({ kind: z.string(), id: numberish });

export const phase7TransferInput = {
  body: z.strictObject({
    ...spWriteFields,
    operation: z.string().optional(),
    transferDate: z.string().optional(),
    amountUsd: amountish.optional(),
    reference: z.string().nullable().optional(),
    hadiCashAccount: phase7CashAccount.nullable().optional(),
    goldenCoastCashAccount: phase7CashAccount.nullable().optional(),
  }),
} satisfies RequestSchemas;
