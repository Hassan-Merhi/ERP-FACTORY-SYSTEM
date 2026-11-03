/**
 * Prevent a second generation from calculating the same worker's wages for
 * overlapping days. Includes drafts: two competing drafts also cause multiple
 * salary-expense accruals. The existing exact batch replay is handled by its
 * caller before this guard is checked.
 */
export interface ExistingPayrollPeriod {
  id: number;
  workerId: number;
  periodStart: string;
  periodEnd: string;
  status: string;
}

export class PayrollPeriodOverlapError extends Error {
  readonly status = 409;
  constructor(matches: ExistingPayrollPeriod[]) {
    super(
      `Overlapping payroll exists for worker(s) ${[...new Set(matches.map((row) => row.workerId))]
        .sort((a, b) => a - b)
        .slice(0, 10)
        .join(", ")}. Review existing draft/paid payroll periods before generating another overlapping salary.`
    );
    this.name = "PayrollPeriodOverlapError";
  }
}

export function assertNoOverlappingPayroll(
  existing: ExistingPayrollPeriod[],
  workerIds: readonly number[],
  startDate: string,
  endDate: string
): void {
  const requested = new Set(workerIds);
  const conflicts = existing.filter(
    (row) => requested.has(row.workerId) && row.periodStart <= endDate && row.periodEnd >= startDate
  );
  if (conflicts.length) throw new PayrollPeriodOverlapError(conflicts);
}
