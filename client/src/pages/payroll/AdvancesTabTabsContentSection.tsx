// Extracted from ./AdvancesTabDialogSection.tsx
import { confirmAction } from "@/components/ConfirmHost";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useAdvancesTabState } from "./useAdvancesTabState";

export function AdvancesTabTabsContentSection({
  deductionsLoading,
  deleteWorkerDeductionMutation,
  formatAmount,
  formatDisplayDate,
  recordChanges,
  setAddWorkerDeductionDialogOpen,
  workerDeductions,
}: Pick<
  ReturnType<typeof useAdvancesTabState>,
  | "deductionsLoading"
  | "deleteWorkerDeductionMutation"
  | "formatAmount"
  | "formatDisplayDate"
  | "recordChanges"
  | "setAddWorkerDeductionDialogOpen"
  | "workerDeductions"
>) {
  return (
    <TabsContent value="worker-deductions" className="pt-4 space-y-4">
      {recordChanges.allowed && (
        <div className="flex justify-end">
          <Button onClick={() => setAddWorkerDeductionDialogOpen(true)} data-testid="button-add-worker-deduction">
            <Plus className="mr-2 h-4 w-4" />
            Add Deduction
          </Button>
        </div>
      )}
      {deductionsLoading ? (
        <div className="flex items-center justify-center p-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="border rounded-md">
          <Table mobileLayout="cards">
            <TableHeader>
              <TableRow>
                <TableHead>Worker</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workerDeductions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    No worker deductions recorded
                  </TableCell>
                </TableRow>
              ) : (
                workerDeductions.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <span className="font-medium">{d.workerName || `Worker #${d.workerId}`}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {d.deductionDate ? formatDisplayDate(d.deductionDate) : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                      {d.reason || "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono font-bold text-red-600 dark:text-red-400">
                      {formatAmount(parseFloat(d.amount || "0"))}
                    </TableCell>
                    <TableCell>
                      {d.applied ? (
                        <Badge variant="default" className="bg-green-600">
                          Paid
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-amber-500 text-amber-500">
                          Pending
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {recordChanges.allowed && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-destructive"
                          disabled={deleteWorkerDeductionMutation.isPending}
                          onClick={async () => {
                            if (
                              await confirmAction({
                                title: `Delete this deduction of ${formatAmount(parseFloat(d.amount || "0"))} for ${d.workerName || "this worker"}?`,
                                tone: "destructive",
                              })
                            ) {
                              deleteWorkerDeductionMutation.mutate({ workerId: d.workerId, deductionId: d.id });
                            }
                          }}
                          data-testid={`button-delete-deduction-${d.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </TabsContent>
  );
}
