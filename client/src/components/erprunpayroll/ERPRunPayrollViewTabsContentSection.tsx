// Extracted from ./ERPRunPayrollView.tsx to keep that module under the source-size cap.
import { DollarSign, FileSpreadsheet, History, Printer, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TabsContent } from "@/components/ui/tabs";
import { useERPRunPayrollViewState } from "./ERPRunPayrollViewSection";
import { EmptyState } from "@/components/ui/page-state";
export { ERPRunPayrollViewDialogSection } from "./ERPRunPayrollViewDialogSection";

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
        <EmptyState
          icon={History}
          title="No payroll runs yet"
          description="Select workers and run a payroll to get started."
          className="py-20"
        />
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
