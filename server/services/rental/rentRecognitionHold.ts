/**
 * Opt-in, per-month accounting hold. Does not change posted vouchers or balances.
 * A reviewed exception stays visible to operators until its real
 * counter-entry is identified and the hold is explicitly removed.
 */
export const RENT_RECOGNITION_HOLD_PREFIX = "[RENT_RECOGNITION_HOLD]";

export function isRentRecognitionHeld(notes: string | null | undefined): boolean {
  return typeof notes === "string" && notes.startsWith(RENT_RECOGNITION_HOLD_PREFIX);
}
