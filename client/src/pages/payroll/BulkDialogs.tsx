import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { BulkBonusDialog } from "./BulkBonusDialog";
import type { BulkDialogsProps } from "./BulkDialogsTypes";
import { BulkDialogsContent } from "./BulkDialogsContent";
export type { BulkDialogsProps } from "./BulkDialogsTypes";

export function BulkDialogs({
  bulkDepositDialogOpen,
  setBulkDepositDialogOpen,
  bulkDepositDate,
  setBulkDepositDate,
  bulkDepositNotes,
  setBulkDepositNotes,
  employeeStaff,
  bulkDepositSelections,
  bulkDepositAmounts,
  setBulkDepositAmounts,
  handleSelectAllEmployees,
  handleToggleEmployeeDeposit,
  bulkDepositTotal,
  validSelectedEmployees,
  bulkDepositMutation,
  bulkWithdrawalDialogOpen,
  setBulkWithdrawalDialogOpen,
  bulkWithdrawalDate,
  setBulkWithdrawalDate,
  bulkWithdrawalAccountType,
  setBulkWithdrawalAccountType,
  bulkWithdrawalAccountId,
  setBulkWithdrawalAccountId,
  bulkWithdrawalNotes,
  setBulkWithdrawalNotes,
  bulkWithdrawalAmounts,
  setBulkWithdrawalAmounts,
  bulkWithdrawalMutation,
  cashAccounts,
  bankAccounts,
  bulkBonusDialogOpen,
  setBulkBonusDialogOpen,
  bulkBonusStep,
  setBulkBonusStep,
  bulkBonusDate,
  setBulkBonusDate,
  bulkBonusNotes,
  setBulkBonusNotes,
  bulkBonusAutoMonth,
  setBulkBonusAutoMonth,
  bulkBonusAutoStart,
  setBulkBonusAutoStart,
  bulkBonusAutoEnd,
  setBulkBonusAutoEnd,
  autoCalculateBonuses,
  bulkBonusAutoLoading,
  bulkBonusAutoPctLocationId,
  setBulkBonusAutoPctLocationId,
  bulkBonusAmounts,
  setBulkBonusAmounts,
  pendingBonuses,
  bulkBonusBreakdowns,
  bulkBonusMutation,
  handlePrintBulkBonus,
  locations,
  allCompanyLocations,
}: BulkDialogsProps) {
  const { formatAmount } = useCurrencyContext();

  return (
    <>
      {/* Bulk Deposit Dialog */}
      <Dialog open={bulkDepositDialogOpen} onOpenChange={setBulkDepositDialogOpen}>
        <DialogContent
          className="max-w-4xl w-[95vw] max-h-[85vh] overflow-hidden flex flex-col"
          data-testid="dialog-bulk-deposit"
        >
          <DialogHeader>
            <DialogTitle>Bulk Salary Deposit</DialogTitle>
            <DialogDescription>
              Select employees, then edit the deposit amount for this payment if needed. The saved monthly salary is
              only used as the default.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Deposit Date</Label>
                <Input
                  type="date"
                  value={bulkDepositDate}
                  onChange={(e) => setBulkDepositDate(e.target.value)}
                  data-testid="input-bulk-deposit-date"
                />
              </div>
              <div className="space-y-2">
                <Label>Notes (optional)</Label>
                <Input
                  placeholder="e.g., November 2025 salary"
                  value={bulkDepositNotes}
                  onChange={(e) => setBulkDepositNotes(e.target.value)}
                  data-testid="input-bulk-deposit-notes"
                />
              </div>
            </div>

            <div className="border rounded-md flex-1 overflow-hidden">
              <div className="max-h-[360px] overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-background">
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={
                            employeeStaff.length > 0 && employeeStaff.every((emp) => bulkDepositSelections[emp.id])
                          }
                          onCheckedChange={handleSelectAllEmployees}
                          data-testid="checkbox-select-all-employees"
                        />
                      </TableHead>
                      <TableHead>Employee</TableHead>
                      <TableHead className="text-right">Monthly Salary</TableHead>
                      <TableHead className="text-right min-w-[150px]">Deposit Amount</TableHead>
                      <TableHead className="text-right">Current Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {employeeStaff.map((emp) => {
                      const salary = parseFloat(emp.monthlySalary || "0");
                      const hasValidSalary = !isNaN(salary) && salary > 0;
                      return (
                        <TableRow
                          key={emp.id}
                          className={bulkDepositSelections[emp.id] ? "bg-muted/40" : ""}
                          onClick={() => handleToggleEmployeeDeposit(emp.id)}
                          style={{ cursor: "pointer" }}
                        >
                          <TableCell>
                            <Checkbox
                              checked={bulkDepositSelections[emp.id] || false}
                              onCheckedChange={() => handleToggleEmployeeDeposit(emp.id)}
                              data-testid={`checkbox-deposit-employee-${emp.id}`}
                            />
                          </TableCell>
                          <TableCell>
                            <div className="font-medium">
                              {emp.firstName} {emp.lastName}
                            </div>
                            {emp.code && <div className="text-xs text-muted-foreground">{emp.code}</div>}
                            {!hasValidSalary && (
                              <div className="text-xs text-muted-foreground">
                                No default salary set — enter an amount manually
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono">{formatAmount(salary)}</TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              inputMode="decimal"
                              value={bulkDepositAmounts[emp.id] ?? emp.monthlySalary ?? ""}
                              disabled={!bulkDepositSelections[emp.id]}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) =>
                                setBulkDepositAmounts((previous) => ({
                                  ...previous,
                                  [emp.id]: event.target.value,
                                }))
                              }
                              className="ml-auto h-8 w-32 text-right font-mono"
                              aria-label={`Deposit amount for ${emp.firstName} ${emp.lastName}`}
                              data-testid={`input-bulk-deposit-amount-${emp.id}`}
                            />
                          </TableCell>
                          <TableCell className="text-right font-mono text-muted-foreground">
                            {formatAmount(parseFloat(emp.calculatedBalance || "0"))}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t">
              <div className="text-sm">
                <span className="text-muted-foreground">Total deposit: </span>
                <span className="font-semibold font-mono">{formatAmount(bulkDepositTotal)}</span>
                <span className="text-muted-foreground ml-2">
                  ({validSelectedEmployees.length} employee{validSelectedEmployees.length !== 1 ? "s" : ""})
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setBulkDepositDialogOpen(false)}
                  data-testid="button-cancel-bulk-deposit"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => bulkDepositMutation.mutate()}
                  disabled={bulkDepositMutation.isPending || validSelectedEmployees.length === 0}
                  data-testid="button-confirm-bulk-deposit"
                >
                  {bulkDepositMutation.isPending
                    ? "Processing..."
                    : `Deposit ${validSelectedEmployees.length} Employee${validSelectedEmployees.length !== 1 ? "s" : ""}`}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Withdrawal Dialog */}
      <BulkDialogsContent
        bankAccounts={bankAccounts}
        bulkWithdrawalAccountId={bulkWithdrawalAccountId}
        bulkWithdrawalAccountType={bulkWithdrawalAccountType}
        bulkWithdrawalAmounts={bulkWithdrawalAmounts}
        bulkWithdrawalDate={bulkWithdrawalDate}
        bulkWithdrawalDialogOpen={bulkWithdrawalDialogOpen}
        bulkWithdrawalMutation={bulkWithdrawalMutation}
        bulkWithdrawalNotes={bulkWithdrawalNotes}
        cashAccounts={cashAccounts}
        employeeStaff={employeeStaff}
        formatAmount={formatAmount}
        setBulkWithdrawalAccountId={setBulkWithdrawalAccountId}
        setBulkWithdrawalAccountType={setBulkWithdrawalAccountType}
        setBulkWithdrawalAmounts={setBulkWithdrawalAmounts}
        setBulkWithdrawalDate={setBulkWithdrawalDate}
        setBulkWithdrawalDialogOpen={setBulkWithdrawalDialogOpen}
        setBulkWithdrawalNotes={setBulkWithdrawalNotes}
      />

      {/* Bulk Bonus Dialog */}
      <BulkBonusDialog
        formatAmount={formatAmount}
        bulkBonusDialogOpen={bulkBonusDialogOpen}
        setBulkBonusStep={setBulkBonusStep}
        setBulkBonusDialogOpen={setBulkBonusDialogOpen}
        bulkBonusStep={bulkBonusStep}
        bulkBonusDate={bulkBonusDate}
        setBulkBonusDate={setBulkBonusDate}
        bulkBonusNotes={bulkBonusNotes}
        setBulkBonusNotes={setBulkBonusNotes}
        bulkBonusAutoMonth={bulkBonusAutoMonth}
        setBulkBonusAutoMonth={setBulkBonusAutoMonth}
        bulkBonusAutoStart={bulkBonusAutoStart}
        setBulkBonusAutoStart={setBulkBonusAutoStart}
        bulkBonusAutoEnd={bulkBonusAutoEnd}
        setBulkBonusAutoEnd={setBulkBonusAutoEnd}
        autoCalculateBonuses={autoCalculateBonuses}
        bulkBonusAutoLoading={bulkBonusAutoLoading}
        bulkBonusAutoPctLocationId={bulkBonusAutoPctLocationId}
        setBulkBonusAutoPctLocationId={setBulkBonusAutoPctLocationId}
        locations={locations}
        allCompanyLocations={allCompanyLocations}
        employeeStaff={employeeStaff}
        pendingBonuses={pendingBonuses}
        bulkBonusBreakdowns={bulkBonusBreakdowns}
        bulkBonusAmounts={bulkBonusAmounts}
        setBulkBonusAmounts={setBulkBonusAmounts}
        handlePrintBulkBonus={handlePrintBulkBonus}
        bulkBonusMutation={bulkBonusMutation}
      />
    </>
  );
}
