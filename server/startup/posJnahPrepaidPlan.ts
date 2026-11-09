/**
 * Exact guard for the two owner-reviewed POS Jnah annual rent snapshots.
 *
 * Before: the November $20k correction journal is active, December–July are
 * marked prepaid, and August/November are included in the original $30k debit
 * to Rent Expense. After: the original voucher and two old reclassification
 * journals are corrected in place; no additional vouchers exist.
 */
export interface PosJnahMonth {
  id: number;
  contract_id: number;
  unit_id: number;
  year: number;
  month: number;
  expected_amount: string | number;
  paid_amount: string | number;
  accrual_voucher_id: number | null;
  used_prepaid_account: boolean;
  used_advance_account: boolean;
}

function requireMatch(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error("POS_JNAH_RENT_REWORK_REFUSED_" + reason);
}

/** Only the August and November rows need their existing recognition links. */
export function verifyPosJnahPrepaidMonths(
  rows: readonly PosJnahMonth[],
  state: "before" | "after"
): readonly { id: number; voucherId: number }[] {
  requireMatch(rows.length === 12, "MONTH_COUNT");
  for (let i = 0; i < 12; i++) {
    const m = rows[i];
    const year = i < 5 ? 2026 : 2027;
    const month = (7 + i) % 12 + 1;
    const expectedVoucher = i === 1 ? 13142 : i === 2 ? 15041 :
      state === "after" && i === 0 ? 13141 :
      state === "after" && i === 3 ? 15040 : null;
    const prepaid = state === "after" || i === 1 || i === 2 || i >= 4;
    requireMatch(
      m.id === 701216 + i &&
      m.contract_id === 36 &&
      m.unit_id === 59 &&
      m.year === year &&
      m.month === month &&
      Number(m.expected_amount) === 2500 &&
      Number(m.paid_amount) === 2500 &&
      m.used_advance_account === false &&
      m.used_prepaid_account === prepaid &&
      m.accrual_voucher_id === expectedVoucher,
      "MONTH_DRIFT_" + i
    );
  }
  return [{ id: 701216, voucherId: 13141 }, { id: 701219, voucherId: 15040 }];
}
