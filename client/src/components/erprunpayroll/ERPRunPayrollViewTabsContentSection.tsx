// Extracted from ./ERPRunPayrollView.tsx to keep that module under the source-size cap.
import { DollarSign, FileSpreadsheet, History, Loader2, Printer, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TabsContent } from "@/components/ui/tabs";
import { useERPRunPayrollViewState } from "./ERPRunPayrollViewSection";

export function ERPRunPayrollViewTabsContentSection({
  canChangeExistingRecords,
  exportRunExcel,
  formatAmount,
  payrollRuns,
  printRun,
  runsLoading,
  setDeleteRunId,
  setPayAccountId,
  setPayDialogRun,
  setUndoRunId,
}: Pick<
  ReturnType<typeof useERPRunPayrollViewState>,
  | "canChangeExistingRecords"
  | "exportRunExcel"
  | "formatAmount"
  | "payrollRuns"
  | "printRun"
  | "runsLoading"
  | "setDeleteRunId"
  | "setPayAccountId"
  | "setPayDialogRun"
  | "setUndoRunId"
>) {
  return (
    <TabsContent value="history" className="mt-4">
      {runsLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-md" />
          ))}
        </div>
      ) : payrollRuns.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <History className="mx-auto h-10 w-10 mb-3 opacity-40" />
          <p className="font-medium">No payroll runs yet</p>
          <p className="text-sm mt-1">Select workers and run a payroll to get started.</p>
        </div>
      ) : (
        <>
          <div className="border rounded-md overflow-x-auto">
            <Table mobileLayout="cards">
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead className="text-right">Workers</TableHead>
                  <TableHead className="text-right">Total Base</TableHead>
                  <TableHead className="text-right">Net Payable</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payrollRuns.map((run) => (
                  <TableRow key={run.id} data-testid={`row-run-${run.id}`}>
                    <TableCell className="font-medium text-sm">{run.date}</TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-48 truncate">
                      {run.notes || "—"}
                    </TableCell>
                    <TableCell className="text-right text-sm">{run.itemCount}</TableCell>
                    <TableCell className="text-right text-sm">{formatAmount(parseFloat(run.totalBase))}</TableCell>
                    <TableCell className="text-right font-semibold text-sm">
                      {formatAmount(parseFloat(run.totalNet))}
                    </TableCell>
                    <TableCell>
                      {run.status === "PAID" ? (
                        <Badge
                          variant="secondary"
                          className="bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400 no-default-active-elevate"
                        >
                          Paid
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="bg-yellow-50 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 no-default-active-elevate"
                        >
                          Draft
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => printRun(run)}
                          title="Print / PDF"
                          data-testid={`button-print-run-${run.id}`}
                        >
                          <Printer className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => exportRunExcel(run)}
                          title="Export Excel"
                          data-testid={`button-excel-run-${run.id}`}
                        >
                          <FileSpreadsheet className="h-4 w-4" />
                        </Button>
                        {canChangeExistingRecords && run.status === "DRAFT" && (
                          <>
                            <Button
                              size="sm"
                              onClick={() => {
                                setPayDialogRun(run);
                                setPayAccountId("");
                              }}
                              data-testid={`button-pay-run-${run.id}`}
                            >
                              <DollarSign className="h-3.5 w-3.5 mr-1" />
                              Pay
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDeleteRunId(run.id)}
                              className="text-destructive"
                              title="Delete draft"
                              data-testid={`button-delete-run-${run.id}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                        {canChangeExistingRecords && run.status === "PAID" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setUndoRunId(run.id)}
                            className="text-destructive"
                            title="Undo payroll — reverses ledger entries and advance deductions"
                            data-testid={`button-undo-run-${run.id}`}
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </TabsContent>
  );
}

export function ERPRunPayrollViewDialogSection({
  cashAccounts,
  formatAmount,
  payAccountId,
  payDialogRun,
  payRunMutation,
  setPayAccountId,
  setPayDialogRun,
}: Pick<
  ReturnType<typeof useERPRunPayrollViewState>,
  | "cashAccounts"
  | "formatAmount"
  | "payAccountId"
  | "payDialogRun"
  | "payRunMutation"
  | "setPayAccountId"
  | "setPayDialogRun"
>) {
  return (
    <Dialog
      open={!!payDialogRun}
      onOpenChange={(open) => {
        if (!open) setPayDialogRun(null);
      }}
    >
      <DialogContent className="max-w-lg" data-testid="dialog-pay-run">
        <DialogHeader>
          <DialogTitle>Pay Payroll Draft</DialogTitle>
          <DialogDescription>
            This will create ledger entries and mark the payroll as paid. Net total:{" "}
            <strong>{payDialogRun ? formatAmount(parseFloat(payDialogRun.totalNet)) : ""}</strong>
          </DialogDescription>
        </DialogHeader>

        {payDialogRun && (
          <div className="space-y-4 py-2">
            <div className="rounded-md bg-muted/40 px-4 py-3 space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Date</span>
                <span className="font-medium">{payDialogRun.date}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Workers</span>
                <span className="font-medium">{payDialogRun.itemCount}</span>
              </div>
              {payDialogRun.notes && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Notes</span>
                  <span className="font-medium">{payDialogRun.notes}</span>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Payment Account (Cash)</Label>
              <Select value={payAccountId} onValueChange={setPayAccountId}>
                <SelectTrigger data-testid="select-pay-account">
                  <SelectValue placeholder="Select cash account" />
                </SelectTrigger>
                <SelectContent>
                  {cashAccounts.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      No cash accounts found
                    </SelectItem>
                  ) : (
                    cashAccounts.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Worker breakdown */}
            <div className="border rounded-md overflow-hidden max-h-56 overflow-y-auto">
              <Table mobileLayout="cards">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Worker</TableHead>
                    <TableHead className="text-right text-xs">Base</TableHead>
                    <TableHead className="text-right text-xs">Advance Deduction</TableHead>
                    <TableHead className="text-right text-xs">Payroll Deduction</TableHead>
                    <TableHead className="text-right text-xs">Net Pay</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(payDialogRun.items || []).map((it, idx) => (
                    <TableRow key={idx}>
                      <TableCell className="text-sm py-2">{it.employeeName}</TableCell>
                      <TableCell className="text-right text-sm py-2">
                        {formatAmount(parseFloat(it.baseSalary))}
                      </TableCell>
                      <TableCell className="text-right text-sm py-2 text-amber-600 dark:text-amber-400">
                        {parseFloat(it.deduction) > 0 ? `-${formatAmount(parseFloat(it.deduction))}` : "—"}
                      </TableCell>
                      <TableCell className="text-right text-sm py-2 text-orange-600 dark:text-orange-400">
                        {parseFloat(it.payrollDeduction || "0") > 0
                          ? `-${formatAmount(parseFloat(it.payrollDeduction || "0"))}`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right text-sm py-2 font-semibold">
                        {formatAmount(parseFloat(it.netPay))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setPayDialogRun(null)} data-testid="button-cancel-pay">
            Cancel
          </Button>
          <Button
            onClick={() => payDialogRun && payRunMutation.mutate({ runId: payDialogRun.id, accountId: payAccountId })}
            disabled={payRunMutation.isPending || !payAccountId}
            data-testid="button-confirm-pay"
          >
            {payRunMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Processing...
              </>
            ) : (
              <>
                <DollarSign className="h-4 w-4 mr-2" />
                Confirm Payment
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
