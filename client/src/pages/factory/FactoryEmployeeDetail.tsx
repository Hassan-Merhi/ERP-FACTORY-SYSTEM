import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
import {
  ArrowLeft,
  DollarSign,
  Calendar,
  Phone,
  Loader2,
  Pencil,
  TrendingUp,
  TrendingDown,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { getAvatarColor, getInitials } from "@/pages/factory/factoryworkers/utils";
import { PersonStatusBadge } from "@/pages/factory/people/PeopleRoster";
import { fmt } from "./FactoryEmployeeDetailTypes";
import { useFactoryEmployeeDetailState } from "./useFactoryEmployeeDetailState";
import { FactoryEmployeeDetailDialogSection, FactoryEmployeeDetailSection } from "./FactoryEmployeeDetailDialogSection";

export default function FactoryEmployeeDetail() {
  const {
    activeTab,
    exportBusy,
    exportStatement,
    setRequestedTab,
    showAdvancesTab,
    showAttendanceTab,
    statementRows,
    stmtError,
    refetchStatement,
    AdminDialog,
    cashAccounts,
    depositAmount,
    depositDate,
    depositEffectiveDate,
    depositMutation,
    depositNotes,
    depositOpen,
    editForm,
    editOpen,
    empError,
    empLoading,
    employee,
    employeeId,
    formatDate,
    isDeveloper,
    navigate,
    recalcMutation,
    recordChanges,
    setDepositAmount,
    setDepositDate,
    setDepositEffectiveDate,
    setDepositNotes,
    setDepositOpen,
    setEditForm,
    setEditOpen,
    setWithdrawAmount,
    setWithdrawCashAccountId,
    setWithdrawDate,
    setWithdrawNotes,
    setWithdrawOpen,
    statement,
    stmtLoading,
    updateMutation,
    withdrawAmount,
    withdrawCashAccountId,
    withdrawDate,
    withdrawMutation,
    withdrawNotes,
    withdrawOpen,
    wrapAdminAction,
  } = useFactoryEmployeeDetailState();

  if (!employeeId) return <div className="p-8 text-muted-foreground">Invalid employee ID</div>;

  if (empLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <div className="flex gap-6">
          <Skeleton className="w-64 h-80 shrink-0 rounded-md" />
          <Skeleton className="flex-1 h-80 rounded-md" />
        </div>
      </div>
    );
  }

  if (empError || !employee) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/factory/payroll-hub?section=employees")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center justify-center py-20 text-muted-foreground">Employee not found</div>
      </div>
    );
  }

  const fullName = `${employee.firstName} ${employee.lastName}`;
  const avatarColor = getAvatarColor(fullName);
  const balance = parseFloat(employee.currentBalance || "0");

  return (
    <div className="space-y-4">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => navigate("/factory/payroll-hub?section=employees")}
        data-testid="button-back"
        aria-label="Back to Employees"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>

      <div className="flex flex-col lg:flex-row gap-6 items-stretch lg:items-start">
        {/* Left Summary Card */}
        <div className="w-full lg:w-72 shrink-0 space-y-4">
          <Card>
            <CardContent className="p-5 space-y-4">
              <div className="flex flex-col items-center text-center gap-3">
                <Avatar className={`h-20 w-20 text-lg font-bold ${avatarColor}`}>
                  <AvatarFallback className={`text-lg font-bold ${avatarColor}`} data-testid="text-employee-avatar">
                    {getInitials(fullName)}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <h2 className="font-bold text-lg leading-tight" data-testid="text-employee-name">
                    {fullName}
                  </h2>
                  {employee.department && <p className="text-sm text-muted-foreground mt-0.5">{employee.department}</p>}
                </div>
                <PersonStatusBadge active={employee.active} data-testid="badge-employee-status" />
              </div>

              <div className="border-t pt-3 space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground text-xs">Code</span>
                  <span className="font-mono text-xs ml-auto" data-testid="text-employee-code">
                    {employee.code}
                  </span>
                </div>
                {employee.phone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs ml-auto" data-testid="text-employee-phone">
                      {employee.phone}
                    </span>
                  </div>
                )}
                {employee.joinDate && (
                  <div className="flex items-center gap-2 text-sm">
                    <Calendar className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs ml-auto">Joined {formatDate(employee.joinDate)}</span>
                  </div>
                )}
                <div className="flex items-center gap-2 text-sm">
                  <DollarSign className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-xs font-mono ml-auto">{fmt(employee.monthlySalary)} / mo</span>
                </div>
              </div>

              <div className="border-t pt-3 space-y-2">
                <div className="text-center">
                  <div className="text-xs text-muted-foreground mb-1">Current Balance</div>
                  <div
                    className={`text-xl font-bold font-mono ${balance < 0 ? "text-red-600 dark:text-red-400" : balance > 0 ? "text-green-600 dark:text-green-400" : ""}`}
                    data-testid="text-employee-balance"
                  >
                    {fmt(employee.currentBalance)}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-center">
                  <div>
                    <div className="text-muted-foreground">Deposits</div>
                    <div className="font-mono font-medium text-green-600 dark:text-green-400">
                      {fmt(employee.totalDeposits)}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Withdrawn</div>
                    <div className="font-mono font-medium text-red-600 dark:text-red-400">
                      {fmt(employee.totalWithdrawals)}
                    </div>
                  </div>
                </div>
              </div>

              {recordChanges.allowed && (
                <div className="border-t pt-3 space-y-2">
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      setEditForm({
                        firstName: employee.firstName,
                        lastName: employee.lastName,
                        department: employee.department || "",
                        phone: employee.phone || "",
                        monthlySalary: employee.monthlySalary || "",
                      });
                      setEditOpen(true);
                    }}
                    data-testid="button-edit-employee"
                  >
                    <Pencil className="h-3.5 w-3.5 mr-2" />
                    Edit
                  </Button>
                  {isDeveloper && (
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => wrapAdminAction(() => recalcMutation.mutate(), "Recalculate Balance")}
                      disabled={recalcMutation.isPending}
                      data-testid="button-recalculate-balance"
                    >
                      {recalcMutation.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5 mr-2" />
                      )}
                      Recalculate
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <FactoryEmployeeDetailSection
          activeTab={activeTab}
          employee={employee}
          exportBusy={exportBusy}
          exportStatement={exportStatement}
          formatDate={formatDate}
          fullName={fullName}
          refetchStatement={refetchStatement}
          setRequestedTab={setRequestedTab}
          showAdvancesTab={showAdvancesTab}
          showAttendanceTab={showAttendanceTab}
          statement={statement}
          statementRows={statementRows}
          stmtError={stmtError}
          stmtLoading={stmtLoading}
        />
      </div>

      <FactoryEmployeeDetailDialogSection
        editForm={editForm}
        editOpen={editOpen}
        setEditForm={setEditForm}
        setEditOpen={setEditOpen}
        updateMutation={updateMutation}
        wrapAdminAction={wrapAdminAction}
      />

      {/* Deposit Dialog */}
      <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Deposit for {fullName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Amount *</Label>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                placeholder="0.00"
                data-testid="input-deposit-amount"
              />
            </div>
            <div className="space-y-1">
              <Label>Entry Date *</Label>
              <Input
                type="date"
                value={depositDate}
                onChange={(e) => setDepositDate(e.target.value)}
                data-testid="input-deposit-date"
              />
            </div>
            <div className="space-y-1">
              <Label>
                Effective Date <span className="text-muted-foreground">(optional — period it belongs to)</span>
              </Label>
              <Input
                type="date"
                value={depositEffectiveDate}
                onChange={(e) => setDepositEffectiveDate(e.target.value)}
                data-testid="input-deposit-effective-date"
              />
            </div>
            <div className="space-y-1">
              <Label>Notes</Label>
              <Input
                value={depositNotes}
                onChange={(e) => setDepositNotes(e.target.value)}
                placeholder="Optional notes"
                data-testid="input-deposit-notes"
              />
            </div>
            <div className="bg-muted/50 rounded-md p-3 text-sm space-y-1">
              <div className="font-medium text-xs text-muted-foreground mb-1">Accounting Entry</div>
              <div className="flex justify-between">
                <span>DR: Payroll Expense</span>
                <span className="font-mono">{fmt(depositAmount || 0)}</span>
              </div>
              <div className="flex justify-between">
                <span>CR: Employee Account ({employee.code})</span>
                <span className="font-mono">{fmt(depositAmount || 0)}</span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDepositOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => depositMutation.mutate(), "Post Deposit")}
              disabled={depositMutation.isPending || !depositAmount}
              data-testid="button-confirm-deposit"
            >
              {depositMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Posting...
                </>
              ) : (
                <>
                  <TrendingUp className="h-4 w-4 mr-2" />
                  Post Deposit
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Withdrawal Dialog */}
      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Withdrawal for {fullName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Amount *</Label>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="0.00"
                data-testid="input-withdraw-amount"
              />
            </div>
            <div className="space-y-1">
              <Label>Date *</Label>
              <Input
                type="date"
                value={withdrawDate}
                onChange={(e) => setWithdrawDate(e.target.value)}
                data-testid="input-withdraw-date"
              />
            </div>
            <div className="space-y-1">
              <Label>Cash Account *</Label>
              <UnifiedAccountPicker
                    value={withdrawCashAccountId}
                    onChange={setWithdrawCashAccountId}
                    options={cashAccounts.map((account) => ({ value: String(account.id), name: account.name }))}
                    placeholder="Select cash account"
                    testId="select-cash-account"
                  />
            </div>
            <div className="space-y-1">
              <Label>Notes</Label>
              <Input
                value={withdrawNotes}
                onChange={(e) => setWithdrawNotes(e.target.value)}
                placeholder="Optional notes"
                data-testid="input-withdraw-notes"
              />
            </div>
            <div className="bg-muted/50 rounded-md p-3 text-sm space-y-1">
              <div className="font-medium text-xs text-muted-foreground mb-1">Accounting Entry</div>
              <div className="flex justify-between">
                <span>DR: Employee Account ({employee.code})</span>
                <span className="font-mono">{fmt(withdrawAmount || 0)}</span>
              </div>
              <div className="flex justify-between">
                <span>CR: Cash</span>
                <span className="font-mono">{fmt(withdrawAmount || 0)}</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Note: Withdrawals are allowed even if they result in a negative balance.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWithdrawOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => withdrawMutation.mutate(), "Post Withdrawal")}
              disabled={withdrawMutation.isPending || !withdrawAmount || !withdrawCashAccountId}
              data-testid="button-confirm-withdraw"
            >
              {withdrawMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Posting...
                </>
              ) : (
                <>
                  <TrendingDown className="h-4 w-4 mr-2" />
                  Post Withdrawal
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </div>
  );
}
