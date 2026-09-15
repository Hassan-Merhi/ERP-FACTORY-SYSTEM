import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Search,
  Plus,
  ChevronDown,
  ArrowDownCircle,
  Gift,
  ArrowUpCircle,
  TrendingUp,
  DollarSign,
  TrendingDown,
  Pencil,
  Trash2,
  Users,
  UserCheck,
  WalletCards,
} from "lucide-react";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import type { Employee } from "@shared/schema";
import { getEmpAvatarColor, getEmpInitials } from "./payrollSchemas";

interface EmployeesTabProps {
  empSearch: string;
  setEmpSearch: (val: string) => void;
  empStatusFilter: string;
  setEmpStatusFilter: (val: string) => void;
  setCreateEmployeeDialogOpen: (val: boolean) => void;
  employeeStaff: (Employee & { calculatedBalance: string })[];
  filteredEmployeeStaff: (Employee & { calculatedBalance: string })[];
  pendingBonuses: Record<number, { amount: number; description: string; employeeName: string }>;
  setBulkDepositSelections: (val: Record<number, boolean>) => void;
  setBulkDepositDialogOpen: (val: boolean) => void;
  setBulkBonusAmounts: (val: Record<number, string>) => void;
  setBulkBonusStep: (val: "edit" | "preview") => void;
  setBulkBonusDialogOpen: (val: boolean) => void;
  setBulkWithdrawalAmounts: (val: Record<number, string>) => void;
  setBulkWithdrawalAccountId: (val: string) => void;
  setBulkWithdrawalDialogOpen: (val: boolean) => void;
  setStatementEmployee: (val: (Employee & { calculatedBalance?: string }) | null) => void;
  handleDeposit: (emp: Employee) => void;
  handleBonus: (emp: Employee) => void;
  handleWithdrawal: (emp: Employee) => void;
  setEditingEmployee: (emp: Employee | null) => void;
  setEditEmployeeDialogOpen: (val: boolean) => void;
  handleDeleteEmployee: (emp: Employee) => void;
}

