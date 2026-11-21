// Extracted from ./BulkDialogs.tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import type { BulkDialogsProps } from "./BulkDialogsTypes";

export function BulkDialogsContent({
  bankAccounts,
  bulkWithdrawalAccountId,
  bulkWithdrawalAccountType,
  bulkWithdrawalAmounts,
  bulkWithdrawalDate,
  bulkWithdrawalDialogOpen,
  bulkWithdrawalMutation,
  bulkWithdrawalNotes,
  cashAccounts,
  employeeStaff,
  formatAmount,
  setBulkWithdrawalAccountId,
  setBulkWithdrawalAccountType,
  setBulkWithdrawalAmounts,
  setBulkWithdrawalDate,
  setBulkWithdrawalDialogOpen,
  setBulkWithdrawalNotes,
}: Pick<
  BulkDialogsProps,
  | "bankAccounts"
  | "bulkWithdrawalAccountId"
  | "bulkWithdrawalAccountType"
  | "bulkWithdrawalAmounts"
  | "bulkWithdrawalDate"
  | "bulkWithdrawalDialogOpen"
  | "bulkWithdrawalMutation"
  | "bulkWithdrawalNotes"
  | "cashAccounts"
  | "employeeStaff"
  | "setBulkWithdrawalAccountId"
  | "setBulkWithdrawalAccountType"
  | "setBulkWithdrawalAmounts"
  | "setBulkWithdrawalDate"
  | "setBulkWithdrawalDialogOpen"
  | "setBulkWithdrawalNotes"
> &
  Pick<ReturnType<typeof useCurrencyContext>, "formatAmount">) {
  return (
    <Dialog open={bulkWithdrawalDialogOpen} onOpenChange={setBulkWithdrawalDialogOpen}>
      <DialogContent
        className="max-w-4xl w-[95vw] max-h-[85vh] overflow-hidden flex flex-col"
        data-testid="dialog-bulk-withdrawal"
      >
        <DialogHeader>
          <DialogTitle>Bulk Withdrawal</DialogTitle>
          <DialogDescription>
            Enter withdrawal amounts for each employee. Leave blank or zero to skip.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Withdrawal Date</Label>
              <Input
                type="date"
                value={bulkWithdrawalDate}
                onChange={(e) => setBulkWithdrawalDate(e.target.value)}
                data-testid="input-bulk-withdrawal-date"
              />
            </div>
            <div className="space-y-2">
              <Label>Account Type</Label>
              <Select
                value={bulkWithdrawalAccountType}
                onValueChange={(val) => {
                  if (val === "cash" || val === "bank") {
                    setBulkWithdrawalAccountType(val);
                    setBulkWithdrawalAccountId("");
                  }
                }}
              >
                <SelectTrigger data-testid="select-withdrawal-account-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash Account</SelectItem>
                  <SelectItem value="bank">Bank Account</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Payment Account</Label>
              <Select value={bulkWithdrawalAccountId} onValueChange={setBulkWithdrawalAccountId}>
                <SelectTrigger data-testid="select-withdrawal-account">
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  {bulkWithdrawalAccountType === "cash"
                    ? cashAccounts?.map((acc) => (
                        <SelectItem key={acc.id} value={acc.id.toString()}>
                          {acc.name}
                        </SelectItem>
                      ))
                    : bankAccounts?.map((acc) => (
                        <SelectItem key={acc.id} value={acc.id.toString()}>
                          {acc.accountName}
                        </SelectItem>
                      ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Notes (optional)</Label>
            <Input
              placeholder="e.g., November 2025 withdrawal"
              value={bulkWithdrawalNotes}
              onChange={(e) => setBulkWithdrawalNotes(e.target.value)}
              data-testid="input-bulk-withdrawal-notes"
            />
          </div>

          <div className="border rounded-md flex-1 overflow-hidden">
            <div className="max-h-[400px] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead className="text-right w-40">Withdrawal Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {employeeStaff.map((emp) => (
                    <TableRow key={emp.id}>
                      <TableCell>
                        {emp.firstName} {emp.lastName}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatAmount(parseFloat(emp.calculatedBalance || "0"))}
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0.00"
                          className="text-right font-mono w-32 ml-auto"
                          value={bulkWithdrawalAmounts[emp.id] || ""}
                          onChange={(e) => setBulkWithdrawalAmounts((prev) => ({ ...prev, [emp.id]: e.target.value }))}
                          data-testid={`input-withdrawal-${emp.id}`}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t">
            <div className="text-sm">
              <span className="text-muted-foreground">Total Withdrawal: </span>
              <span className="font-semibold font-mono">
                {formatAmount(
                  Object.values(bulkWithdrawalAmounts).reduce((sum, amt) => sum + (parseFloat(amt) || 0), 0)
                )}
              </span>
              <span className="text-muted-foreground ml-2">
                ({Object.values(bulkWithdrawalAmounts).filter((amt) => parseFloat(amt) > 0).length} employees)
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setBulkWithdrawalDialogOpen(false)}
                data-testid="button-cancel-bulk-withdrawal"
              >
                Cancel
              </Button>
              <Button
                onClick={() => bulkWithdrawalMutation.mutate()}
                disabled={
                  bulkWithdrawalMutation.isPending ||
                  Object.values(bulkWithdrawalAmounts).filter((amt) => parseFloat(amt) > 0).length === 0 ||
                  !bulkWithdrawalAccountId
                }
                data-testid="button-confirm-bulk-withdrawal"
              >
                {bulkWithdrawalMutation.isPending ? "Processing..." : "Process Withdrawals"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
