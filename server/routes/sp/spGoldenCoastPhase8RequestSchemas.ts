/**
 * Request schemas for the Golden Coast Phase 8 write routes
 * (spGoldenCoastPhase8ContainerOffloadRoutes.ts).
 */
import { z } from "zod";
import { type RequestSchemas } from "../../lib/validateRequest";
import { spContainerHeaderFields, spContainerLineSchema } from "./spContainerRequestSchemas";
import { amountish, numberish, spWriteFields } from "./spRequestSchemas";

const postingAccount = z.strictObject({ kind: z.string(), id: numberish });

/** Read by parseGoldenCoastPhase8ContainerInput (handleCreateContainer.ts). */
export const phase8CreateContainerInput = {
  body: z.strictObject({
    ...spWriteFields,
    supplierId: numberish.nullable().optional(),
    supplierName: z.string().optional(),
    containerNumber: z.string().nullable().optional(),
    invoiceNumber: z.string().optional(),
    invoiceDate: z.string().optional(),
    reserveUsd: amountish.nullable().optional(),
    fundingAccount: postingAccount.nullable().optional(),
    notes: z.string().nullable().optional(),
    lines: z
      .array(
        z.strictObject({
          stockItemId: numberish.nullable().optional(),
          articleCode: z.string().optional(),
          description: z.string().nullable().optional(),
          qty: amountish.optional(),
          unitRateUsd: amountish.optional(),
        })
      )
      .optional(),
  }),
} satisfies RequestSchemas;

/**
 * Read by handleFreshStartExcelImport. The client (client/src/pages/SpPOImport.tsx)
 * sends the same payload as POST /api/sp/containers; the handler ignores
 * supplierName (it always uses the Fresh Start source name).
 */
export const phase8FreshStartImportInput = {
  body: z.strictObject({
    ...spContainerHeaderFields,
    importSource: z.string().nullable().optional(),
    lines: z.array(spContainerLineSchema).nullable().optional(),
  }),
} satisfies RequestSchemas;

/** Read by parseGoldenCoastPhase8OffloadInput (handleOffload). */
export const phase8OffloadInput = {
  body: z.strictObject({
    ...spWriteFields,
    containerId: numberish.optional(),
    locationId: numberish.optional(),
    offloadDate: z.string().optional(),
    charges: z
      .array(
        z.strictObject({
          chargeType: z.string().optional(),
          description: z.string().nullable().optional(),
          amountUsd: amountish.optional(),
        })
      )
      .nullable()
      .optional(),
    chargeFundingAccount: postingAccount.nullable().optional(),
  }),
} satisfies RequestSchemas;
