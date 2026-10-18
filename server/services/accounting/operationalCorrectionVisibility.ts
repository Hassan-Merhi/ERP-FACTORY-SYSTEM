/**
 * Routine browsing-only visibility policy for an already-posted accounting correction.
 *
 * Do NOT reuse for official statements, ledgers, reconciliations, totals,
 * audit history, financial reporting or compliance exports: those must show
 * every posted entry, including the correcting journal.
 */
export const ROUTINE_CORRECTION_VOUCHER_ID = 16303;
export const ROUTINE_CORRECTION_COMPANY_ID = 8;

export function filterRoutineCorrection(companyId: number, role: string | null | undefined): boolean {
  return companyId === ROUTINE_CORRECTION_COMPANY_ID && role !== "Developer";
}

export function keepRoutineVoucher(
  voucher: { id: number; companyId: number },
  role: string | null | undefined
): boolean {
  return !(voucher.id === ROUTINE_CORRECTION_VOUCHER_ID && filterRoutineCorrection(voucher.companyId, role));
}
