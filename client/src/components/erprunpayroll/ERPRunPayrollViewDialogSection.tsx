// Extracted from ./ERPRunPayrollViewTabsContentSection.tsx
import { DollarSign, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
import { useERPRunPayrollViewState } from "./ERPRunPayrollViewSection";

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
