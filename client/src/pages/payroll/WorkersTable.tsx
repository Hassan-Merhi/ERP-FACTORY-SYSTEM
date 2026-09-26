import type { usePayrollModel } from "./usePayrollModel";

type PayrollModel = ReturnType<typeof usePayrollModel>;
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, MoreHorizontal, MinusCircle, Pencil, Trash2 } from "lucide-react";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { cn } from "@/lib/utils";
import type { Employee } from "@shared/schema";
import { getEmpAvatarColor, getEmpInitials } from "./payrollSchemas";

type PayrollWorker = Employee & {
  advanceInfo?: { total: number; count: number };
  deductionInfo?: { total: number; count: number };
};

interface WorkersTableProps {
  workers: PayrollWorker[];
  workerPayments: PayrollModel["workerPayments"];
  workerGroups: PayrollModel["workerGroupsData"];
  handleToggleWorker: (id: number) => void;
  handleUpdateAmount: (id: number, val: string) => void;
  handleDeleteWorker: (worker: Employee) => void;
  setStatementEmployee: (val: Employee | null) => void;
  setWorkerOverrides: PayrollModel["setWorkerOverrides"];
  formatAmount: (amt: number) => string;
  addWorkerToWorkerGroupMutation?: PayrollModel["addWorkerToWorkerGroupMutation"];
  groupId?: number;
  setWorkerDeductionTarget?: (val: Employee | null) => void;
  setSelectedWorkerForEdit?: (val: Employee | null) => void;
  setEditWorkerDialogOpen?: (val: boolean) => void;
}

