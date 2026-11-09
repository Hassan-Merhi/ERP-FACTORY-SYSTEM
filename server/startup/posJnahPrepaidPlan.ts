/**
 * Exact, pure before-image guard for POS Jnah's 2026/27 legacy annual rent.
 * This is intentionally not a generic rent backfill: unexpected edits to any
 * period or accrual flag MUST abort the owner-approved one-off correction.
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

function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error("POS_JNAH_RENT_REPAIR_REFUSED_" + reason);
}

export function planPosJnahPrepaidMonths(rows: readonly PosJnahMonth[]): number[] {
  check(rows.length === 12, "MONTH_COUNT_CHANGED");
  const future: number[] = [];
  for (let i = 0; i < 12; i++) {
    const row = rows[i];
    const month = (7 + i) % 12 + 1;
    const year = i < 5 ? 2026 : 2027;
    const expectedAccrualId = i === 1 ? 13142 : i === 2 ? 15041 : null;
    check(
      row.id === 701216 + i &&
        row.contract_id === 36 &&
        row.unit_id === 59 &&
        row.year === year &&
        row.month === month &&
        Number(row.expected_amount) === 2500 &&
        Number(row.paid_amount) === 2500 &&
        row.used_advance_account === false &&
        row.accrual_voucher_id === expectedAccrualId &&
        row.used_prepaid_account === (i === 1 || i === 2),
      "MONTH_SNAPSHOT_CHANGED_" + i
    );
    // The August and November expenses are already in the original payment.
    // Flag ONLY Dec 2026 through Jul 2027 for future automatic GL recognition.
    if (i >= 4) future.push(row.id);
  }
  check(future.length === 8, "FUTURE_MONTH_COUNT");
  return future;
}
