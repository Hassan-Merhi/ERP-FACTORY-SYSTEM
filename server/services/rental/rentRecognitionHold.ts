/**
 * Rental-month accounting holds. No voucher or Prepaid Rent balance changes.
 *
 * Until the one-off November 2026 review note is deployed, refuse to post
 * Factory company 12 / Warehouse 5001 November row #889178 even if an
 * existing scheduler recalculates its due amount during startup. This
 * temporary bootstrap guard will be removed after the persisted note is
 * confirmed in production. All other months use explicit notes only.
 */
export const RENT_RECOGNITION_HOLD_PREFIX = "[RENT_RECOGNITION_HOLD]";

export function isRentRecognitionHeld(
  notes: string | null | undefined,
  context?: { companyId: number; rowId: number }
): boolean {
  return (
    (typeof notes === "string" && notes.startsWith(RENT_RECOGNITION_HOLD_PREFIX)) ||
    (context?.companyId === 12 && context.rowId === 889178)
  );
}
