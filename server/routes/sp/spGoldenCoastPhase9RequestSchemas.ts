/**
 * Request schema for POST /api/sp/golden-coast/phase9/hassan-savings-withdrawal
 * (spGoldenCoastPhase9HassanSavingsWithdrawalRoutes.ts). Kept beside the route
 * because that module is at the source-size cap.
 */
import { z } from "zod";
import { type RequestSchemas } from "../../lib/validateRequest";
import { amountish, numberish, spWriteFields } from "./spRequestSchemas";

/** Read by parseGoldenCoastPhase9WithdrawalInput and actorFromRequest. */
export const phase9WithdrawalInput = {
  body: z.strictObject({
    ...spWriteFields,
    withdrawalDate: z.string().optional(),
    amountUsd: amountish.optional(),
    reference: z.string().nullable().optional(),
    paymentAccount: z.strictObject({ kind: z.string(), id: numberish }).nullable().optional(),
  }),
} satisfies RequestSchemas;
