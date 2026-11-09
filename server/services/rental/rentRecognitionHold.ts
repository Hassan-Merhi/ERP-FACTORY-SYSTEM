/**
 * Persisted, reviewed rental-month recognition holds. The hold marker lives
 * in property_monthly_ledger.notes, survives restarts and does not post any
 * voucher, journal line, cash movement or prepaid asset adjustment.
 */
export const RENT_RECOGNITION_HOLD_PREFIX = "[RENT_RECOGNITION_HOLD]";

export function isRentRecognitionHeld(notes: string | null | undefined): boolean {
  return typeof notes === "string" && notes.startsWith(RENT_RECOGNITION_HOLD_PREFIX);
}
