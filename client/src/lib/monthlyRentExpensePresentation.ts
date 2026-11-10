/**
 * Presentation-only normalization of monthly rent expense.
 *
 * The original journal and voucher debits/credits remain on the server and
 * in the voucher drilldown. Only the HADI #1007 monthly summary uses this
 * net-side presentation after the retired #881 entries are included.
 *
 * Round monetary inputs to integer cents BEFORE netting to avoid JS float
 * artifacts. A credit-net month must stay visible as credit, not disappear.
 */
export type MonthlyDebitCredit = Readonly<{ debit: number; credit: number }>;

export function netExpenseMovement(row: MonthlyDebitCredit): { debit: number; credit: number } {
  const debitCents = Math.round(row.debit * 100);
  const creditCents = Math.round(row.credit * 100);
  const netCents = debitCents - creditCents;
  return {
    debit: Math.max(0, netCents) / 100,
    credit: Math.max(0, -netCents) / 100,
  };
}

export function sumPresentedMonthlyMovements(
  rows: readonly MonthlyDebitCredit[]
): { debit: number; credit: number } {
  return {
    debit: rows.reduce((cents, row) => cents + Math.round(row.debit * 100), 0) / 100,
    credit: rows.reduce((cents, row) => cents + Math.round(row.credit * 100), 0) / 100,
  };
}