export function EmployeesTab({
  empSearch,
  setEmpSearch,
  empStatusFilter,
  setEmpStatusFilter,
  setCreateEmployeeDialogOpen,
  employeeStaff,
  filteredEmployeeStaff,
  pendingBonuses,
  setBulkDepositSelections,
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
}: EmployeesTabProps) {
  const { formatAmount } = useCurrencyContext();
  const activeCount = employeeStaff.filter((employee) => employee.active).length;
  const monthlyPayroll = employeeStaff
    .filter((employee) => employee.active)
    .reduce((sum, employee) => sum + parseFloat(employee.monthlySalary || "0"), 0);

  return (
    <div className="space-y-4 py-1">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border bg-card p-4 shadow-sm">
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
        <div className="rounded-xl border bg-card p-4 shadow-sm">
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
        <div className="rounded-xl border bg-card p-4 shadow-sm">
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

      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative min-w-0 flex-1 lg:max-w-xl">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by employee name, code, or department..."
              value={empSearch}
              onChange={(e) => setEmpSearch(e.target.value)}
              className="h-10 bg-background pl-9"
              data-testid="input-employee-search"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border bg-muted/40 p-1">
              {["Active", "Inactive", "All"].map((status) => (
                <Button
                  key={status}
                  size="sm"
                  variant="ghost"
                  className={`h-8 rounded-md px-3 ${
                    empStatusFilter === status ? "bg-background shadow-sm hover:bg-background" : "text-muted-foreground"
                  }`}
                  onClick={() => setEmpStatusFilter(status)}
                  data-testid={`button-emp-filter-${status.toLowerCase()}`}
                >
                  {status}
                </Button>
              ))}
            </div>

            {employeeStaff.length > 0 && (
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

            <Button className="h-10" onClick={() => setCreateEmployeeDialogOpen(true)} data-testid="button-create-employee">
              <Plus className="mr-2 h-4 w-4" />
              New Employee
            </Button>
          </div>
        </div>

        {employeeStaff.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Users className="h-5 w-5" />
            </div>
            <p className="font-medium">No employees yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Create your first employee to start managing payroll.</p>
          </div>
        ) : filteredEmployeeStaff.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <p className="font-medium">No matching employees</p>
            <p className="mt-1 text-sm text-muted-foreground">Try a different search or status filter.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[980px]">
              <div className="grid grid-cols-[minmax(260px,1.5fr)_130px_150px_140px_140px_150px] items-center gap-3 border-b bg-muted/25 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <div>Employee</div>
                <div>Salary</div>
                <div>Balance</div>
                <div>Deposits</div>
                <div>Withdrawals</div>
                <div className="text-right">Actions</div>
              </div>

              {filteredEmployeeStaff.map((employee) => {
                const balance = parseFloat(employee.calculatedBalance || "0");
                const initials = getEmpInitials(employee.firstName, employee.lastName);
                const avatarColor = getEmpAvatarColor(`${employee.firstName}${employee.lastName}`);

                return (
                  <div
                    key={employee.id}
                    className="grid grid-cols-[minmax(260px,1.5fr)_130px_150px_140px_140px_150px] items-center gap-3 border-b px-5 py-3.5 transition-colors last:border-b-0 hover:bg-muted/25"
                    data-testid={`card-employee-${employee.id}`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar className="h-10 w-10 shrink-0 border">
                        <AvatarFallback className={`text-sm font-bold ${avatarColor}`}>{initials}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <button
                            onClick={() => setStatementEmployee(employee)}
                            className="truncate text-left font-semibold hover:underline"
                            data-testid={`link-employee-statement-${employee.id}`}
                          >
                            {employee.firstName} {employee.lastName}
                          </button>
                          <Badge variant={employee.active ? "outline" : "secondary"} className="shrink-0 text-[10px]">
                            {employee.active ? "Active" : "Inactive"}
                          </Badge>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {[employee.code, employee.department].filter(Boolean).join(" · ") || "No department"}
                        </p>
                      </div>
                    </div>

                    <div>
                      <p className="font-mono text-sm font-medium">{formatAmount(parseFloat(employee.monthlySalary || "0"))}</p>
                    </div>
                    <div>
                      <p className={`font-mono text-sm font-semibold ${balance >= 0 ? "text-emerald-500" : "text-destructive"}`}>
                        {formatAmount(balance)}
                      </p>
                    </div>
                    <div>
                      <p className="font-mono text-sm text-muted-foreground">
                        {formatAmount(parseFloat(employee.totalDeposits || "0"))}
                      </p>
                    </div>
                    <div>
                      <p className="font-mono text-sm text-muted-foreground">
                        {formatAmount(parseFloat(employee.totalWithdrawals || "0"))}
                      </p>
                    </div>

                    <div className="flex items-center justify-end gap-1">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="outline" className="h-8" data-testid={`button-actions-${employee.id}`}>
                            Actions <ChevronDown className="ml-1 h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleDeposit(employee)} data-testid={`button-deposit-${employee.id}`}>
                            <TrendingUp className="mr-2 h-4 w-4" /> Deposit
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleBonus(employee)} data-testid={`button-bonus-${employee.id}`}>
                            <DollarSign className="mr-2 h-4 w-4" /> Bonus
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleWithdrawal(employee)}
                            data-testid={`button-withdraw-${employee.id}`}
                          >
                            <TrendingDown className="mr-2 h-4 w-4" /> Withdraw
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>

                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => {
                          setEditingEmployee(employee);
                          setEditEmployeeDialogOpen(true);
                        }}
                        aria-label={`Edit ${employee.firstName} ${employee.lastName}`}
                        data-testid={`button-edit-${employee.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>

                      <ConfirmationDialog
                        trigger={
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            aria-label={`Delete ${employee.firstName} ${employee.lastName}`}
                            data-testid={`button-delete-${employee.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        }
                        title="Delete Employee"
                        description={`Are you sure you want to delete ${[employee.firstName, employee.lastName]
                          .filter(Boolean)
                          .join(" ")}? This action cannot be undone.`}
                        confirmText="Delete"
                        variant="destructive"
                        onConfirm={() => handleDeleteEmployee(employee)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
