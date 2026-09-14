export interface PayrollAccountingAllocation {
  netSalary: string;
  advances: string;
  salaryExpense: string;
  bonusExpense: string;
  netCents: number;
  advanceCents: number;
  grossCents: number;
}

function cents(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be finite`);
  const result = Math.round(parsed * 100);
  if (!Number.isSafeInteger(result)) throw new Error(`${field} is outside safe accounting range`);
  return result;
}

export function moneyFromCents(value: number): string {
  if (!Number.isSafeInteger(value)) throw new Error("money cents must be a safe integer");
  return (value / 100).toFixed(2);
}

/**
 * Normalize one payroll row onto a single cent-exact accounting equation:
 *
 *   salary expense + bonus expense = net salary + advance settlement
 *
 * Payroll rows are persisted at two decimals. Building the journal from the
 * same cent values prevents accumulated float/rounding drift across dozens of
 * workers. Any unavoidable component rounding is absorbed into salary expense,
 * never into the payable/advance control accounts.
 */
export function allocatePayrollAccountingAmounts(input: {
  netSalary: string | number;
  advances: string | number;
  bonus: string | number;
}): PayrollAccountingAllocation {
  const netCents = cents(input.netSalary, "netSalary");
  const advanceCents = cents(input.advances, "advances");
  if (netCents < 0 || advanceCents < 0) {
    throw new Error("Payroll net salary and advances must not be negative");
  }

  const grossCents = netCents + advanceCents;
  const requestedBonusCents = Math.max(0, cents(input.bonus, "bonus"));
  const bonusCents = Math.min(requestedBonusCents, grossCents);
  const salaryCents = grossCents - bonusCents;

  return {
    netSalary: moneyFromCents(netCents),
    advances: moneyFromCents(advanceCents),
    salaryExpense: moneyFromCents(salaryCents),
    bonusExpense: moneyFromCents(bonusCents),
    netCents,
    advanceCents,
    grossCents,
  };
}
