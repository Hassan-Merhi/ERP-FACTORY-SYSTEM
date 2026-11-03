/**
 * Read-only payroll reconciliation for a selected, fully-contained period.
 *
 * It is deliberately not an accounting journal. "DRAFT" is never cash paid,
 * but a draft can still have an accrued PAYROLL-GEN expense elsewhere.
 * A genuine payment to a former worker must not vanish from the expense
 * ledger just because that worker is now inactive.
 */
import { toMoney, MoneyDecimal } from "../../lib/money";

export interface PayrollReconciliationRecord {
  id: number;
  workerId: number;
  workerActive: boolean;
  status: string;
  periodStart: string;
  periodEnd: string;
  netSalary: string;
  advances: string;
  hasDaybookPayment: boolean;
}

function money(row: PayrollReconciliationRecord) {
  return toMoney(row.netSalary).plus(toMoney(row.advances));
}
const isPaid = (row: PayrollReconciliationRecord) => row.status === "PAID";
const fmt = (value: InstanceType<typeof MoneyDecimal>) => value.toFixed(2);
const zero = () => new MoneyDecimal(0);
function overlap(a: PayrollReconciliationRecord, b: PayrollReconciliationRecord) {
  return a.periodStart <= b.periodEnd && a.periodEnd >= b.periodStart;
}
function periodLength(row: PayrollReconciliationRecord) {
  return Date.parse(row.periodEnd + "T00:00:00Z") - Date.parse(row.periodStart + "T00:00:00Z");
}
const sum = (rows: PayrollReconciliationRecord[]) =>
  rows.reduce((total, row) => total.plus(money(row)), zero());

export function reconcilePeriodPayrolls(
  records: PayrollReconciliationRecord[],
  startDate: string,
  endDate: string
) {
  const inPeriod = records.filter(
    (row) => row.periodStart >= startDate && row.periodEnd <= endDate && row.periodStart <= row.periodEnd
  );
  const byWorker = new Map<number, PayrollReconciliationRecord[]>();
  for (const row of inPeriod) {
    const group = byWorker.get(row.workerId) || [];
    group.push(row);
    byWorker.set(row.workerId, group);
  }

  const canonicalPaid: PayrollReconciliationRecord[] = [];
  const overlappingPaid: PayrollReconciliationRecord[] = [];
  const drafts: PayrollReconciliationRecord[] = [];
  const otherUnpaid: PayrollReconciliationRecord[] = [];

  for (const group of byWorker.values()) {
    const paid = group.filter(isPaid).sort(
      (a, b) => periodLength(b) - periodLength(a) || b.id - a.id
    );
    const selected: PayrollReconciliationRecord[] = [];
    for (const row of paid) {
      if (selected.some((existing) => overlap(row, existing))) {
        overlappingPaid.push(row);
      } else {
        selected.push(row);
        canonicalPaid.push(row);
      }
    }
    drafts.push(...group.filter((row) => row.status === "DRAFT"));
    otherUnpaid.push(...group.filter((row) => row.status !== "DRAFT" && !isPaid(row)));
  }

  const activePaid = canonicalPaid.filter((row) => row.workerActive);
  const inactivePaid = canonicalPaid.filter((row) => !row.workerActive);
  const cashPaid = inPeriod.filter(isPaid);
  const missingPaymentEvidence = cashPaid.filter((row) => !row.hasDaybookPayment);
  const duplicatedAdvanceDeductions = overlappingPaid.reduce(
    (value, row) => value.plus(toMoney(row.advances)),
    zero()
  );

  return {
    startDate,
    endDate,
    canonicalActivePaid: fmt(sum(activePaid)),
    canonicalFormerWorkerPaid: fmt(sum(inactivePaid)),
    canonicalPaidTotal: fmt(sum(canonicalPaid)),
    overlappingPaidTotal: fmt(sum(overlappingPaid)),
    overlappingPaidAdvanceDeductions: fmt(duplicatedAdvanceDeductions),
    draftUnpaidTotal: fmt(sum(drafts)),
    otherUnpaidTotal: fmt(sum(otherUnpaid)),
    allPayrollRecordTotal: fmt(sum(inPeriod)),
    cashPaidNetTotal: fmt(
      cashPaid.reduce((total, row) => total.plus(toMoney(row.netSalary)), zero())
    ),
    canonicalPaidCount: canonicalPaid.length,
    formerWorkerPaidCount: inactivePaid.length,
    overlappingPaidCount: overlappingPaid.length,
    draftCount: drafts.length,
    missingPaymentEvidenceCount: missingPaymentEvidence.length,
    // These are payroll-record totals, NOT audited voucher account balances.
    requiresAccountingReview: overlappingPaid.length > 0 || drafts.length > 0 || missingPaymentEvidence.length > 0,
  };
}
