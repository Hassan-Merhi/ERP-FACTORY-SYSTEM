/**
 * Request shapes for the ledger account write routes in
 * ./registerLedgerAccountWriteRoutes.ts (kept here so that file stays under
 * the source-size cap).
 *
 * These are the ledger_accounts columns as JSON types. The handlers still
 * parse with insertLedgerAccountSchema / updateLedgerAccountSchema for the
 * field rules (account types, Dr/Cr side, name not blank) and keep their own
 * messages and refusal codes.
 */
import { z } from "zod";
import { emptyQuery, stringIdParams, type RequestSchemas } from "../../lib/validateRequest";

const nullableString = z.string().nullable().optional();
const ledgerAccountFields = {
  code: z.string().optional(),
  subType: nullableString,
  parentId: z.number().nullable().optional(),
  openingBalance: z.string().optional(),
  openingBalanceSide: z.string().optional(),
  openingBalanceNativeAmount: nullableString,
  openingBalanceCurrency: nullableString,
  openingBalanceHistoricalRate: nullableString,
  openingBalanceBaseAmount: nullableString,
  active: z.boolean().optional(),
  isHidden: z.boolean().optional(),
};

export const createLedgerAccountInput = {
  query: emptyQuery,
  body: z.strictObject({
    companyId: z.number(),
    name: z.string(),
    accountType: z.string(),
    ...ledgerAccountFields,
  }),
} satisfies RequestSchemas;

export const updateLedgerAccountInput = {
  params: stringIdParams,
  query: emptyQuery,
  body: z.strictObject({
    // Sent by client/src/pages/useLegacyAccountGroupsState.ts; not used (the path id wins).
    id: z.unknown().optional(),
    companyId: z.number().optional(),
    name: z.string().optional(),
    accountType: z.string().optional(),
    ...ledgerAccountFields,
    // Never written by an edit: the handler refuses it with LEDGER_ACCOUNT_DELETE_VIA_EDIT_REFUSED.
    deletedAt: z.unknown().optional(),
  }),
} satisfies RequestSchemas;

export const bulkAssignParentInput = {
  query: emptyQuery,
  body: z.strictObject({
    accountIds: z.array(z.union([z.number(), z.string()])).optional(),
    parentId: z.union([z.number(), z.string()]).nullable().optional(),
  }),
} satisfies RequestSchemas;
