// Extracted from ./FactoryEmployeePayrollTab.tsx
import { DollarSign, Loader2, Minus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { fmt, useFactoryEmployeePayrollTabState } from "./useFactoryEmployeePayrollTabState";

export function FactoryEmployeePayrollTabDialog({
  amounts,
  deductions,
  employees,
  endDate,
  loadPreview,
  payDate,
  payEffectiveDate,
  payNotes,
  payrollMutation,
  payrollOpen,
  previewLoading,
  previewRows,
  setAmounts,
  setDeductions,
  setEndDate,
  setPayDate,
  setPayEffectiveDate,
  setPayNotes,
  setPayrollOpen,
  setStartDate,
  startDate,
  totalNet,
}: Pick<
  ReturnType<typeof useFactoryEmployeePayrollTabState>,
  | "amounts"
  | "deductions"
  | "employees"
  | "endDate"
  | "loadPreview"
  | "payDate"
  | "payEffectiveDate"
  | "payNotes"
  | "payrollMutation"
  | "payrollOpen"
  | "previewLoading"
  | "previewRows"
  | "setAmounts"
  | "setDeductions"
  | "setEndDate"
  | "setPayDate"
  | "setPayEffectiveDate"
  | "setPayNotes"
  | "setPayrollOpen"
  | "setStartDate"
  | "startDate"
  | "totalNet"
>) {
  return (
    <Dialog open={payrollOpen} onOpenChange={setPayrollOpen}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Run Employee Payroll</DialogTitle>
          <DialogDescription>
            Salary is auto-calculated from attendance. You can edit any values before paying.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end">
            <div>
              <Label>Period Start</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                data-testid="input-payroll-start"
              />
            </div>
            <div>
              <Label>Period End</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                data-testid="input-payroll-end"
              />
            </div>
            <div>
              <Label>Payment Date</Label>
              <Input
                type="date"
                value={payDate}
                onChange={(e) => setPayDate(e.target.value)}
                data-testid="input-payroll-date"
              />
            </div>
            <Button
              variant="outline"
              onClick={loadPreview}
              disabled={previewLoading}
              data-testid="button-recalculate-payroll"
              title="Recalculate salaries for selected period"
            >
              {previewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>
                Effective Date <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                type="date"
                value={payEffectiveDate}
                onChange={(e) => setPayEffectiveDate(e.target.value)}
                data-testid="input-payroll-effective-date"
              />
            </div>
            <div>
              <Label>Notes</Label>
              <Input
                placeholder="e.g. March 2026..."
                value={payNotes}
                onChange={(e) => setPayNotes(e.target.value)}
                data-testid="input-payroll-notes"
              />
            </div>
          </div>

          {/* Column headers */}
          <div className="grid grid-cols-[1fr_80px_80px_80px_24px_80px_80px] gap-x-2 items-center px-3 pb-1 text-xs text-muted-foreground font-medium border-b">
            <span>Employee</span>
            <span className="text-right">Days</span>
            <span className="text-right">Salary</span>
            <span className="text-right">Advance</span>
            <span />
            <span className="text-right">Deduct</span>
            <span className="text-right">Net</span>
          </div>

          <div className="rounded-md border divide-y">
            {employees.map((emp) => {
              const p = previewRows[emp.id];
              const sal = parseFloat(amounts[emp.id] || "0") || 0;
              const ded = parseFloat(deductions[emp.id] || "0") || 0;
              const net = Math.max(0, sal - ded);
              return (
                <div
                  key={emp.id}
                  className="grid grid-cols-[1fr_80px_80px_80px_24px_80px_80px] gap-x-2 items-center px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {emp.firstName} {emp.lastName}
                    </p>
                    <p className="text-xs text-muted-foreground">{emp.code || emp.department || ""}</p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    {p ? (
                      <span title={`Effective: ${p.presentDays}, Half: ${p.halfDays}, Absent: ${p.absentDays}`}>
                        {`${p.presentDays}/${p.daysInMonth}`}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </div>
                  <Input
                    type="number"
                    className="w-20 text-right text-sm"
                    placeholder="0.00"
                    value={amounts[emp.id] || ""}
                    onChange={(e) => setAmounts((a) => ({ ...a, [emp.id]: e.target.value }))}
                    data-testid={`input-payroll-amount-${emp.id}`}
                  />
                  <div className="text-right text-xs text-muted-foreground">
                    {p && parseFloat(p.outstandingAdvance) > 0 ? (
                      <span className="text-amber-600 dark:text-amber-400">{fmt(p.outstandingAdvance)}</span>
                    ) : (
                      <span>-</span>
                    )}
                  </div>
                  <Minus className="h-3.5 w-3.5 text-muted-foreground shrink-0 mx-auto" />
                  <Input
                    type="number"
                    className="w-20 text-right text-sm"
                    placeholder="0.00"
                    min="0"
                    value={deductions[emp.id] || ""}
                    onChange={(e) => setDeductions((d) => ({ ...d, [emp.id]: e.target.value }))}
                    data-testid={`input-payroll-deduction-${emp.id}`}
                  />
                  <div
                    className={`text-right font-mono text-sm font-semibold ${ded > 0 ? "text-amber-600 dark:text-amber-400" : ""}`}
                  >
                    {fmt(net)}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex justify-between text-sm font-medium pt-1 border-t">
            <span>Total Net Payroll</span>
            <span className="font-mono">{fmt(totalNet)}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setPayrollOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => payrollMutation.mutate()}
            disabled={payrollMutation.isPending || totalNet === 0}
            data-testid="button-confirm-payroll"
          >
            {payrollMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <DollarSign className="h-4 w-4 mr-2" />
            )}
            Pay {fmt(totalNet)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
