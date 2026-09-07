import type { usePayrollModel } from "./usePayrollModel";

type PayrollModel = ReturnType<typeof usePayrollModel>;
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { encodeLocationOption } from "./payrollUtils";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronRight, Loader2, Printer, RefreshCw } from "lucide-react";
import { useCurrencyContext } from "@/contexts/CurrencyContext";

interface BulkDialogsProps {
  bulkDepositDialogOpen: boolean;
  setBulkDepositDialogOpen: (open: boolean) => void;
  bulkDepositDate: string;
  setBulkDepositDate: (v: string) => void;
  bulkDepositNotes: string;
  setBulkDepositNotes: (v: string) => void;
  employeeStaff: PayrollModel["employeeStaff"];
  bulkDepositSelections: Record<number, boolean>;
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
              Select employees and deposit their monthly salary. Leave an employee unchecked to skip them.
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
                              <div className="text-xs text-destructive">No salary set — will be skipped</div>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono">{formatAmount(salary)}</TableCell>
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

            <div className="flex-shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t">
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

            <div className="flex-shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t">
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
      <Dialog
        open={bulkBonusDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setBulkBonusStep("edit");
          }
          setBulkBonusDialogOpen(open);
        }}
      >
        <DialogContent
          className="max-w-4xl w-[95vw] max-h-[85vh] overflow-hidden flex flex-col"
          data-testid="dialog-bulk-bonus"
        >
          <DialogHeader>
            <DialogTitle>Bulk Bonus Deposit</DialogTitle>
            <DialogDescription>
              {bulkBonusStep === "edit"
                ? "Enter bonus amounts for each employee. Leave blank or zero to skip."
                : "Review the bonuses below before confirming."}
            </DialogDescription>
          </DialogHeader>

          {bulkBonusStep === "edit" ? (
            <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Bonus Date</Label>
                  <Input
                    type="date"
                    value={bulkBonusDate}
                    onChange={(e) => setBulkBonusDate(e.target.value)}
                    data-testid="input-bulk-bonus-date"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Notes (optional)</Label>
                  <Input
                    placeholder="e.g., Q4 2025 performance bonus"
                    value={bulkBonusNotes}
                    onChange={(e) => setBulkBonusNotes(e.target.value)}
                    data-testid="input-bulk-bonus-notes"
                  />
                </div>
              </div>

              <div className="border rounded-md p-3 space-y-2 bg-muted/30">
                <p className="text-sm font-medium">Auto-Calculate from Saved Rates</p>
                <div className="flex flex-wrap gap-2 items-center">
                  <Button
                    type="button"
                    size="sm"
                    variant={bulkBonusAutoMonth === "thisMonth" ? "default" : "outline"}
                    onClick={() => setBulkBonusAutoMonth("thisMonth")}
                  >
                    This Month
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={bulkBonusAutoMonth === "custom" ? "default" : "outline"}
                    onClick={() => setBulkBonusAutoMonth("custom")}
                  >
                    Custom
                  </Button>
                  {bulkBonusAutoMonth === "custom" && (
                    <>
                      <Input
                        type="date"
                        className="h-8 w-36 text-sm"
                        value={bulkBonusAutoStart}
                        onChange={(e) => setBulkBonusAutoStart(e.target.value)}
                      />
                      <Input
                        type="date"
                        className="h-8 w-36 text-sm"
                        value={bulkBonusAutoEnd}
                        onChange={(e) => setBulkBonusAutoEnd(e.target.value)}
                      />
                    </>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    onClick={autoCalculateBonuses}
                    disabled={bulkBonusAutoLoading}
                    data-testid="button-auto-calculate-bonuses"
                  >
                    {bulkBonusAutoLoading ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-1" />
                    )}
                    Calculate All
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground whitespace-nowrap">Sales % location:</span>
                  <Select value={bulkBonusAutoPctLocationId} onValueChange={setBulkBonusAutoPctLocationId}>
                    <SelectTrigger className="h-7 text-xs w-44" data-testid="select-bulk-bonus-pct-location">
                      <SelectValue placeholder="Select for % bonus" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>This Company</SelectLabel>
                        {locations.map((loc) => (
                          // The company is part of the value so the sales total
                          // is read from the company that actually sells at the
                          // location, not from whoever owns the location row.
                          <SelectItem key={loc.id} value={encodeLocationOption(loc.id, loc.companyId)}>
                            {loc.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                      {allCompanyLocations.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>Other Companies</SelectLabel>
                          {allCompanyLocations.map((loc) => (
                            <SelectItem
                              key={`oc-${loc.companyId}-${loc.id}`}
                              value={encodeLocationOption(loc.id, loc.companyId)}
                            >
                              {loc.name} ({loc.companyName})
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                    </SelectContent>
                  </Select>
                  {bulkBonusAutoPctLocationId && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      onClick={() => setBulkBonusAutoPctLocationId("")}
                    >
                      Clear
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Per-unit bale rates use their configured locations. Sales % bonus uses the location selected above
                  (leave blank to skip % calculation).
                </p>
              </div>

              <div className="border rounded-md flex-1 overflow-hidden">
                <div className="max-h-[400px] overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background">
                      <TableRow>
                        <TableHead>Employee</TableHead>
                        <TableHead className="text-right w-40">Bonus Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {employeeStaff.map((emp) => {
                        const isPending = !!pendingBonuses[emp.id];
                        const breakdown = bulkBonusBreakdowns[emp.id];
                        return (
                          <TableRow key={emp.id}>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <span>
                                  {emp.firstName} {emp.lastName}
                                </span>
                                {isPending && (
                                  <Badge variant="secondary" className="text-xs">
                                    Calculated
                                  </Badge>
                                )}
                              </div>
                              {breakdown && breakdown.length > 0 && (
                                <div className="mt-1 space-y-0.5">
                                  {breakdown.map((line, i) => (
                                    <p key={i} className="text-xs text-muted-foreground font-mono">
                                      {line}
                                    </p>
                                  ))}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                placeholder="0.00"
                                className="text-right font-mono w-32 ml-auto"
                                value={bulkBonusAmounts[emp.id] || ""}
                                onChange={(e) => setBulkBonusAmounts((prev) => ({ ...prev, [emp.id]: e.target.value }))}
                                data-testid={`input-bonus-${emp.id}`}
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>

              <div className="flex-shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t">
                <div className="text-sm">
                  <span className="text-muted-foreground">Total: </span>
                  <span className="font-semibold font-mono">
                    {formatAmount(
                      Object.values(bulkBonusAmounts).reduce((sum, amt) => sum + (parseFloat(amt) || 0), 0)
                    )}
                  </span>
                  <span className="text-muted-foreground ml-2">
                    ({Object.values(bulkBonusAmounts).filter((amt) => parseFloat(amt) > 0).length} employees)
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setBulkBonusDialogOpen(false)}
                    data-testid="button-cancel-bulk-bonus"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => setBulkBonusStep("preview")}
                    disabled={Object.values(bulkBonusAmounts).filter((amt) => parseFloat(amt) > 0).length === 0}
                    data-testid="button-preview-bulk-bonus"
                  >
                    Preview <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
              <div className="border rounded-md flex-1 overflow-hidden">
                <div className="max-h-[420px] overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background">
                      <TableRow>
                        <TableHead>Employee</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {employeeStaff
                        .filter((emp) => parseFloat(bulkBonusAmounts[emp.id] || "0") > 0)
                        .map((emp) => {
                          const pending = pendingBonuses[emp.id];
                          return (
                            <TableRow key={emp.id}>
                              <TableCell className="font-medium">
                                {emp.firstName} {emp.lastName}
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                                {pending?.description || bulkBonusNotes || "Bonus"}
                              </TableCell>
                              <TableCell className="text-right font-mono font-semibold">
                                {formatAmount(parseFloat(bulkBonusAmounts[emp.id] || "0"))}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                    </TableBody>
                  </Table>
                </div>
              </div>

              <div className="flex-shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t">
                <div className="text-sm">
                  <span className="text-muted-foreground">Total: </span>
                  <span className="font-semibold font-mono">
                    {formatAmount(
                      Object.values(bulkBonusAmounts).reduce((sum, amt) => sum + (parseFloat(amt) || 0), 0)
                    )}
                  </span>
                  <span className="text-muted-foreground ml-2">
                    ({Object.values(bulkBonusAmounts).filter((amt) => parseFloat(amt) > 0).length} employees)
                  </span>
                  {bulkBonusDate && <span className="text-muted-foreground ml-2">· {bulkBonusDate}</span>}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setBulkBonusStep("edit")}
                    data-testid="button-back-bulk-bonus"
                  >
                    Back
                  </Button>
                  <Button variant="outline" onClick={handlePrintBulkBonus} data-testid="button-print-bulk-bonus">
                    <Printer className="h-4 w-4 mr-2" />
                    Print
                  </Button>
                  <Button
                    onClick={() => bulkBonusMutation.mutate()}
                    disabled={bulkBonusMutation.isPending}
                    data-testid="button-confirm-bulk-bonus"
                  >
                    {bulkBonusMutation.isPending ? "Processing..." : "Confirm & Deposit"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
