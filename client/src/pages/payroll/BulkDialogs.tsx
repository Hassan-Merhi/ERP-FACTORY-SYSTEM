import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
import type { usePayrollModel } from "./usePayrollModel";

type PayrollModel = ReturnType<typeof usePayrollModel>;
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { BulkBonusDialog } from "./BulkBonusDialog";

export interface BulkDialogsProps {
  bulkDepositDialogOpen: boolean;
  setBulkDepositDialogOpen: (open: boolean) => void;
  bulkDepositDate: string;
  setBulkDepositDate: (v: string) => void;
  bulkDepositNotes: string;
  setBulkDepositNotes: (v: string) => void;
  employeeStaff: PayrollModel["employeeStaff"];
  bulkDepositSelections: Record<number, boolean>;
  bulkDepositAmounts: Record<number, string>;
  setBulkDepositAmounts: PayrollModel["setBulkDepositAmounts"];
  handleSelectAllEmployees: PayrollModel["handleSelectAllEmployees"];
  handleToggleEmployeeDeposit: (id: number) => void;
  bulkDepositTotal: number;
  validSelectedEmployees: PayrollModel["validSelectedEmployees"];
  bulkDepositMutation: PayrollModel["bulkDepositMutation"];
  bulkWithdrawalDialogOpen: boolean;
  setBulkWithdrawalDialogOpen: (open: boolean) => void;
  bulkWithdrawalDate: string;
  setBulkWithdrawalDate: (v: string) => void;
  bulkWithdrawalAccountType: string;
  setBulkWithdrawalAccountType: PayrollModel["setBulkWithdrawalAccountType"];
  bulkWithdrawalAccountId: string;
  setBulkWithdrawalAccountId: (v: string) => void;
  bulkWithdrawalNotes: string;
  setBulkWithdrawalNotes: (v: string) => void;
  bulkWithdrawalAmounts: Record<number, string>;
  setBulkWithdrawalAmounts: (fn: (prev: Record<number, string>) => Record<number, string>) => void;
  bulkWithdrawalMutation: PayrollModel["bulkWithdrawalMutation"];
  cashAccounts: PayrollModel["cashAccounts"];
  bankAccounts: PayrollModel["bankAccounts"];
  bulkBonusDialogOpen: boolean;
  setBulkBonusDialogOpen: (open: boolean) => void;
  bulkBonusStep: "edit" | "preview";
  setBulkBonusStep: (v: "edit" | "preview") => void;
  bulkBonusDate: string;
  setBulkBonusDate: (v: string) => void;
  bulkBonusNotes: string;
  setBulkBonusNotes: (v: string) => void;
  bulkBonusAutoMonth: "thisMonth" | "custom";
  setBulkBonusAutoMonth: (v: "thisMonth" | "custom") => void;
  bulkBonusAutoStart: string;
  setBulkBonusAutoStart: (v: string) => void;
  bulkBonusAutoEnd: string;
  setBulkBonusAutoEnd: (v: string) => void;
  autoCalculateBonuses: () => void;
  bulkBonusAutoLoading: boolean;
  bulkBonusAutoPctLocationId: string;
  setBulkBonusAutoPctLocationId: (v: string) => void;
  bulkBonusAmounts: Record<number, string>;
  setBulkBonusAmounts: (fn: (prev: Record<number, string>) => Record<number, string>) => void;
  pendingBonuses: PayrollModel["pendingBonuses"];
  bulkBonusBreakdowns: Record<number, string[]>;
  bulkBonusMutation: PayrollModel["bulkBonusMutation"];
  handlePrintBulkBonus: () => void;
  locations: PayrollModel["locations"];
  allCompanyLocations: PayrollModel["allCompanyLocations"];
}

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
                <UnifiedAccountPicker
                  options={(bulkWithdrawalAccountType === "cash" ? (cashAccounts ?? []) : (bankAccounts ?? [])).map(
                    (account) => ({
                      value: String(account.id),
                      name: String(account.accountName ?? account.name ?? account.bankName ?? "Unnamed account"),
                    })
                  )}
                  value={bulkWithdrawalAccountId}
                  onChange={setBulkWithdrawalAccountId}
                  placeholder="Select account"
                  testId="select-withdrawal-account"
                />
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
                            onChange={(e) =>
                              setBulkWithdrawalAmounts((prev) => ({ ...prev, [emp.id]: e.target.value }))
                            }
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
