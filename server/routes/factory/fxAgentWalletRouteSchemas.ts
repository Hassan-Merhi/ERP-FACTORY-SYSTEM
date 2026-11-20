/**
 * Request schemas for the FX agent wallet write routes. The handlers parse
 * amounts, ids and keys with String()/Number() and answer their own 400
 * messages, so fields stay optional and numeric fields take a string or a number.
 */
import { z } from "zod";
import { emptyQuery, stringParam, type RequestSchemas } from "../../lib/validateRequest";

const numeric = z.union([z.string(), z.number()]);
const text = z.string().nullable().optional();
const walletParams = z.strictObject({ id: stringParam });

export const activateWalletInput = {
  query: emptyQuery,
  body: z.strictObject({
    ledgerAccountId: numeric.optional(),
    confirmUsdSource: z.boolean().optional(),
    date: text,
  }),
} satisfies RequestSchemas;

export const rebaselineWalletInput = {
  params: walletParams,
  query: emptyQuery,
  body: z.strictObject({
    reason: text,
    expectedOpeningUsd: numeric.nullable().optional(),
    expectedLedgerBookUsd: numeric.nullable().optional(),
    confirmUsdSource: z.boolean().optional(),
  }),
} satisfies RequestSchemas;

export const convertWalletInput = {
  params: walletParams,
  query: emptyQuery,
  body: z.strictObject({
    usdAmount: numeric.nullable().optional(),
    rateUsdPerEur: numeric.nullable().optional(),
    date: text,
    requestKey: text,
    narration: text,
  }),
} satisfies RequestSchemas;

export const settleWalletInput = {
  params: walletParams,
  query: emptyQuery,
  body: z.strictObject({
    paymentVoucher: z.boolean().optional(),
    targetCurrency: text,
    eurAmount: numeric.nullable().optional(),
    usdAmount: numeric.nullable().optional(),
    rateUsdPerEur: numeric.nullable().optional(),
    targetKind: text,
    targetId: numeric.nullable().optional(),
    date: text,
    requestKey: text,
    narration: text,
    paymentAccountNarration: text,
    beneficiaryNarration: text,
    draftVoucherId: numeric.optional(),
  }),
} satisfies RequestSchemas;

export const reverseConversionInput = {
  params: walletParams,
  query: emptyQuery,
  body: z.strictObject({
    conversionId: numeric.nullable().optional(),
    reason: text,
    requestKey: text,
  }),
} satisfies RequestSchemas;
