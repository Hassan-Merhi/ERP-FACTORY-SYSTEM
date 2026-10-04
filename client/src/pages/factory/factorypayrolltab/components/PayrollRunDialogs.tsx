import { getErrorDetails } from "@shared/errorUtils";
import { ChevronDown, ChevronRight, X, FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { queryClient } from "@/lib/queryClient";
import type { FactoryPayrollState } from "../useFactoryPayroll";

export function PayrollRunDialogs({ payroll }: { payroll: FactoryPayrollState }) {
  const {
    toast,
    runOpen,
    setRunOpen,
    runForm,
    setRunForm,
    previewOpen,
    setPreviewOpen,
    previewRows,
    advanceOverrides,
    setAdvanceOverrides,
    transportOverrides,
    setTransportOverrides,
    expandedAdvanceWorkers,
    setExpandedAdvanceWorkers,
    setAttendanceDetail,
    cashAccounts,
    activeWorkers,
    previewMutation,
    generateMutation,
  } = payroll;
  return (
    <>
      {/* Run Payroll Dialog */}
      <Dialog open={runOpen} onOpenChange={setRunOpen}>
        <DialogContent className="max-w-2xl flex flex-col max-h-[90vh]" data-testid="dialog-run-payroll">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>Run Payroll</DialogTitle>
            <DialogDescription>
              Configure the payroll period and settings, then preview before generating.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4 pr-1 min-h-0">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Period Start</Label>
                <Input
                  type="date"
                  value={runForm.periodStart}
                  onChange={(e) => setRunForm((f) => ({ ...f, periodStart: e.target.value }))}
                  data-testid="input-period-start"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Period End</Label>
                <Input
                  type="date"
                  value={runForm.periodEnd}
                  onChange={(e) => setRunForm((f) => ({ ...f, periodEnd: e.target.value }))}
                  data-testid="input-period-end"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Days Count (auto)</Label>
                <Input
                  type="number"
                  placeholder="Auto-calculated"
                  value={runForm.daysCount}
                  onChange={(e) => setRunForm((f) => ({ ...f, daysCount: e.target.value }))}
                  data-testid="input-days-count"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Bonus Per Worker</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={runForm.bonusPerWorker}
                  onChange={(e) => setRunForm((f) => ({ ...f, bonusPerWorker: e.target.value }))}
                  data-testid="input-bonus"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Cash Account (optional, used at payment)</Label>
              <Select
                value={runForm.cashAccountId}
                onValueChange={(v) => setRunForm((f) => ({ ...f, cashAccountId: v }))}
              >
                <SelectTrigger data-testid="select-cash-account">
                  <SelectValue placeholder="Select account (optional)" />
                </SelectTrigger>
                <SelectContent>
                  {cashAccounts?.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name} ({a.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Workers</Label>
              <div className="flex gap-3">
                <Button
                  variant={runForm.targetAll ? "default" : "outline"}
                  size="sm"
                  onClick={() => setRunForm((f) => ({ ...f, targetAll: true, pickedWorkerIds: [] }))}
                  data-testid="button-all-workers"
                >
                  All Active ({activeWorkers.length})
                </Button>
                <Button
                  variant={!runForm.targetAll ? "default" : "outline"}
                  size="sm"
                  onClick={() => setRunForm((f) => ({ ...f, targetAll: false }))}
                  data-testid="button-select-workers"
                >
                  Select Workers
                </Button>
              </div>
              {!runForm.targetAll && (
                <div className="max-h-40 overflow-y-auto border rounded-md p-2 space-y-1">
                  {activeWorkers.map((w) => (
                    <div key={w.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`worker-${w.id}`}
                        checked={runForm.pickedWorkerIds.includes(w.id)}
                        onCheckedChange={(v) =>
                          setRunForm((f) => ({
                            ...f,
                            pickedWorkerIds: v
                              ? [...f.pickedWorkerIds, w.id]
                              : f.pickedWorkerIds.filter((id) => id !== w.id),
                          }))
                        }
                        data-testid={`checkbox-worker-${w.id}`}
                      />
                      <label htmlFor={`worker-${w.id}`} className="text-sm cursor-pointer">
                        {w.fullName} — {w.position || "—"}
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Notes (optional)</Label>
              <Input
                value={runForm.notes}
                onChange={(e) => setRunForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="e.g. March 2026 payroll"
                data-testid="input-payroll-notes"
              />
            </div>
          </div>
          <DialogFooter className="flex-shrink-0">
            <Button variant="outline" onClick={() => setRunOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => previewMutation.mutate()}
              disabled={previewMutation.isPending}
              data-testid="button-preview-payroll"
            >
              <ChevronDown className="h-4 w-4 mr-2" />
              {previewMutation.isPending ? "Loading..." : "Preview"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-4xl flex flex-col max-h-[90vh]" data-testid="dialog-preview-payroll">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>Payroll Preview</DialogTitle>
            <DialogDescription>
              {previewRows.length} workers · {runForm.periodStart} to {runForm.periodEnd} · Net Total: $
              {previewRows
                .reduce((s, r) => {
                  const monthlyRate = parseFloat(transportOverrides[r.id] ?? r.transportMonthly.toFixed(2));
                  const hasAtt = r.presentDates.length > 0 || r.absentDates.length > 0 || r.halfDayDates.length > 0;
                  const prorated =
                    hasAtt && r.totalWorkingDays > 0 ? (r.presentDays / r.totalWorkingDays) * monthlyRate : monthlyRate;
                  return s + r.base + r.bonus + prorated - parseFloat(advanceOverrides[r.id] || "0");
                }, 0)
                .toFixed(2)}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
            {previewRows.map((r) => {
              const hasAtt = r.presentDates.length > 0 || r.absentDates.length > 0 || r.halfDayDates.length > 0;
              const deductAmt = parseFloat(advanceOverrides[r.id] || "0");
              const monthlyRate = parseFloat(transportOverrides[r.id] ?? r.transportMonthly.toFixed(2));
              const proratedTransport =
                hasAtt && r.totalWorkingDays > 0 ? (r.presentDays / r.totalWorkingDays) * monthlyRate : monthlyRate;
              const salaryDeductions = r.pendingDeductions || 0;
              const computedNet = r.base + r.bonus + proratedTransport - deductAmt - salaryDeductions;
              const isExpanded = expandedAdvanceWorkers.has(r.id);
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
                              setAttendanceDetail({
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
                                setAttendanceDetail({
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
                      <span className="text-muted-foreground">Base: ${r.base.toFixed(2)}</span>
                      {r.bonus > 0 && <span className="text-muted-foreground">Bonus: ${r.bonus.toFixed(2)}</span>}
                      {r.transportMonthly > 0 && (
                        <span className="text-muted-foreground flex flex-wrap items-center gap-1">
                          <span>Transport/mo:</span>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            value={transportOverrides[r.id] ?? r.transportMonthly.toFixed(2)}
                            onChange={(e) => setTransportOverrides((prev) => ({ ...prev, [r.id]: e.target.value }))}
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
                      <span className="font-semibold">Net: ${computedNet.toFixed(2)}</span>
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
                                  toast({
                                    title: "Failed to remove deduction",
                                    description: err.message,
                                    variant: "destructive",
                                  });
                                } else {
                                  queryClient.invalidateQueries({ queryKey: ["/api/factory/payrolls/preview"] });
                                }
                              } catch {
                                toast({ title: "Failed to remove deduction", variant: "destructive" });
                              }
                            }}
                          >
                            <X className="h-3 w-3" />
                          </Button>
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
                            setExpandedAdvanceWorkers((prev) => {
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
                          Total: ${r.totalAdvanceBalance.toFixed(2)}
                        </Button>
                        <div className="flex items-center gap-2 ml-auto">
                          <span className="text-xs text-muted-foreground">Deduct:</span>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            max={r.totalAdvanceBalance}
                            value={advanceOverrides[r.id] ?? r.totalAdvanceBalance.toFixed(2)}
                            onChange={(e) => setAdvanceOverrides((prev) => ({ ...prev, [r.id]: e.target.value }))}
                            className="w-28 h-7 text-xs font-mono"
                            data-testid={`input-advance-deduct-${r.id}`}
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() =>
                              setAdvanceOverrides((prev) => ({ ...prev, [r.id]: r.totalAdvanceBalance.toFixed(2) }))
                            }
                            data-testid={`button-deduct-all-${r.id}`}
                          >
                            All
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setAdvanceOverrides((prev) => ({ ...prev, [r.id]: "0" }))}
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
                                Original: <span className="font-mono">${parseFloat(adv.amount).toFixed(2)}</span>
                              </span>
                              <span>
                                Remaining:{" "}
                                <span className="font-mono font-medium">
                                  ${parseFloat(adv.remainingBalance).toFixed(2)}
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
                          ${(r.totalLoanBalance ?? 0).toFixed(2)}
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        {r.outstandingLoans?.map((loan) => (
                          <div key={loan.id} className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                            <span className="font-mono">{loan.advanceDate}</span>
                            <span>
                              Remaining:{" "}
                              <span className="font-mono font-medium">
                                ${parseFloat(loan.remainingBalance).toFixed(2)}
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
          <DialogFooter className="flex-shrink-0">
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>
              Back
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  const exportRows = previewRows.map((r) => {
                    const mRate = parseFloat(transportOverrides[r.id] ?? r.transportMonthly.toFixed(2));
                    const rHasAtt = r.presentDates.length > 0 || r.absentDates.length > 0 || r.halfDayDates.length > 0;
                    const transportPaid =
                      rHasAtt && r.totalWorkingDays > 0 ? (r.presentDays / r.totalWorkingDays) * mRate : mRate;
                    const advanceDeduction = parseFloat(advanceOverrides[r.id] || "0");
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
                  const resp = await fetch("/api/factory/payrolls/preview-excel", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({
                      periodStart: runForm.periodStart,
                      periodEnd: runForm.periodEnd,
                      rows: exportRows,
                    }),
                  });
                  if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.message || "Export failed");
                  }
                  const blob = await resp.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `Payroll_${runForm.periodStart}_${runForm.periodEnd}.xlsx`;
                  a.click();
                  URL.revokeObjectURL(url);
                } catch (err) {
                  toast({
                    title: getErrorDetails(err).optionalMessage || "Failed to export Excel",
                    variant: "destructive",
                  });
                }
              }}
              data-testid="button-export-payroll-excel"
            >
              <FileDown className="h-4 w-4 mr-2" />
              Export Excel
            </Button>
            <Button
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending || previewRows.length === 0}
              data-testid="button-confirm-payroll"
            >
              {generateMutation.isPending ? "Generating..." : `Generate ${previewRows.length} Records`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
