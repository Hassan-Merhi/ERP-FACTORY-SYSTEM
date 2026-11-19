import { z } from "zod";
import { emptyBody, emptyQuery, stringParam, type RequestSchemas } from "../../lib/validateRequest";

// The handler parses :accountId with parseInt and keeps its own answer.
export const migrateEmployeeAccountInput = {
  params: z.strictObject({ accountId: stringParam }),
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export const migrateAllLegacyEmployeeAccountsInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export const updateRolePermissionsInput = {
  query: emptyQuery,
  body: z.strictObject({
    // The handler keeps its own "permissions must be an array" answer.
    permissions: z.array(z.strictObject({ role: z.string(), featureKey: z.string(), enabled: z.boolean() })).optional(),
    // sent by client/src/components/useAdvancedRestrictionsPanelState.ts and
    // client/src/pages/settings/PageVisibilityTree.tsx; not used (the session company is used)
    companyId: z.unknown().optional(),
  }),
} satisfies RequestSchemas;

const userIdParams = z.strictObject({ userId: stringParam });

// parseErpPageGrantKeys / parseErpHiddenCostFields still decide which keys are
// recognized and answer with their own messages.
export const updateErpUserPageAccessInput = {
  params: userIdParams,
  query: emptyQuery,
  body: z.strictObject({ pageKeys: z.array(z.string()).optional() }),
} satisfies RequestSchemas;

export const updateErpUserHiddenCostsInput = {
  params: userIdParams,
  query: emptyQuery,
  body: z.strictObject({ hiddenCostFields: z.array(z.string()).optional() }),
} satisfies RequestSchemas;
