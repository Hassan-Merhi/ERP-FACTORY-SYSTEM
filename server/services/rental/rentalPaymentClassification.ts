/**
 * Rental payment classification for an existing rental-month posting.
 *
 * A non-null accrual_voucher_id is NOT proof of a liability. The link can
 * reference advance recognition, prepaid recognition, a deleted historical
 * accrual, or even a voucher belonging to a different company. Only a live
 * posted journal with an actual credit to the company-local Accrued Rent
 * Payable control account is sufficient evidence to debit that liability.
 *
 * No historical voucher or prepaid asset is modified by this decision.
 */
export interface RentSettlementEvidence {
  dueOnPaymentDate: boolean;
  accrualVoucherLive: boolean;
  creditedAccruedPayable: boolean;
  recognitionHold: boolean;
}

export function shouldSettleAccruedRentPayable(evidence: RentSettlementEvidence): boolean {
  return (
    evidence.dueOnPaymentDate &&
    evidence.accrualVoucherLive &&
    evidence.creditedAccruedPayable &&
    !evidence.recognitionHold
  );
}

/** Outstanding operational rent cannot be negative after an overpayment. */
export function operationalRentOutstanding(expected: string | number, effectivePosted: string | number): number {
  const remainingCents =
    Math.round(Number(expected) * 100) - Math.round(Number(effectivePosted) * 100);
  if (!Number.isFinite(remainingCents)) throw new Error("RENTAL_OUTSTANDING_NONFINITE_AMOUNT");
  return Math.max(0, remainingCents) / 100;
}

/** A strict business date; prevents permissive Date() rollover (February 30). */
export function isValidRentalBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
