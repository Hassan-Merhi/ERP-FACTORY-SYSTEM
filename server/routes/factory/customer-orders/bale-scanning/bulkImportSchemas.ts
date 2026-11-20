// Request schema for ./bulk-import.ts (kept apart for the source-size cap).
import { z } from "zod";
import { emptyQuery, idParams, type RequestSchemas } from "../../../../lib/validateRequest";

// Article-code mode sends items, ref-number mode sends refNumbers. The step
// String()s codes, parseInts qty and locationId, and keeps its required-field
// and location checks.
export const bulkImportInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    locationId: z.union([z.number(), z.string()]).nullable().optional(),
    items: z
      .array(
        z.strictObject({
          articleCode: z.union([z.string(), z.number()]).nullable().optional(),
          qty: z.union([z.number(), z.string()]).nullable().optional(),
        })
      )
      .optional(),
    refNumbers: z.array(z.union([z.string(), z.number()])).optional(),
    allowBypassProforma: z.boolean().optional(),
  }),
} satisfies RequestSchemas;
