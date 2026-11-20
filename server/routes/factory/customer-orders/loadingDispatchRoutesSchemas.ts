// Request schemas for ./loadingDispatchRoutes.ts (kept apart for the source-size cap).
import { z } from "zod";
import { emptyQuery, idParams, positiveIntParam, type RequestSchemas } from "../../../lib/validateRequest";

// The trip form sends Number(form.tripNumber), which JSON turns into null for
// a non-numeric entry; parseTripNumber and parseOptionalText keep their own
// messages for bad values.
const tripFields = {
  tripNumber: z.union([z.number(), z.string()]).nullable().optional(),
  notes: z.string().nullable().optional(),
};
const tripParams = z.strictObject({ id: positiveIntParam, dispatchId: positiveIntParam });

// Legacy clients may omit the body and keep automatic numbering.
export const createDispatchInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject(tripFields).optional(),
} satisfies RequestSchemas;

// The handler keeps its "Only tripNumber and notes may be updated" check for an empty body.
export const updateDispatchInput = {
  params: tripParams,
  query: emptyQuery,
  body: z.strictObject(tripFields),
} satisfies RequestSchemas;

// The handler keeps its 3–500 character reason check.
export const cancelDispatchInput = {
  params: tripParams,
  query: emptyQuery,
  body: z.strictObject({ reason: z.string().optional() }),
} satisfies RequestSchemas;
