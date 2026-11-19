import { Banknote, Users, Loader2, ArrowDownCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { EmptyState, ErrorState } from "@/components/ui/page-state";
import { fmt } from "./FactoryEmployeeWithdrawalsTabHelpers";
import { useFactoryEmployeeWithdrawalsTabState } from "./useFactoryEmployeeWithdrawalsTabState";
import { FactoryEmployeeWithdrawalsTabDialog } from "./FactoryEmployeeWithdrawalsTabDialog";

export default function FactoryEmployeeWithdrawalsTab() {
  const {
    wrapAdminAction,
    AdminDialog,
    recordChanges,
    setSingleOpen,
    singleOpen,
    setBulkOpen,
    bulkOpen,
    setSingleForm,
    singleForm,
    bulkForm,
    setBulkForm,
    bulkAmounts,
    setBulkAmounts,
    isError,
    employeesData,
    refetch,
    employees,
    cashAccounts,
    singleMutation,
    bulkMutation,
    bulkTotal,
    selectedEmp,
  } = useFactoryEmployeeWithdrawalsTabState();

  return (
    <div className="space-y-4">
      {/* Employees hub "Withdrawals" tab: the Payroll hub PageHeader titles the page; keep the actions only. */}
      <div className="flex flex-wrap gap-3 items-center justify-end">
        {recordChanges.allowed && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setSingleOpen(true)} data-testid="button-withdraw-single">
              <ArrowDownCircle className="h-4 w-4 mr-2" />
              Withdraw (Single)
            </Button>
            <Button onClick={() => setBulkOpen(true)} data-testid="button-withdraw-bulk">
              <Users className="h-4 w-4 mr-2" />
              Withdraw All (Bulk)
            </Button>
          </div>
        )}
      </div>

      {isError && !employeesData ? (
        <ErrorState onAction={() => void refetch()} actionLabel="Try again" />
      ) : employees.length === 0 ? (
        <EmptyState icon={Users} title="No active employees found." />
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-muted-foreground font-normal flex items-center gap-2">
              <Banknote className="h-4 w-4" />
              Current Balances
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="hidden sm:block">
              <Table mobileLayout="cards">
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {employees.map((emp) => {
                    const bal = parseFloat(emp.currentBalance || "0");
                    return (
                      <TableRow key={emp.id} data-testid={`row-employee-${emp.id}`}>
                        <TableCell className="font-medium">
                          {emp.firstName} {emp.lastName}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{emp.code || "—"}</TableCell>
                        <TableCell
                          className={`text-right font-mono ${bal < 0 ? "text-red-600 dark:text-red-400" : ""}`}
                        >
                          {fmt(emp.currentBalance)}
                        </TableCell>
                        <TableCell>
                          {recordChanges.allowed && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setSingleForm((f) => ({ ...f, employeeId: String(emp.id) }));
                                setSingleOpen(true);
                              }}
                              data-testid={`button-withdraw-${emp.id}`}
                            >
                              <ArrowDownCircle className="h-3 w-3 mr-1" /> Withdraw
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="sm:hidden space-y-2 p-3">
              {employees.map((emp) => {
                const bal = parseFloat(emp.currentBalance || "0");
                return (
                  <Card key={emp.id} data-testid={`card-employee-${emp.id}`}>
                    <CardContent className="p-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-sm">
                          {emp.firstName} {emp.lastName}
                        </p>
                        <p
                          className={`text-sm font-mono ${bal < 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}
                        >
                          {fmt(emp.currentBalance)}
                        </p>
                      </div>
                      {recordChanges.allowed && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setSingleForm((f) => ({ ...f, employeeId: String(emp.id) }));
                            setSingleOpen(true);
                          }}
                        >
                          <ArrowDownCircle className="h-3 w-3 mr-1" /> Withdraw
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Single Withdrawal Dialog */}
      <FactoryEmployeeWithdrawalsTabDialog
        cashAccounts={cashAccounts}
        employees={employees}
        selectedEmp={selectedEmp}
        setSingleForm={setSingleForm}
        setSingleOpen={setSingleOpen}
        singleForm={singleForm}
        singleMutation={singleMutation}
        singleOpen={singleOpen}
        wrapAdminAction={wrapAdminAction}
      />

      {/* Bulk Withdrawal Dialog */}
      <Dialog
        open={bulkOpen}
        onOpenChange={(o) => {
          if (!o) setBulkOpen(false);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Bulk Withdrawal — All Employees</DialogTitle>
            <DialogDescription>Enter withdrawal amounts for each employee. Leave blank to skip.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Date</Label>
                <Input
                  type="date"
                  value={bulkForm.date}
                  onChange={(e) => setBulkForm((f) => ({ ...f, date: e.target.value }))}
                  data-testid="input-bulk-date"
                />
              </div>
              <div>
                <Label>Cash Account</Label>
                <Select
                  value={bulkForm.cashAccountId}
                  onValueChange={(v) => setBulkForm((f) => ({ ...f, cashAccountId: v }))}
                >
                  <SelectTrigger data-testid="select-bulk-cash-account">
                    <SelectValue placeholder="Select account" />
                  </SelectTrigger>
                  <SelectContent>
                    {cashAccounts.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Notes (optional)</Label>
              <Textarea
                placeholder="Optional notes for all entries…"
                rows={2}
                value={bulkForm.notes}
                onChange={(e) => setBulkForm((f) => ({ ...f, notes: e.target.value }))}
                data-testid="input-bulk-notes"
              />
            </div>
            <Separator />
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Employee Amounts</p>
                <Badge variant="outline">Total: {fmt(bulkTotal)}</Badge>
              </div>
              {employees.map((emp) => (
                <div key={emp.id} className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {emp.firstName} {emp.lastName}
                    </p>
                    <p className="text-xs text-muted-foreground">Balance: {fmt(emp.currentBalance)}</p>
                  </div>
                  <Input
                    type="number"
                    placeholder="0.00"
                    min="0"
                    step="0.01"
                    className="w-28 text-right"
                    value={bulkAmounts[emp.id] || ""}
                    onChange={(e) => setBulkAmounts((p) => ({ ...p, [emp.id]: e.target.value }))}
                    data-testid={`input-bulk-amount-${emp.id}`}
                  />
                </div>
              ))}
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setBulkOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => bulkMutation.mutate(), "Record Bulk Withdrawal")}
              disabled={bulkMutation.isPending || !bulkForm.cashAccountId || bulkTotal <= 0}
              data-testid="button-confirm-bulk-withdraw"
            >
              {bulkMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Record {fmt(bulkTotal)} Withdrawal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </div>
  );
}
