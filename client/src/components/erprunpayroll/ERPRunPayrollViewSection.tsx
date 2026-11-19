// Extracted from ./ERPRunPayrollView.tsx to keep that module under the source-size cap.
import { ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { useERPRunPayrollModel } from "./useERPRunPayrollModel";

export interface ERPRunPayrollViewProps {
  model: ReturnType<typeof useERPRunPayrollModel>;
}

export function useERPRunPayrollViewState({ model }: ERPRunPayrollViewProps) {
  const {
    activeTab,
    setActiveTab,
    canChangeExistingRecords,
    canCreate,
    setStep,
    previewItems,
    previewDate,
    setPreviewDate,
    previewNotes,
    setPreviewNotes,
    payDialogRun,
    setPayDialogRun,
    payAccountId,
    setPayAccountId,
    deleteRunId,
    setDeleteRunId,
    undoRunId,
    setUndoRunId,
    payrollRuns,
    runsLoading,
    cashAccounts,
    advanceBalanceByEmployee,
    updateDeduction,
    saveDraftMutation,
    payRunMutation,
    deleteRunMutation,
    undoRunMutation,
    printRun,
    exportRunExcel,
    isLoading,
    previewTotalNet,
    previewTotalBase,
    formatAmount,
  } = model;
  return {
    activeTab,
    advanceBalanceByEmployee,
    canChangeExistingRecords,
    canCreate,
    cashAccounts,
    deleteRunId,
    deleteRunMutation,
    exportRunExcel,
    formatAmount,
    isLoading,
    payAccountId,
    payDialogRun,
    payRunMutation,
    payrollRuns,
    previewDate,
    previewItems,
    previewNotes,
    previewTotalBase,
    previewTotalNet,
    printRun,
    runsLoading,
    saveDraftMutation,
    setActiveTab,
    setDeleteRunId,
    setPayAccountId,
    setPayDialogRun,
    setPreviewDate,
    setPreviewNotes,
    setStep,
    setUndoRunId,
    undoRunId,
    undoRunMutation,
    updateDeduction,
  };
}

export function ERPRunPayrollViewSection({
  advanceBalanceByEmployee,
  canCreate,
  formatAmount,
  previewDate,
  previewItems,
  previewNotes,
  previewTotalBase,
  previewTotalNet,
  saveDraftMutation,
  setPreviewDate,
  setPreviewNotes,
  setStep,
  updateDeduction,
}: Pick<
  ReturnType<typeof useERPRunPayrollViewState>,
  | "advanceBalanceByEmployee"
  | "canCreate"
  | "formatAmount"
  | "previewDate"
  | "previewItems"
  | "previewNotes"
  | "previewTotalBase"
  | "previewTotalNet"
  | "saveDraftMutation"
  | "setPreviewDate"
  | "setPreviewNotes"
  | "setStep"
  | "updateDeduction"
>) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setStep(1)} data-testid="button-back-to-select">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
          <h3 className="font-semibold text-sm">
            Payroll Preview — {previewItems.length} worker{previewItems.length !== 1 ? "s" : ""}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          {canCreate("POST", "/api/payroll/runs") && (
            <Button
              onClick={() => saveDraftMutation.mutate()}
              disabled={saveDraftMutation.isPending || previewTotalNet <= 0}
              data-testid="button-save-draft"
            >
              {saveDraftMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Save as Draft
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Payroll Date</Label>
          <Input
            type="date"
            value={previewDate}
            onChange={(e) => setPreviewDate(e.target.value)}
            data-testid="input-preview-date"
          />
        </div>
        <div className="space-y-2">
          <Label>Notes (optional)</Label>
          <Input
            placeholder="e.g. March 2026 payroll"
            value={previewNotes}
            onChange={(e) => setPreviewNotes(e.target.value)}
            data-testid="input-preview-notes"
          />
        </div>
      </div>

      <div className="border rounded-md overflow-x-auto">
        <Table mobileLayout="cards">
          <TableHeader>
            <TableRow>
              <TableHead>Worker</TableHead>
              <TableHead className="text-muted-foreground text-xs font-medium">Group</TableHead>
              <TableHead className="text-right">Base Salary</TableHead>
              <TableHead className="text-right w-40">Advance Deduction</TableHead>
              <TableHead className="text-right">Deductions</TableHead>
              <TableHead className="text-right">Net Pay</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {previewItems.map((it, idx) => {
              const advBal = advanceBalanceByEmployee[it.employeeId] || 0;
              return (
                <TableRow key={idx} data-testid={`row-preview-${it.employeeId}`}>
                  <TableCell className="font-medium text-sm">{it.employeeName}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{it.groupName}</TableCell>
                  <TableCell className="text-right text-sm">{formatAmount(it.baseSalary)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex flex-col items-end gap-1">
                      <Input
                        type="number"
                        min="0"
                        max={String(it.baseSalary)}
                        step="0.01"
                        placeholder="0.00"
                        className="h-8 text-sm w-28 text-right"
                        value={it.deduction === 0 ? "" : it.deduction}
                        onChange={(e) => updateDeduction(idx, e.target.value)}
                        data-testid={`input-deduction-${it.employeeId}`}
                      />
                      {advBal > 0 &&
                        (() => {
                          const remaining = advBal - it.deduction;
                          return remaining > 0.005 ? (
                            <span className="text-xs text-amber-600 dark:text-amber-400">
                              Remaining: {formatAmount(remaining)}
                            </span>
                          ) : (
                            <span className="text-xs text-green-600 dark:text-green-400">Fully deducted</span>
                          );
                        })()}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {it.pendingDeductions > 0 ? (
                      <span className="text-orange-600 dark:text-orange-400 font-mono">
                        -{formatAmount(it.pendingDeductions)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-semibold text-sm" data-testid={`text-net-${it.employeeId}`}>
                    {formatAmount(it.netPay)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="flex justify-end gap-6 text-sm text-muted-foreground px-1">
        <span>
          Total Base: <span className="font-semibold text-foreground">{formatAmount(previewTotalBase)}</span>
        </span>
        <span>
          Net Payable: <span className="font-semibold text-foreground">{formatAmount(previewTotalNet)}</span>
        </span>
      </div>
    </div>
  );
}
