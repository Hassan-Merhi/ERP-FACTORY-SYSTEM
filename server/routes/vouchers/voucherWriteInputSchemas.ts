/**
 * Shared Zod building blocks for the voucher and voucher-entry write routes.
 *
 * They describe the input those routes accept today, field by field: amounts
 * and ids arrive as JSON numbers or decimal strings (the handlers run them
 * through Number(), String() or the money parsers), and the handlers keep
 * their own required-field checks and messages, so most fields are optional
 * here. Every object is strict; validateRequest refuses a non-strict one.
 */
import { z } from "zod";

/** A number the client sends as a JSON number or a decimal string. */
export const numberOrString = z.union([z.number(), z.string()]);

/** An amount, rate or id the handler reads with Number()/String(); absent or null is tolerated. */
export const optionalNumeric = numberOrString.nullable().optional();

/** A text field the handler stores or compares; absent or null is tolerated. */
export const optionalText = z.string().nullable().optional();

/**
 * Idempotency identity of a voucher create. Read from the body by the
 * operational voucher request boundary (or the X-Idempotency-Key header
 * instead, so it stays optional), the posting engines and the offline outbox
 * replay (client/src/lib/offline/durableOutbox.ts adds it).
 */
export const clientRequestId = z.string().optional();

/** The posting target of a voucher line, in the column shape. */
export const entryTargetFields = {
  ledgerAccountId: optionalNumeric,
  bankAccountId: optionalNumeric,
  fixedAssetId: optionalNumeric,
  supplierId: optionalNumeric,
  employeeId: optionalNumeric,
  customerId: optionalNumeric,
  factorySupplierId: optionalNumeric,
};

/** The Daybook form shape of a line target: `{ accountType, accountId }`. */
export const entryAccountFields = {
  accountType: optionalText,
  accountId: optionalNumeric,
};

/** Dual-currency line fields sent by the multi-currency voucher editors. */
export const entryCurrencyFields = {
  transactionCurrency: optionalText,
  transactionDebitAmount: optionalNumeric,
  transactionCreditAmount: optionalNumeric,
  historicalExchangeRate: optionalNumeric,
};

/**
 * One replacement line of PATCH /api/vouchers/:id and POST /api/voucher-entries
 * (see services/accounting/voucherEntryReplacement.ts).
 */
export const replacementEntryFields = {
  ...entryTargetFields,
  ...entryAccountFields,
  debitAmount: optionalNumeric,
  creditAmount: optionalNumeric,
  narration: optionalText,
};

/** One line of the journal form (POST /api/vouchers/journal, PATCH /api/vouchers/:id/journal). */
export const journalEntry = z.strictObject({
  type: optionalText,
  accountType: optionalText,
  accountId: optionalNumeric,
  accountName: z.unknown().optional(), // sent by client/src/pages/vouchers/journalform; not used
  amount: optionalNumeric,
  narration: optionalText,
});

/** The journal form body, shared by the create and update routes. */
export const journalBodyFields = {
  voucherDate: optionalText,
  entries: z.array(journalEntry).optional(),
  notes: optionalText,
  optional: z.boolean().optional(),
  currency: optionalText,
  exchangeRate: optionalNumeric,
  effectiveDate: optionalText,
  mainAccountId: optionalNumeric,
  mainAccountType: optionalText,
  clientRequestId,
};

/** One line of the Payment/Receipt form. */
export const paymentReceiptEntry = z.strictObject({
  accountType: optionalText,
  accountId: optionalNumeric,
  accountName: z.unknown().optional(), // sent by client/src/pages/vouchers/useVoucherSaveMutation.ts; not used
  amount: optionalNumeric,
  narration: optionalText,
});

/** The Payment/Receipt form body, shared by the create and update routes. */
export const paymentReceiptBodyFields = {
  voucherType: optionalText,
  voucherDate: optionalText,
  paymentAccountType: optionalText,
  paymentAccountId: optionalNumeric,
  paymentAccountName: z.unknown().optional(), // sent by client/src/pages/vouchers/useVoucherSaveMutation.ts; not used
  paymentAccountNarration: optionalText,
  entries: z.array(paymentReceiptEntry).optional(),
  notes: optionalText,
  optional: z.boolean().optional(),
  // Read by guardFxWalletPaymentSource (vouchers/fxAgentPaymentSourceGuard.ts).
  fxWalletDraft: z.boolean().optional(),
  currency: optionalText,
  exchangeRate: optionalNumeric,
  effectiveDate: optionalText,
  clientRequestId,
};
