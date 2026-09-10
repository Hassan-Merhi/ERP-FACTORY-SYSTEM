/**
 * PAYROLL_PAYMENT detail view: earnings breakdown, deductions and net pay.
 *
 * Extracted from ViewEntryModal, where it was an early-return branch. The
 * branch declared no hooks, so this is a straight move behind a props
 * boundary rather than a behavioural change.
 */
import { DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/formatNumber";
import type { BadgeVariant, DaybookEntry, DisplayDate, PayrollSummary } from "./types";

export function PayrollPaymentView({
  entry,
  payrollSummary,
  formatDisplayDate,
  badgeVariant,
  badgeClass,
}: {
  entry: DaybookEntry;
  payrollSummary: PayrollSummary | null | undefined;
  formatDisplayDate: DisplayDate;
  badgeVariant: BadgeVariant;
  badgeClass: string;
}) {
  const p = payrollSummary;
  const n = (v: string | number | undefined) => parseFloat(String(v || "0"));

  const grossEarnings = p
    ? n(p.baseSalary) + n(p.baleEarnings) + n(p.kgEarnings) + n(p.overtimePay) + n(p.bonuses) + n(p.transport)
    : 0;
  const _totalDeductions = p ? n(p.deductions) + n(p.advances) : 0;
  const netPay = p ? n(p.netSalary) : 0;

  const periodLabel = p ? `${p.periodStart} – ${p.periodEnd}` : "—";

  return (
    <>
      <DialogHeader>
        <DialogTitle>Payroll Payment</DialogTitle>
        <DialogDescription>{formatDisplayDate(entry.txDate + "T00:00:00")}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        {!p ? (
          <p className="text-sm text-muted-foreground">Loading payroll details…</p>
        ) : (
          <>
            {/* Worker + period card */}
            <div className="rounded-md border p-4">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <p className="font-semibold text-base">{p.workerName || `Worker #${p.workerId}`}</p>
                  {p.workerPosition && <p className="text-xs text-muted-foreground">{p.workerPosition}</p>}
                  {p.workerCode && <p className="text-xs text-muted-foreground">ID: {p.workerCode}</p>}
                </div>
                <Badge variant={badgeVariant} className={badgeClass}>
                  {p.status}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-2">Period: {periodLabel}</p>
            </div>

            {/* Account flow: From → To */}
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 border-b">
                    <th
                      className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide"
                      colSpan={2}
                    >
                      Payment Accounts
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b">
                    <td className="px-3 py-2 text-muted-foreground w-1/3">Paid From</td>
                    <td className="px-3 py-2 font-medium">{p.cashAccountName || "Cash"}</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 text-muted-foreground">Paid To</td>
                    <td className="px-3 py-2 font-medium">{p.workerName || `Worker #${p.workerId}`}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Earnings breakdown */}
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 border-b">
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Earnings Breakdown
                    </th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {n(p.baseSalary) > 0 && (
                    <tr className="border-b">
                      <td className="px-3 py-2">Base Salary</td>
                      <td className="px-3 py-2 text-right font-mono">${formatNumber(n(p.baseSalary))}</td>
                    </tr>
                  )}
                  {n(p.baleEarnings) > 0 && (
                    <tr className="border-b">
                      <td className="px-3 py-2">
                        Bale Earnings
                        {n(p.balesCount) > 0 && (
                          <span className="text-xs text-muted-foreground ml-1">({p.balesCount} bales)</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">${formatNumber(n(p.baleEarnings))}</td>
                    </tr>
                  )}
                  {n(p.kgEarnings) > 0 && (
                    <tr className="border-b">
                      <td className="px-3 py-2">
                        KG Earnings
                        {n(p.kgProcessed) > 0 && (
                          <span className="text-xs text-muted-foreground ml-1">
                            ({formatNumber(n(p.kgProcessed))} kg)
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">${formatNumber(n(p.kgEarnings))}</td>
                    </tr>
                  )}
                  {n(p.overtimePay) > 0 && (
                    <tr className="border-b">
                      <td className="px-3 py-2">
                        Overtime
                        {n(p.overtimeHours) > 0 && (
                          <span className="text-xs text-muted-foreground ml-1">
                            ({formatNumber(n(p.overtimeHours))} hrs)
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">${formatNumber(n(p.overtimePay))}</td>
                    </tr>
                  )}
                  {n(p.bonuses) > 0 && (
                    <tr className="border-b">
                      <td className="px-3 py-2">Bonuses</td>
                      <td className="px-3 py-2 text-right font-mono">${formatNumber(n(p.bonuses))}</td>
                    </tr>
                  )}
                  {n(p.transport) > 0 && (
                    <tr className="border-b">
                      <td className="px-3 py-2">Transport</td>
                      <td className="px-3 py-2 text-right font-mono">${formatNumber(n(p.transport))}</td>
                    </tr>
                  )}
                  <tr className="border-b bg-muted/20">
                    <td className="px-3 py-2 font-medium">Gross Earnings</td>
                    <td className="px-3 py-2 text-right font-mono font-medium">${formatNumber(grossEarnings)}</td>
                  </tr>
                  {n(p.deductions) > 0 && (
                    <tr className="border-b">
                      <td className="px-3 py-2 text-destructive">Deductions</td>
                      <td className="px-3 py-2 text-right font-mono text-destructive">
                        −${formatNumber(n(p.deductions))}
                      </td>
                    </tr>
                  )}
                  {n(p.advances) > 0 && (
                    <tr className="border-b">
                      <td className="px-3 py-2 text-destructive">Advance Recovery</td>
                      <td className="px-3 py-2 text-right font-mono text-destructive">
                        −${formatNumber(n(p.advances))}
                      </td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/50 font-bold border-t">
                    <td className="px-3 py-2">Net Pay</td>
                    <td className="px-3 py-2 text-right font-mono">${formatNumber(netPay)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Attendance summary */}
            {(n(p.presentDays) > 0 || n(p.absentDays) > 0) && (
              <div className="flex gap-4 text-sm">
                <div className="flex-1 rounded-md border px-3 py-2 text-center">
                  <p className="text-xs text-muted-foreground">Days Present</p>
                  <p className="font-semibold">{p.presentDays}</p>
                </div>
                <div className="flex-1 rounded-md border px-3 py-2 text-center">
                  <p className="text-xs text-muted-foreground">Days Absent</p>
                  <p className="font-semibold">{p.absentDays}</p>
                </div>
                {p.totalWorkingDays > 0 && (
                  <div className="flex-1 rounded-md border px-3 py-2 text-center">
                    <p className="text-xs text-muted-foreground">Working Days</p>
                    <p className="font-semibold">{p.totalWorkingDays}</p>
                  </div>
                )}
              </div>
            )}

            {p.notes && <div className="rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{p.notes}</div>}
          </>
        )}
      </div>
    </>
  );
}
