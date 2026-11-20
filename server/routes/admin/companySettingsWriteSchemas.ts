import { z } from "zod";
import { emptyBody, emptyQuery, type RequestSchemas } from "../../lib/validateRequest";

// resetCompanyId() only compares an optional companyId with the session company
// (Number(...)); client/src/pages/useCompanyDataResetState.ts sends
// parseInt(selectedCompanyId), which is null in JSON when nothing is selected.
const requestedCompanyId = z.union([z.number(), z.string()]).nullable().optional();

export const resetCompanyDataInput = {
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({ companyId: requestedCompanyId })]),
} satisfies RequestSchemas;

export const undoCompanyResetInput = resetCompanyDataInput;

export const companyDataResetInput = {
  query: emptyQuery,
  body: z.strictObject({
    companyId: requestedCompanyId,
    // The handler keeps its own "accountIds array is required" answer.
    accountIds: z.array(z.number()).optional(),
    clearStockOpeningBalances: z.boolean().nullable().optional(),
  }),
} satisfies RequestSchemas;

export const setParentCompanyInput = {
  query: emptyQuery,
  body: z.strictObject({
    // The handler accepts a number, a numeric string, or null/absent to clear.
    parentCompanyId: z.union([z.number(), z.string()]).nullable().optional(),
    companyId: z.unknown().optional(), // sent by client/src/pages/settings/SystemToolsTab.tsx; not used
  }),
} satisfies RequestSchemas;

// Retired endpoint: it only answers 410.
export const applyMissingMigrationsInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;
