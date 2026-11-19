/**
 * Input schemas for voucherCreateRoutes.ts (POST /api/vouchers and the
 * terminal POST /api/vouchers/with-entries handler). Kept apart so the route
 * file stays under the line cap.
 */
import { z } from "zod";
import { emptyQuery, type RequestSchemas } from "../../lib/validateRequest";
import {
  clientRequestId,
  entryCurrencyFields,
  entryTargetFields,
  optionalNumeric,
  optionalText,
} from "./voucherWriteInputSchemas";

/**
 * A bare voucher header. The handler keeps its own required-field checks
 * ("Invalid request data", field), so the fields stay optional here.
 */
export const createVoucherInput = {
  query: emptyQuery,
  body: z.strictObject({
    companyId: optionalNumeric,
    voucherNumber: optionalNumeric,
    voucherType: optionalText,
    voucherDate: optionalText,
    totalAmount: optionalNumeric,
    optional: z.boolean().optional(),
    currency: optionalText,
    exchangeRate: optionalNumeric,
    description: optionalText,
    locationId: optionalNumeric,
    locationName: optionalText,
    effectiveDate: optionalText,
    clientRequestId,
  }),
} satisfies RequestSchemas;

/**
 * Voucher with entries. The central generic layer
 * (centralGenericVoucherCreateRoute.ts) passes optional, non-USD, dual-currency
 * and sub-cent payloads on to this handler unchanged, so the schema covers
 * every shape callers send to the URL, including the offline outbox payload
 * (client/src/lib/offline/operationContract.ts) with its clientRequestId.
 */
export const createVoucherWithEntriesInput = {
  query: emptyQuery,
  body: z.strictObject({
    voucher: z
      .strictObject({
        voucherNumber: optionalNumeric,
        voucherType: optionalText,
        voucherDate: optionalText,
        description: optionalText,
        optional: z.boolean().optional(),
        currency: optionalText,
        exchangeRate: optionalNumeric,
        locationId: optionalNumeric,
        effectiveDate: z.unknown().optional(), // allowed by client/src/lib/offline/operationContract.ts; not used
      })
      .optional(),
    entries: z
      .array(
        z.strictObject({
          ...entryTargetFields,
          debitAmount: optionalNumeric,
          creditAmount: optionalNumeric,
          narration: optionalText,
          ...entryCurrencyFields,
          baseDebitAmount: optionalNumeric,
          baseCreditAmount: optionalNumeric,
          rateConvention: optionalText,
        })
      )
      .optional(),
    clientRequestId,
  }),
} satisfies RequestSchemas;
