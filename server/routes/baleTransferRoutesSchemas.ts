/** Request schemas for the bale transfer write routes (baleTransferRoutes.ts and its Part1 sibling). */
import { z } from "zod";
import { emptyBody, stringIdParams, type RequestSchemas } from "../lib/validateRequest";

const idValue = z.union([z.number(), z.string()]);
const amount = z.union([z.number(), z.string()]);
const transferLine = {
  productionBaleId: idValue.optional(),
  quantity: z.number().nullable().optional(),
  weightKg: amount,
  costPerKg: amount,
  totalCost: amount,
};

export const createTransferInput = {
  body: z.strictObject({
    sourceLocationId: idValue.optional(),
    destinationLocationId: idValue.optional(),
    transferDate: z.string().optional(),
    notes: z.string().nullable().optional(),
    items: z.array(z.strictObject(transferLine)).optional(),
  }),
} satisfies RequestSchemas;

export const noBodyByIdInput = { params: stringIdParams, body: emptyBody } satisfies RequestSchemas;

export const updateTransferInput = {
  params: stringIdParams,
  body: z.strictObject({
    status: z.string().optional(),
    notes: z.string().nullable().optional(),
    items: z.array(z.strictObject({ id: idValue.nullable().optional(), ...transferLine })).optional(),
  }),
} satisfies RequestSchemas;
