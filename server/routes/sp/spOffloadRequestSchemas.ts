/**
 * Request schemas for the Supplier Partner offload write routes
 * (spOffloadRoutes.ts, spOffloadLifecycleRoutes.ts).
 *
 * POST /api/sp/offload is also read by the pass-through guards registered
 * before it (spReoffloadPreparationGuard, spOffloadConcurrencyGuard,
 * spOffloadPrepaidCompanyGuard); the schema covers every field they read,
 * including `parentAgentAccountId`, which the replay signature uses.
 */
import { z } from "zod";
import { idParams, type RequestSchemas } from "../../lib/validateRequest";
import { amountish, numberish, spWriteFields } from "./spRequestSchemas";

const spOffloadChargeLineSchema = z.strictObject({
  chargeType: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  amountUsd: amountish.nullable().optional(),
  prepaidChargeId: numberish.nullable().optional(),
  creditBankAccountId: numberish.nullable().optional(),
  creditLedgerAccountId: numberish.nullable().optional(),
  parentAgentAccountId: numberish.nullable().optional(),
});

export const createSpOffloadInput = {
  body: z.strictObject({
    ...spWriteFields,
    containerId: numberish.nullable().optional(),
    offloadDate: z.string().nullable().optional(),
    locationId: numberish.nullable().optional(),
    chargeLines: z.array(spOffloadChargeLineSchema).nullable().optional(),
  }),
} satisfies RequestSchemas;

export const reverseSpOffloadInput = {
  params: idParams,
  body: z.strictObject({ ...spWriteFields, reversalDate: z.string().nullable().optional() }),
} satisfies RequestSchemas;