export function WorkersTable({
  workers,
  workerPayments,
  workerGroups,
  handleToggleWorker,
  handleUpdateAmount,
  handleDeleteWorker,
  setStatementEmployee,
  setWorkerOverrides: _setWorkerOverrides,
  formatAmount,
  addWorkerToWorkerGroupMutation,
  groupId,
  setWorkerDeductionTarget,
  setSelectedWorkerForEdit,
  setEditWorkerDialogOpen,
}: WorkersTableProps) {
  const workersOnly = workers.filter((worker) => worker.employeeType === "Worker");

  if (workersOnly.length === 0) {
    return <div className="py-8 text-center text-sm text-muted-foreground">No workers in this group</div>;
  }

  const renderActions = (worker: PayrollWorker) => (
    <div className="flex items-center justify-end gap-1">
      {!groupId && workerGroups.length > 0 && addWorkerToWorkerGroupMutation && (
        <Select
          onValueChange={(groupValue) =>
            addWorkerToWorkerGroupMutation.mutate({ groupId: parseInt(groupValue), workerId: worker.id })
          }
        >
          <SelectTrigger className="hidden h-8 w-32 text-xs xl:flex" data-testid={`select-move-group-${worker.id}`}>
            <SelectValue placeholder="Assign group" />
          </SelectTrigger>
          <SelectContent>
            {workerGroups.map((group) => (
              <SelectItem key={group.id} value={String(group.id)}>
                {group.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="h-8 w-8" data-testid={`button-actions-worker-${worker.id}`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {setSelectedWorkerForEdit && setEditWorkerDialogOpen && (
            <DropdownMenuItem
              onClick={() => {
                setSelectedWorkerForEdit(worker);
                setEditWorkerDialogOpen(true);
              }}
              data-testid={`button-edit-worker-${worker.id}`}
            >
              <Pencil className="mr-2 h-4 w-4" /> Edit worker
            </DropdownMenuItem>
          )}
          {setWorkerDeductionTarget && (
            <DropdownMenuItem
              onClick={() => setWorkerDeductionTarget(worker)}
              data-testid={`button-deduction-${worker.id}`}
            >
              <MinusCircle className="mr-2 h-4 w-4" /> Add deduction
            </DropdownMenuItem>
          )}
          {!groupId && workerGroups.length > 0 && addWorkerToWorkerGroupMutation && (
            <DropdownMenuItem className="xl:hidden" onSelect={(event) => event.preventDefault()}>
              <span className="text-xs text-muted-foreground">Use Assign group beside this row on desktop</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmationDialog
        trigger={
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-destructive hover:text-destructive"
            data-testid={`button-delete-worker-${worker.id}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        }
        title="Delete Worker"
        description={`Are you sure you want to delete ${[worker.firstName, worker.lastName].filter(Boolean).join(" ")}? This action cannot be undone.`}
        confirmText="Delete"
        variant="destructive"
        onConfirm={() => handleDeleteWorker(worker)}
      />
    </div>
  );

  return (
    <div>
      <div className="hidden lg:block">
        <div className="grid grid-cols-[44px_minmax(220px,1.5fr)_110px_110px_110px_145px_150px] items-center gap-3 border-b bg-muted/10 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span />
          <span>Worker</span>
          <span>Salary</span>
          <span>Advances</span>
          <span>Deductions</span>
          <span>Pay amount</span>
          <span className="text-right">Actions</span>
        </div>

        <div className="divide-y divide-border/70">
          {workersOnly.map((worker) => {
            const advanceInfo = worker.advanceInfo ?? { total: 0, count: 0 };
            const deductionInfo = worker.deductionInfo ?? { total: 0, count: 0 };
            const monthlySalary = parseFloat(worker.monthlySalary || "0");
            const paymentAmount = parseFloat(workerPayments[worker.id]?.amount || "0");
            const isSelected = workerPayments[worker.id]?.selected || false;
            const hasNegativePayment = paymentAmount < 0;
            const initials = getEmpInitials(worker.firstName, worker.lastName);
            const avatarColor = getEmpAvatarColor(`${worker.firstName}${worker.lastName}`);

            return (
              <div
                key={worker.id}
                data-testid={`card-worker-${worker.id}`}
                className={cn(
                  "grid grid-cols-[44px_minmax(220px,1.5fr)_110px_110px_110px_145px_150px] items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/20",
                  isSelected && "bg-primary/[0.04]"
                )}
              >
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => handleToggleWorker(worker.id)}
                  data-testid={`checkbox-worker-${worker.id}`}
                />

                <div className="flex min-w-0 items-center gap-3">
                  <Avatar className="h-9 w-9 shrink-0">
                    <AvatarFallback className={`text-xs font-bold ${avatarColor}`}>{initials}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => setStatementEmployee(worker)}
                      className="block max-w-full truncate text-left text-sm font-semibold hover:underline"
                      data-testid={`link-worker-statement-${worker.id}`}
                    >
                      {[worker.firstName, worker.lastName].filter(Boolean).join(" ")}
                    </button>
                    <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{worker.code || "No code"}</span>
                      <Badge
                        variant={worker.active === false ? "secondary" : "outline"}
                        className="h-5 px-1.5 text-[10px]"
                      >
                        {worker.active === false ? "Inactive" : "Active"}
                      </Badge>
                    </div>
                  </div>
                </div>

                <p className="font-mono text-sm font-medium">{formatAmount(monthlySalary)}</p>

                <p
                  className={cn(
                    "font-mono text-sm",
                    advanceInfo.total > 0 ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  {advanceInfo.total > 0 ? formatAmount(advanceInfo.total) : "—"}
                </p>

                <p
                  className={cn(
                    "font-mono text-sm",
                    deductionInfo.total > 0 ? "text-amber-500" : "text-muted-foreground"
                  )}
                >
                  {deductionInfo.total > 0 ? formatAmount(deductionInfo.total) : "—"}
                </p>

                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    step="0.01"
                    value={workerPayments[worker.id]?.amount || "0"}
                    onChange={(event) => handleUpdateAmount(worker.id, event.target.value)}
                    className={cn("h-8 w-28 text-right font-mono text-xs", hasNegativePayment && "border-destructive")}
                    data-testid={`input-amount-${worker.id}`}
                  />
                  {hasNegativePayment && <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />}
                </div>

                {renderActions(worker)}
              </div>
            );
          })}
        </div>
      </div>

      <div className="divide-y divide-border/70 lg:hidden">
        {workersOnly.map((worker) => {
          const advanceInfo = worker.advanceInfo ?? { total: 0, count: 0 };
          const deductionInfo = worker.deductionInfo ?? { total: 0, count: 0 };
          const monthlySalary = parseFloat(worker.monthlySalary || "0");
          const paymentAmount = parseFloat(workerPayments[worker.id]?.amount || "0");
          const isSelected = workerPayments[worker.id]?.selected || false;
          const hasNegativePayment = paymentAmount < 0;
          const initials = getEmpInitials(worker.firstName, worker.lastName);
          const avatarColor = getEmpAvatarColor(`${worker.firstName}${worker.lastName}`);

          return (
            <div
              key={worker.id}
              className={cn("space-y-4 p-4", isSelected && "bg-primary/[0.04]")}
              data-testid={`card-worker-mobile-${worker.id}`}
            >
              <div className="flex items-start gap-3">
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => handleToggleWorker(worker.id)}
                  className="mt-2"
                  data-testid={`checkbox-worker-mobile-${worker.id}`}
                />
                <Avatar className="h-10 w-10 shrink-0">
                  <AvatarFallback className={`text-xs font-bold ${avatarColor}`}>{initials}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setStatementEmployee(worker)}
                    className="block max-w-full break-words text-left font-semibold hover:underline"
                  >
                    {[worker.firstName, worker.lastName].filter(Boolean).join(" ")}
                  </button>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{worker.code || "No code"}</span>
                    <Badge
                      variant={worker.active === false ? "secondary" : "outline"}
                      className="h-5 px-1.5 text-[10px]"
                    >
                      {worker.active === false ? "Inactive" : "Active"}
                    </Badge>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 rounded-xl bg-muted/20 p-3">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Salary</p>
                  <p className="mt-1 font-mono text-sm font-medium">{formatAmount(monthlySalary)}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Advances</p>
                  <p
                    className={cn(
                      "mt-1 font-mono text-sm",
                      advanceInfo.total > 0 ? "text-destructive" : "text-muted-foreground"
                    )}
                  >
                    {advanceInfo.total > 0 ? formatAmount(advanceInfo.total) : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Deductions</p>
                  <p
                    className={cn(
                      "mt-1 font-mono text-sm",
                      deductionInfo.total > 0 ? "text-amber-500" : "text-muted-foreground"
                    )}
                  >
                    {deductionInfo.total > 0 ? formatAmount(deductionInfo.total) : "—"}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Pay amount</p>
                  <p className="text-[11px] text-muted-foreground">Amount used for this payment run</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    step="0.01"
                    value={workerPayments[worker.id]?.amount || "0"}
                    onChange={(event) => handleUpdateAmount(worker.id, event.target.value)}
                    className={cn("h-9 w-28 text-right font-mono text-sm", hasNegativePayment && "border-destructive")}
                    data-testid={`input-amount-mobile-${worker.id}`}
                  />
                  {hasNegativePayment && <AlertCircle className="h-3.5 w-3.5 text-destructive" />}
                </div>
              </div>

              {/* Row actions get their own footer so the worker's name is never squeezed. */}
              <div className="border-t pt-3">{renderActions(worker)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
