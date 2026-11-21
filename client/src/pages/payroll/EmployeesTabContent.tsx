// Extracted from ./EmployeesTab.tsx
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, TrendingUp, DollarSign, TrendingDown, Pencil, Trash2 } from "lucide-react";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { getEmpAvatarColor, getEmpInitials } from "./payrollSchemas";
import type { EmployeesTabProps } from "./EmployeesTabTypes";

export function EmployeesTabContent({
  canChangeExistingRecords,
  filteredEmployeeStaff,
  formatAmount,
  handleBonus,
  handleDeleteEmployee,
  handleDeposit,
  handleWithdrawal,
  setEditEmployeeDialogOpen,
  setEditingEmployee,
  setStatementEmployee,
}: Pick<
  EmployeesTabProps,
  | "canChangeExistingRecords"
  | "filteredEmployeeStaff"
  | "handleBonus"
  | "handleDeleteEmployee"
  | "handleDeposit"
  | "handleWithdrawal"
  | "setEditEmployeeDialogOpen"
  | "setEditingEmployee"
  | "setStatementEmployee"
> &
  Pick<ReturnType<typeof useCurrencyContext>, "formatAmount">) {
  return (
    <div className="overflow-x-auto" data-testid="employee-list">
      <div className="sm:min-w-[980px]">
        <div className="hidden grid-cols-[minmax(260px,1.5fr)_130px_150px_140px_140px_150px] items-center gap-3 border-b bg-muted/25 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid">
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
              className="grid grid-cols-2 items-center gap-3 border-b px-4 py-3.5 transition-colors last:border-b-0 hover:bg-muted/25 sm:grid-cols-[minmax(260px,1.5fr)_130px_150px_140px_140px_150px] sm:px-5"
              data-testid={`card-employee-${employee.id}`}
            >
              <div className="col-span-2 flex min-w-0 items-center gap-3 sm:col-span-1">
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
                    <Badge variant={employee.active ? "outline" : "secondary"} className="shrink-0 text-[11px]">
                      {employee.active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {[employee.code, employee.department].filter(Boolean).join(" · ") || "No department"}
                  </p>
                </div>
              </div>

              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:hidden">
                  Salary
                </p>
                <p className="font-mono text-sm font-medium">
                  {formatAmount(parseFloat(employee.monthlySalary || "0"))}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:hidden">
                  Balance
                </p>
                <p
                  className={`font-mono text-sm font-semibold ${balance >= 0 ? "text-emerald-500" : "text-destructive"}`}
                >
                  {formatAmount(balance)}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:hidden">
                  Deposits
                </p>
                <p className="font-mono text-sm text-muted-foreground">
                  {formatAmount(parseFloat(employee.totalDeposits || "0"))}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:hidden">
                  Withdrawals
                </p>
                <p className="font-mono text-sm text-muted-foreground">
                  {formatAmount(parseFloat(employee.totalWithdrawals || "0"))}
                </p>
              </div>

              <div className="col-span-2 flex items-center justify-end gap-1 max-sm:border-t max-sm:pt-2 sm:col-span-1">
                {canChangeExistingRecords && (
                  <>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8"
                          data-testid={`button-actions-${employee.id}`}
                        >
                          Actions <ChevronDown className="ml-1 h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => handleDeposit(employee)}
                          data-testid={`button-deposit-${employee.id}`}
                        >
                          <TrendingUp className="mr-2 h-4 w-4" /> Deposit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleBonus(employee)}
                          data-testid={`button-bonus-${employee.id}`}
                        >
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
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
