/**
 * Persisted, reviewed rental-month recognition holds. The hold marker lives
 * in property_monthly_ledger.notes, survives restarts and does not post any
 * voucher, journal line, cash movement or prepaid asset adjustment.
 */
export const RENT_RECOGNITION_HOLD_PREFIX = "[RENT_RECOGNITION_HOLD]";

export function isRentRecognitionHeld(notes: string | null | undefined): boolean {
  return typeof notes === "string" && notes.startsWith(RENT_RECOGNITION_HOLD_PREFIX);
}

/**
 * Shared selection rule for due rental months. A held, reviewed historical
 * month is never queued for a new accrual even if a different month on its
 * contract becomes outstanding. The journal writer applies the same hold
 * check under its row lock as the final protection.
 */
export function isRentMonthReadyToRecognize(
  notes: string | null | undefined,
  periodIsDue: boolean
): boolean {
  return periodIsDue && !isRentRecognitionHeld(notes);
}
