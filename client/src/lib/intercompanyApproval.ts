/**
 * Parse the payload of POST /api/intercompany-requests/:id/approve.
 *
 * The endpoint answers `{ success, voucherId, voucherNumber }` after creating
 * the mirror voucher. The approval UI reports the voucher number back to the
 * user, so the number has to be read out of the parsed body — reading it off
 * the unparsed `Response` object silently yields `undefined`, which is what the
 * confirmation toast used to show.
 *
 * The body is untrusted JSON, so it is narrowed rather than asserted: a payload
 * without a usable voucher number produces `null` and the caller words the
 * confirmation without one.
 */
import { asRecord, isNonEmptyString } from "@shared/typeGuards";

export interface IntercompanyApprovalResult {
  voucherNumber: string | null;
}

export function parseIntercompanyApproval(payload: unknown): IntercompanyApprovalResult {
  const voucherNumber = asRecord(payload)?.voucherNumber;
  return { voucherNumber: isNonEmptyString(voucherNumber) ? voucherNumber : null };
}

/** The confirmation message shown once a request has been approved. */
export function intercompanyApprovalMessage(result: IntercompanyApprovalResult): string {
  return result.voucherNumber ? `Mirror voucher ${result.voucherNumber} created.` : "Mirror voucher created.";
}
