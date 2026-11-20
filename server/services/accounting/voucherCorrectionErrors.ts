/**
 * The voucher correction policy's refusals (server/services/accounting/voucherCorrection.ts):
 * stable codes and messages for the UI, and the error that carries them. Split
 * out of voucherCorrection.ts unchanged; that module re-exports all of it.
 */
import type { Response } from "express";
import { HttpError } from "../../lib/httpError";

export const VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD = "VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD";

export const VOUCHER_CORRECTION_MESSAGES = {
  notFound: "Voucher not found",
  deleted: "This voucher is deleted and cannot be changed or reversed.",
  closedPeriod:
    "This voucher is dated in a closed period and cannot be edited. Reverse it and post a corrected voucher dated in an open period instead.",
  reversedLocked:
    "This voucher has been reversed, or is itself a reversal, and cannot be edited. Post a new voucher instead.",
  reasonRequired: "A reason is required to reverse a voucher.",
  alreadyReversed: "This voucher has already been reversed.",
  reversalOfReversal: "A reversal voucher cannot itself be reversed.",
  optionalNotPosted: "An optional voucher is not posted to the ledger, so there is nothing to reverse.",
  reversalDateClosed: "The reversal date is in a closed period. Choose a date in an open period.",
  reversalDateInvalid: "The reversal date must be a YYYY-MM-DD date.",
} as const;

/** A refusal of the correction policy, with a stable code for the UI. */
export class VoucherCorrectionError extends HttpError {
  constructor(
    statusCode: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(statusCode, message);
    this.name = "VoucherCorrectionError";
  }

  body(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

/** Sends a VoucherCorrectionError as `{ code, message, ...details }`; false for any other error. */
export function sendVoucherCorrectionRefusal(res: Response, error: unknown): boolean {
  if (!(error instanceof VoucherCorrectionError)) return false;
  res.status(error.statusCode).json(error.body());
  return true;
}
