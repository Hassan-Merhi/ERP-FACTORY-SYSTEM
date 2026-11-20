import { z } from "zod";
import { emptyBody, emptyQuery, stringParam, type RequestSchemas } from "../../../lib/validateRequest";

const userIdParams = z.strictObject({ userId: stringParam });
// normalizeAssignableFactoryPageKeys / normalizeFactoryHiddenFields decide which keys are kept.
const keyList = z.array(z.string()).nullable().optional();

// client/src/pages/settings/users/AddUserDialog.tsx. The handler keeps its own
// "Username and password are required" and length answers.
export const createFactoryUserInput = {
  query: emptyQuery,
  body: z.strictObject({
    username: z.string().optional(),
    password: z.string().optional(),
    displayName: z.string().nullable().optional(),
    pageAccess: keyList,
    hasErpAccess: z.boolean().nullable().optional(),
    hasFactoryAccess: z.boolean().nullable().optional(),
  }),
} satisfies RequestSchemas;

// client/src/pages/settings/users/useUserManagementDrawerState.ts (handleSaveAll).
export const updateFactoryUserInput = {
  params: userIdParams,
  query: emptyQuery,
  body: z.strictObject({
    displayName: z.string().nullable().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    pageAccess: keyList,
    hasErpAccess: z.boolean().nullable().optional(),
    hasFactoryAccess: z.boolean().nullable().optional(),
    hiddenCostFields: keyList,
    hideAllCosts: z.boolean().nullable().optional(),
  }),
} satisfies RequestSchemas;

// The client sends {} with the DELETE.
export const removeFactoryUserInput = {
  params: userIdParams,
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;
