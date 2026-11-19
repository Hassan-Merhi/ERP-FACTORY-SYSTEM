// Request schemas for the bank account write routes (bankAccountRoutes.ts and
// registerBankAccountRoutesPart1.ts).
import { z } from "zod";
import { emptyBody, emptyQuery, stringIdParams, type RequestSchemas } from "../lib/validateRequest";

// The bank_accounts columns a client may send, as JSON types. The handlers still parse with
// insertBankAccountSchema for the field rules and keep their own messages.
const nullableString = z.string().nullable().optional();
const bankAccountFields = {
  routingCode: nullableString,
  linkedLedgerId: z.number().nullable().optional(),
  openingBalance: nullableString,
  openingBalanceSide: nullableString,
  openingBalanceNativeAmount: nullableString,
  openingBalanceCurrency: nullableString,
  openingBalanceHistoricalRate: nullableString,
  openingBalanceBaseAmount: nullableString,
  active: z.boolean().optional(),
  // POST ignores it (the active company is used); PUT refuses a company move.
  companyId: z.number().nullable().optional(),
};
export const createBankAccountInput = {
  query: emptyQuery,
  body: z.strictObject({
    code: z.string(),
    name: z.string(),
    bankName: z.string(),
    accountNumber: z.string(),
    ...bankAccountFields,
  }),
} satisfies RequestSchemas;
export const updateBankAccountInput = {
  params: stringIdParams,
  query: emptyQuery,
  body: z.strictObject({
    code: z.string().optional(),
    name: z.string().optional(),
    bankName: z.string().optional(),
    accountNumber: z.string().optional(),
    ...bankAccountFields,
  }),
} satisfies RequestSchemas;
export const deleteBankAccountInput = {
  params: stringIdParams,
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;
