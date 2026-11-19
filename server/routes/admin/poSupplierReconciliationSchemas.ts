import { z } from "zod";
import { emptyQuery, type RequestSchemas } from "../../lib/validateRequest";

// Both routes read Number(companyId ?? session company), checked against the
// user's accessible companies, and treat only apply === true as a write run.
export const poSupplierReconciliationInput = {
  query: emptyQuery,
  body: z.union([
    z.undefined(),
    z.strictObject({
      companyId: z.union([z.number(), z.string()]).nullable().optional(),
      apply: z.boolean().optional(),
    }),
  ]),
} satisfies RequestSchemas;
