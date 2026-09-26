export interface EmployeeBalanceTotals {
  debit: number;
  credit: number;
}

export interface EmployeePositionRow {
  id: number;
  openingBalance?: string | null;
  openingBalanceSide?: string | null;
}

export interface EmployeeNetPosition {
  advances: number;
  liabilities: number;
}

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Employee subledger convention:
 * - debit balance = employee owes the company (advance / receivable)
 * - credit balance = company owes the employee (payroll liability)
 *
 * Opening balances follow the same debit-positive / credit-negative convention.
 */
export function computeEmployeeNetPosition(
  employees: EmployeePositionRow[],
  balances: Map<number, EmployeeBalanceTotals>
): EmployeeNetPosition {
  let advances = 0;
  let liabilities = 0;

  for (const employee of employees) {
    const opening = Number.parseFloat(employee.openingBalance || "0") || 0;
    const openingSide = employee.openingBalanceSide === "Dr" ? "Dr" : "Cr";
    const signedOpening = openingSide === "Dr" ? opening : -opening;
    const balance = balances.get(employee.id) || { debit: 0, credit: 0 };
    const netDebitBalance = signedOpening + balance.debit - balance.credit;

    if (netDebitBalance > 0) advances += netDebitBalance;
    else if (netDebitBalance < 0) liabilities += Math.abs(netDebitBalance);
  }

  return {
    advances: round2(advances),
    liabilities: round2(liabilities),
  };
}

export interface ManagedEmployeeAdvance {
  employeeId: number;
  postedDebit: number;
  remainingBalance: number;
}

/**
 * Replace the original employee debit created by a managed salary-advance
 * voucher with the advance table's remaining balance. This keeps direct
 * employee withdrawals in the subledger while allowing payroll/manual
 * deductions to reduce managed advances without double-counting them.
 */
export function computeEmployeeNetPositionWithManagedAdvances(
  employees: EmployeePositionRow[],
  balances: Map<number, EmployeeBalanceTotals>,
  managedAdvances: ManagedEmployeeAdvance[]
): EmployeeNetPosition {
  const adjusted = new Map<number, EmployeeBalanceTotals>();
  for (const [employeeId, balance] of balances) {
    adjusted.set(employeeId, { ...balance });
  }

  for (const advance of managedAdvances) {
    const current = adjusted.get(advance.employeeId) || { debit: 0, credit: 0 };
    adjusted.set(advance.employeeId, {
      debit: current.debit - advance.postedDebit + advance.remainingBalance,
      credit: current.credit,
    });
  }

  return computeEmployeeNetPosition(employees, adjusted);
}
