// Extracted from ./PayrollRunDialogs.tsx
import { formatUsd } from "@/lib/moneyDisplay";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { queryClient } from "@/lib/queryClient";
import type { FactoryPayrollState } from "../useFactoryPayroll";

export function PayrollPreviewDialog({ payroll }: { payroll: FactoryPayrollState }) {
  return (
    <Dialog open={payroll.previewOpen} onOpenChange={payroll.setPreviewOpen}>
      <DialogContent className="max-w-4xl flex flex-col max-h-[90vh]" data-testid="dialog-preview-payroll">
        <DialogHeader className="shrink-0">
          <DialogTitle>Payroll Preview</DialogTitle>
          <DialogDescription>
            {payroll.previewRows.length} workers · {payroll.runForm.periodStart} to {payroll.runForm.periodEnd} · Net
            Total: $
            {payroll.previewRows
              .reduce((s, r) => {
                const monthlyRate = parseFloat(payroll.transportOverrides[r.id] ?? r.transportMonthly.toFixed(2));
                const hasAtt = r.presentDates.length > 0 || r.absentDates.length > 0 || r.halfDayDates.length > 0;
                const prorated =
                  hasAtt && r.totalWorkingDays > 0 ? (r.presentDays / r.totalWorkingDays) * monthlyRate : monthlyRate;
                return s + r.base + r.bonus + prorated - parseFloat(payroll.advanceOverrides[r.id] || "0");
              }, 0)
              .toFixed(2)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
          {payroll.previewRows.map((r) => {
            const hasAtt = r.presentDates.length > 0 || r.absentDates.length > 0 || r.halfDayDates.length > 0;
            const deductAmt = parseFloat(payroll.advanceOverrides[r.id] || "0");
            const monthlyRate = parseFloat(payroll.transportOverrides[r.id] ?? r.transportMonthly.toFixed(2));
            const proratedTransport =
              hasAtt && r.totalWorkingDays > 0 ? (r.presentDays / r.totalWorkingDays) * monthlyRate : monthlyRate;
            const salaryDeductions = r.pendingDeductions || 0;
            const computedNet = r.base + r.bonus + proratedTransport - deductAmt - salaryDeductions;
            const isExpanded = payroll.expandedAdvanceWorkers.has(r.id);
            return (
              <div key={r.id} className="border rounded-md" data-testid={`row-preview-${r.id}`}>
                {/* Main worker row */}
                <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{r.name}</p>
                    {r.position && <p className="text-xs text-muted-foreground">{r.position}</p>}
                  </div>
                  {/* Attendance */}
                  <div className="flex items-center gap-2 text-xs">
                    {hasAtt ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-auto py-0.5 px-2 font-mono text-green-700 dark:text-green-400"
                          onClick={() =>
                            payroll.setAttendanceDetail({
                              name: r.name,
                              presentDates: r.presentDates,
                              absentDates: r.absentDates,
                              halfDayDates: r.halfDayDates,
                            })
                          }
                          data-testid={`button-present-${r.id}`}
                        >
                          {r.presentDays % 1 === 0 ? r.presentDays.toFixed(0) : r.presentDays}d present
                        </Button>
                        {r.absentDays > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-auto py-0.5 px-2 font-mono text-red-700 dark:text-red-400"
                            onClick={() =>
                              payroll.setAttendanceDetail({
                                name: r.name,
                                presentDates: r.presentDates,
                                absentDates: r.absentDates,
                                halfDayDates: r.halfDayDates,
                              })
                            }
                            data-testid={`button-absent-${r.id}`}
                          >
                            {r.absentDays % 1 === 0 ? r.absentDays.toFixed(0) : r.absentDays}d absent
                          </Button>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">No attendance</span>
                    )}
                  </div>
                  {/* Salary breakdown */}
                  <div className="flex flex-wrap items-center gap-3 text-sm font-mono ml-auto">
                    <span className="text-muted-foreground">Base: {formatUsd(r.base, 2)}</span>
                    {r.bonus > 0 && <span className="text-muted-foreground">Bonus: {formatUsd(r.bonus, 2)}</span>}
                    {r.transportMonthly > 0 && (
                      <span className="text-muted-foreground flex flex-wrap items-center gap-1">
                        <span>Transport/mo:</span>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={payroll.transportOverrides[r.id] ?? r.transportMonthly.toFixed(2)}
                          onChange={(e) =>
                            payroll.setTransportOverrides((prev) => ({ ...prev, [r.id]: e.target.value }))
                          }
                          className="w-20 h-6 text-xs font-mono px-1"
                          data-testid={`input-transport-${r.id}`}
                        />
                        {hasAtt && r.totalWorkingDays > 0 && (
                          <span className="text-xs text-amber-600 dark:text-amber-400 font-mono whitespace-nowrap">
                            {r.presentDays % 1 === 0 ? r.presentDays.toFixed(0) : r.presentDays}/{r.totalWorkingDays}d
                            {" = "}${proratedTransport.toFixed(2)}
                          </span>
                        )}
                      </span>
                    )}
                    <span className="font-semibold">Net: {formatUsd(computedNet, 2)}</span>
                  </div>
                </div>

                {/* Salary Deductions section */}
                {salaryDeductions > 0 && (
                  <div className="border-t bg-red-50/50 dark:bg-red-950/20 px-3 py-2 space-y-1">
                    {(r.pendingDeductionRecords || []).map((ded) => (
                      <div key={ded.id} className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-muted-foreground">Salary Deduction:</span>
                        <span className="text-sm font-mono font-semibold text-destructive">
                          -${parseFloat(ded.amount).toFixed(2)}
                        </span>
                        {ded.reason && <span className="text-xs text-muted-foreground">· {ded.reason}</span>}
                        <span className="text-xs text-muted-foreground italic">(pending, applied at generation)</span>
                        {payroll.canChangeExistingRecords && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-5 w-5 text-destructive"
                            title="Remove this deduction"
                            data-testid={`button-delete-deduction-${ded.id}`}
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                const res = await fetch(`/api/factory/workers/${r.id}/deductions/${ded.id}`, {
                                  method: "DELETE",
                                  credentials: "include",
                                });
                                if (!res.ok) {
                                  const err = await res.json();
                                  payroll.toast({
                                    title: "Failed to remove deduction",
                                    description: err.message,
                                    variant: "destructive",
                                  });
                                } else {
                                  queryClient.invalidateQueries({ queryKey: ["/api/factory/payrolls/preview"] });
                                }
                              } catch {
                                payroll.toast({ title: "Failed to remove deduction", variant: "destructive" });
                              }
                            }}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Advances section */}
                {r.totalAdvanceBalance > 0 && (
                  <div className="border-t bg-muted/30 px-3 py-2 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto py-0.5 px-1 gap-1 text-xs"
                        onClick={() =>
                          payroll.setExpandedAdvanceWorkers((prev) => {
                            const next = new Set(prev);
                            if (next.has(r.id)) next.delete(r.id);
                            else next.add(r.id);
                            return next;
                          })
                        }
                        data-testid={`button-expand-advances-${r.id}`}
                      >
                        {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        {r.pendingAdvances.length} outstanding advance{r.pendingAdvances.length !== 1 ? "s" : ""} ·
                        Total: {formatUsd(r.totalAdvanceBalance, 2)}
                      </Button>
                      <div className="flex items-center gap-2 ml-auto">
                        <span className="text-xs text-muted-foreground">Deduct:</span>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          max={r.totalAdvanceBalance}
                          value={payroll.advanceOverrides[r.id] ?? r.totalAdvanceBalance.toFixed(2)}
                          onChange={(e) => payroll.setAdvanceOverrides((prev) => ({ ...prev, [r.id]: e.target.value }))}
                          className="w-28 h-7 text-xs font-mono"
                          data-testid={`input-advance-deduct-${r.id}`}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() =>
                            payroll.setAdvanceOverrides((prev) => ({
                              ...prev,
                              [r.id]: r.totalAdvanceBalance.toFixed(2),
                            }))
                          }
                          data-testid={`button-deduct-all-${r.id}`}
                        >
                          All
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => payroll.setAdvanceOverrides((prev) => ({ ...prev, [r.id]: "0" }))}
                          data-testid={`button-deduct-none-${r.id}`}
                        >
                          None
                        </Button>
                      </div>
                    </div>

                    {/* Advance records breakdown */}
                    {isExpanded && (
                      <div className="space-y-1 pt-1">
                        {r.pendingAdvances.map((adv) => (
                          <div
                            key={adv.id}
                            className="flex flex-wrap items-center gap-2 text-xs py-1 border-t border-border/50"
                          >
                            <span className="font-mono text-muted-foreground">{adv.advanceDate}</span>
                            <span className="text-muted-foreground">
                              Original: <span className="font-mono">{formatUsd(parseFloat(adv.amount), 2)}</span>
                            </span>
                            <span>
                              Remaining:{" "}
                              <span className="font-mono font-medium">
                                {formatUsd(parseFloat(adv.remainingBalance), 2)}
                              </span>
                            </span>
                            {adv.notes && (
                              <span className="text-muted-foreground italic truncate max-w-[200px]">{adv.notes}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Outstanding Loans section (informational — not deducted from salary) */}
                {(r.outstandingLoans?.length ?? 0) > 0 && (
                  <div className="border-t bg-blue-50/40 dark:bg-blue-950/20 px-3 py-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        Outstanding Loan{(r.outstandingLoans?.length ?? 0) !== 1 ? "s" : ""} (manual repayment — not
                        deducted from salary):
                      </span>
                      <span className="text-sm font-mono font-medium text-blue-700 dark:text-blue-400">
                        {formatUsd(r.totalLoanBalance ?? 0, 2)}
                      </span>
                    </div>
                    <div className="space-y-0.5">
                      {r.outstandingLoans?.map((loan) => (
                        <div key={loan.id} className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                          <span className="font-mono">{loan.advanceDate}</span>
                          <span>
                            Remaining:{" "}
                            <span className="font-mono font-medium">
                              {formatUsd(parseFloat(loan.remainingBalance), 2)}
                            </span>
                          </span>
                          {loan.notes && <span className="italic truncate max-w-[200px]">{loan.notes}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => payroll.setPreviewOpen(false)}>
            Back
          </Button>
          <ExportButton
            kind="excel"
            variant="outline"
            onClick={async () => {
              try {
                const exportRows = payroll.previewRows.map((r) => {
                  const mRate = parseFloat(payroll.transportOverrides[r.id] ?? r.transportMonthly.toFixed(2));
                  const rHasAtt = r.presentDates.length > 0 || r.absentDates.length > 0 || r.halfDayDates.length > 0;
                  const transportPaid =
                    rHasAtt && r.totalWorkingDays > 0 ? (r.presentDays / r.totalWorkingDays) * mRate : mRate;
                  const advanceDeduction = parseFloat(payroll.advanceOverrides[r.id] || "0");
                  const salaryDeduction = r.pendingDeductions || 0;
                  const net = r.base + r.bonus + transportPaid - advanceDeduction - salaryDeduction;
                  return {
                    employeeCode: r.employeeCode || null,
                    name: r.name,
                    position: r.position || null,
                    presentDays: r.presentDays,
                    totalWorkingDays: r.totalWorkingDays,
                    absentDays: r.absentDays,
                    base: r.base,
                    bonus: r.bonus,
                    transportMonthly: mRate,
                    transportPaid,
                    salaryDeduction,
                    advanceDeduction,
                    net,
                  };
                });
                await downloadFromUrl("/api/factory/payrolls/preview-excel", {
                  method: "POST",
                  body: {
                    periodStart: payroll.runForm.periodStart,
                    periodEnd: payroll.runForm.periodEnd,
                    rows: exportRows,
                  },
                  fileName: exportFileName("payroll", "xlsx", {
                    from: payroll.runForm.periodStart,
                    to: payroll.runForm.periodEnd,
                  }),
                });
              } catch (error) {
                payroll.toast({
                  title: "Export failed",
                  description: error instanceof Error ? error.message : "Please try again.",
                  variant: "destructive",
                });
              }
            }}
            data-testid="button-export-payroll-excel"
          />
          {payroll.canChangeExistingRecords && (
            <Button
              onClick={() => payroll.generateMutation.mutate()}
              disabled={payroll.generateMutation.isPending || payroll.previewRows.length === 0}
              data-testid="button-confirm-payroll"
            >
              {payroll.generateMutation.isPending ? "Generating..." : `Generate ${payroll.previewRows.length} Records`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
