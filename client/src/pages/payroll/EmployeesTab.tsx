import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/page-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, ChevronDown, ArrowDownCircle, Gift, ArrowUpCircle, Users, UserCheck, WalletCards } from "lucide-react";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { SearchField } from "@/components/ui/search-field";
import type { EmployeesTabProps } from "./EmployeesTabTypes";
import { EmployeesTabContent } from "./EmployeesTabContent";

export function EmployeesTab({
  empSearch,
  setEmpSearch,
  empStatusFilter,
  setEmpStatusFilter,
  setCreateEmployeeDialogOpen,
  employeeStaff,
  filteredEmployeeStaff,
  employeeGroups,
  setCreateGroupDialogOpen,
  setSelectedGroupForMembers,
  setGroupMembersDialogOpen,
  pendingBonuses,
  setBulkDepositSelections,
  setBulkDepositAmounts,
  setBulkDepositDialogOpen,
  setBulkBonusAmounts,
  setBulkBonusStep,
  setBulkBonusDialogOpen,
  setBulkWithdrawalAmounts,
  setBulkWithdrawalAccountId,
  setBulkWithdrawalDialogOpen,
  setStatementEmployee,
  handleDeposit,
  handleBonus,
  handleWithdrawal,
  setEditingEmployee,
  setEditEmployeeDialogOpen,
  handleDeleteEmployee,
  canChangeExistingRecords,
  canCreate,
}: EmployeesTabProps) {
  const canCreateEmployee = canCreate("POST", "/api/employees");
  const canCreateGroup = canCreate("POST", "/api/employee-groups");
  const { formatAmount } = useCurrencyContext();
  const activeCount = employeeStaff.filter((employee) => employee.active).length;
  const monthlyPayroll = employeeStaff
    .filter((employee) => employee.active)
    .reduce((sum, employee) => sum + parseFloat(employee.monthlySalary || "0"), 0);

  return (
    <div className="space-y-4 py-1">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border bg-card p-4 shadow-xs">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Employees</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight">{employeeStaff.length}</p>
            </div>
            <div className="rounded-lg bg-muted p-2.5 text-muted-foreground">
              <Users className="h-5 w-5" />
            </div>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4 shadow-xs">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Active</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight">{activeCount}</p>
            </div>
            <div className="rounded-lg bg-muted p-2.5 text-muted-foreground">
              <UserCheck className="h-5 w-5" />
            </div>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4 shadow-xs">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Monthly payroll</p>
              <p className="mt-1 truncate text-2xl font-semibold tracking-tight">{formatAmount(monthlyPayroll)}</p>
            </div>
            <div className="rounded-lg bg-muted p-2.5 text-muted-foreground">
              <WalletCards className="h-5 w-5" />
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card shadow-xs">
        <div className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
          <SearchField
            placeholder="Search by employee name, code, or department..."
            value={empSearch}
            onValueChange={setEmpSearch}
            wrapperClassName="min-w-0 flex-1 lg:max-w-xl"
            className="h-10 bg-background"
            data-testid="input-employee-search"
          />

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border bg-muted/40 p-1">
              {["Active", "Inactive", "All"].map((status) => (
                <Button
                  key={status}
                  size="sm"
                  variant="ghost"
                  className={`h-8 rounded-md px-3 ${
                    empStatusFilter === status ? "bg-background shadow-xs hover:bg-background" : "text-muted-foreground"
                  }`}
                  onClick={() => setEmpStatusFilter(status)}
                  data-testid={`button-emp-filter-${status.toLowerCase()}`}
                >
                  {status}
                </Button>
              ))}
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="h-10" data-testid="button-employee-groups">
                  <Users className="mr-2 h-4 w-4" />
                  Groups
                  <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {canCreateGroup && (
                  <DropdownMenuItem
                    onClick={() => setCreateGroupDialogOpen(true)}
                    data-testid="button-create-employee-group"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Create Group
                  </DropdownMenuItem>
                )}
                {canCreateGroup && employeeGroups.length > 0 && <DropdownMenuSeparator />}
                {employeeGroups.map((group) => (
                  <DropdownMenuItem
                    key={group.id}
                    onClick={() => {
                      setSelectedGroupForMembers(group);
                      setGroupMembersDialogOpen(true);
                    }}
                    data-testid={`button-manage-employee-group-${group.id}`}
                  >
                    <Users className="mr-2 h-4 w-4" />
                    <span className="truncate">{group.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {canChangeExistingRecords && employeeStaff.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="h-10" data-testid="button-open-payroll-actions">
                    Payroll Actions
                    {Object.keys(pendingBonuses).length > 0 && (
                      <Badge className="ml-2" variant="default">
                        {Object.keys(pendingBonuses).length}
                      </Badge>
                    )}
                    <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem
                    onClick={() => {
                      setBulkDepositSelections({});
                      setBulkDepositAmounts({});
                      setBulkDepositDialogOpen(true);
                    }}
                    data-testid="button-open-bulk-deposit"
                  >
                    <ArrowDownCircle className="mr-2 h-4 w-4" /> Bulk Deposit
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      const fromPending: Record<number, string> = {};
                      for (const [empId, pendingBonus] of Object.entries(pendingBonuses)) {
                        fromPending[parseInt(empId)] = pendingBonus.amount.toFixed(2);
                      }
                      setBulkBonusAmounts(fromPending);
                      setBulkBonusStep("edit");
                      setBulkBonusDialogOpen(true);
                    }}
                    data-testid="button-open-bulk-bonus"
                  >
                    <Gift className="mr-2 h-4 w-4" /> Bulk Bonus Deposit
                    {Object.keys(pendingBonuses).length > 0 && (
                      <Badge className="ml-auto" variant="default">
                        {Object.keys(pendingBonuses).length}
                      </Badge>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      setBulkWithdrawalAmounts({});
                      setBulkWithdrawalAccountId("");
                      setBulkWithdrawalDialogOpen(true);
                    }}
                    data-testid="button-open-bulk-withdrawal"
                  >
                    <ArrowUpCircle className="mr-2 h-4 w-4" /> Bulk Withdrawal
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {canCreateEmployee && (
              <Button
                className="h-10"
                onClick={() => setCreateEmployeeDialogOpen(true)}
                data-testid="button-create-employee"
              >
                <Plus className="mr-2 h-4 w-4" />
                New Employee
              </Button>
            )}
          </div>
        </div>

        {employeeStaff.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No employees yet"
            description="Create your first employee to start managing payroll."
            className="rounded-none border-0 bg-transparent px-6 py-16"
          />
        ) : filteredEmployeeStaff.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <p className="font-medium">No matching employees</p>
            <p className="mt-1 text-sm text-muted-foreground">Try a different search or status filter.</p>
          </div>
        ) : (
          // Phones: each employee is a card (two figures per row, labelled); sm+ keeps the grid table.
          <EmployeesTabContent
            canChangeExistingRecords={canChangeExistingRecords}
            filteredEmployeeStaff={filteredEmployeeStaff}
            formatAmount={formatAmount}
            handleBonus={handleBonus}
            handleDeleteEmployee={handleDeleteEmployee}
            handleDeposit={handleDeposit}
            handleWithdrawal={handleWithdrawal}
            setEditEmployeeDialogOpen={setEditEmployeeDialogOpen}
            setEditingEmployee={setEditingEmployee}
            setStatementEmployee={setStatementEmployee}
          />
        )}
      </div>
    </div>
  );
}
