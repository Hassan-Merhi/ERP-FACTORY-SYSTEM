// Request schemas for ./orderChargesRoutes.ts (kept apart for the source-size cap).
import { z } from "zod";
import {
  clientRequestId,
  emptyBody,
  emptyQuery,
  identityOnlyBody,
  idParams,
  positiveIntParam,
  type RequestSchemas,
} from "../../../lib/validateRequest";

// Amounts and ledger account ids arrive as numbers (invoice pages) or strings
// (tests, older forms); the handlers String()/parseInt them and keep their
// own required-field and amount checks.
const numberOrString = z.union([z.number(), z.string()]);
const chargeParams = z.strictObject({ id: positiveIntParam, chargeId: positiveIntParam });

export const addChargeInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    clientRequestId,
    name: z.string().optional(),
    amount: numberOrString.optional(),
    chargeType: z.string().nullable().optional(),
    ledgerAccountId: numberOrString.nullable().optional(),
  }),
} satisfies RequestSchemas;

export const relinkChargeVouchersInput = {
  params: idParams,
  query: emptyQuery,
  body: identityOnlyBody,
} satisfies RequestSchemas;

export const updateChargeInput = {
  params: chargeParams,
  query: emptyQuery,
  body: z.strictObject({
    ledgerAccountId: numberOrString.nullable().optional(),
    amount: numberOrString.optional(),
    name: z.string().optional(),
  }),
} satisfies RequestSchemas;

export const deleteChargeInput = { params: chargeParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;
