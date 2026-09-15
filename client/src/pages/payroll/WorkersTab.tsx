import { useMemo, useState } from "react";
import type { usePayrollModel } from "./usePayrollModel";

type PayrollModel = ReturnType<typeof usePayrollModel>;
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Banknote,
  CheckCheck,
  ChevronDown,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserRoundPlus,
  Users,
  WalletCards,
} from "lucide-react";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import type { Employee } from "@shared/schema";
import { WorkersTable } from "./WorkersTable";

interface WorkersTabProps {
  setNewWorkerDialogOpen: (val: boolean) => void;
  workerPaymentSummary: PayrollModel["workerPaymentSummary"];
  setBulkPaymentDialogOpen: (val: boolean) => void;
  selectedPayments: PayrollModel["selectedPayments"];
  totalAmount: number;
  workerStaff: Employee[];
  workerGroups: PayrollModel["workerGroupsData"];
  workerGroupsExpanded: Record<number, boolean>;
  setWorkerGroupsExpanded: PayrollModel["setWorkerGroupsExpanded"];
  workerPayments: PayrollModel["workerPayments"];
  setWorkerOverrides: PayrollModel["setWorkerOverrides"];
  setCreateWorkerGroupDialogOpen: (val: boolean) => void;
  setSelectedWorkerGroupForMembers: PayrollModel["setSelectedWorkerGroupForMembers"];
  setWorkerGroupMembersDialogOpen: (val: boolean) => void;
  setWorkerGroupMemberSelections: PayrollModel["setWorkerGroupMemberSelections"];
  deleteWorkerGroupMutation: PayrollModel["deleteWorkerGroupMutation"];
  handleToggleWorker: (id: number) => void;
  handleUpdateAmount: (id: number, val: string) => void;
  handleDeleteWorker: (worker: Employee) => void;
  setStatementEmployee: (val: Employee | null) => void;
  ungroupedWorkers: Employee[];
  addWorkerToWorkerGroupMutation: PayrollModel["addWorkerToWorkerGroupMutation"];
  setWorkerDeductionTarget: (val: Employee | null) => void;
  setSelectedWorkerForEdit: (val: Employee | null) => void;
  setEditWorkerDialogOpen: (val: boolean) => void;
}

export function WorkersTab({
  setNewWorkerDialogOpen,
  setBulkPaymentDialogOpen,
  selectedPayments,
  totalAmount,
  workerStaff,
  workerGroups,
  workerPayments,
  setWorkerOverrides,
  setCreateWorkerGroupDialogOpen,
  setSelectedWorkerGroupForMembers,
  setWorkerGroupMembersDialogOpen,
  setWorkerGroupMemberSelections,
  deleteWorkerGroupMutation,
  handleToggleWorker,
  handleUpdateAmount,
  handleDeleteWorker,
  setStatementEmployee,
  ungroupedWorkers,
  addWorkerToWorkerGroupMutation,
  setWorkerDeductionTarget,
  setSelectedWorkerForEdit,
  setEditWorkerDialogOpen,
}: WorkersTabProps) {
  const { formatAmount } = useCurrencyContext();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");

  // The Workers tab must never render Employee records. The API also enforces
  // this boundary, but this client-side guard protects the UI from stale cache
  // data or historical memberships that predate the server validation.
  const workersOnly = useMemo(() => workerStaff.filter((worker) => worker.employeeType === "Worker"), [workerStaff]);
  const workerGroupsOnly = useMemo(
    () =>
      workerGroups.map((group) => ({
        ...group,
        members: (group.members || []).filter((member) => member.employeeType === "Worker"),
      })),
    [workerGroups]
  );

  const normalizedSearch = search.trim().toLowerCase();
  const matchesFilters = (worker: Employee) => {
    const matchesSearch =
      !normalizedSearch ||
      `${worker.firstName} ${worker.lastName}`.toLowerCase().includes(normalizedSearch) ||
      (worker.code || "").toLowerCase().includes(normalizedSearch) ||
      (worker.department || "").toLowerCase().includes(normalizedSearch);
    const matchesStatus =
      statusFilter === "all" || (statusFilter === "active" ? worker.active !== false : worker.active === false);
    return matchesSearch && matchesStatus;
  };

  const filteredWorkers = workersOnly.filter(matchesFilters);
  const filteredGroups = workerGroupsOnly
    .map((group) => ({ ...group, members: group.members.filter(matchesFilters) }))
    .filter((group) => group.members.length > 0);
  const filteredUngroupedWorkers = ungroupedWorkers.filter(
    (worker) => worker.employeeType === "Worker" && matchesFilters(worker)
  );

  const allSelected = workersOnly.length > 0 && workersOnly.every((worker) => workerPayments[worker.id]?.selected);
  const activeWorkers = workersOnly.filter((worker) => worker.active !== false).length;

  const handleSelectAll = () => {
    const shouldSelectAll = !allSelected;
    setWorkerOverrides((previous) => {
      const next = { ...previous };
      workersOnly.forEach((worker) => {
        next[worker.id] = { ...next[worker.id], selected: shouldSelectAll };
      });
      return next;
    });
  };

  const openGroupManager = (group: PayrollModel["workerGroupsData"][number]) => {
    const workerMembers = (group.members || []).filter((member) => member.employeeType === "Worker");
    setSelectedWorkerGroupForMembers({ ...group, members: workerMembers });
    setWorkerGroupMembersDialogOpen(true);
    const selections: Record<number, boolean> = {};
    workerMembers.forEach((member) => {
      selections[member.id] = true;
    });
    setWorkerGroupMemberSelections(selections);
  };

  return (
    <div className="space-y-5 pt-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="border-border/70 bg-card/70 p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total workers</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight">{workersOnly.length}</p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Users className="h-5 w-5" />
            </div>
          </div>
        </Card>

        <Card className="border-border/70 bg-card/70 p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Active workers</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight">{activeWorkers}</p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500">
              <CheckCheck className="h-5 w-5" />
            </div>
          </div>
        </Card>

        <Card className="border-border/70 bg-card/70 p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Worker groups</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight">{workerGroupsOnly.length}</p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10 text-violet-500">
              <WalletCards className="h-5 w-5" />
            </div>
          </div>
        </Card>

        <Card className="border-border/70 bg-card/70 p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Selected to pay</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight">{selectedPayments.length}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{formatAmount(totalAmount)}</p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
              <Banknote className="h-5 w-5" />
            </div>
          </div>
        </Card>
      </div>

      <Card className="border-border/70 bg-card/60 p-3 shadow-sm">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1 sm:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search workers by name, code, or department..."
                className="h-10 pl-9"
                data-testid="input-search-workers"
              />
            </div>
            <div className="flex items-center gap-1 rounded-lg border bg-muted/30 p-1">
              {(["all", "active", "inactive"] as const).map((status) => (
                <Button
                  key={status}
                  type="button"
                  size="sm"
                  variant={statusFilter === status ? "secondary" : "ghost"}
                  className="h-8 capitalize"
                  onClick={() => setStatusFilter(status)}
                  data-testid={`button-worker-filter-${status}`}
                >
                  {status}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={handleSelectAll}
              disabled={workersOnly.length === 0}
              data-testid="button-select-all-workers"
            >
              <CheckCheck className="mr-2 h-4 w-4" />
              {allSelected ? "Deselect All" : "Select All"}
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" data-testid="button-worker-groups">
                  <Users className="mr-2 h-4 w-4" />
                  Groups
                  <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onClick={() => setCreateWorkerGroupDialogOpen(true)} data-testid="button-create-worker-group">
                  <Plus className="mr-2 h-4 w-4" />
                  Create Group
                </DropdownMenuItem>
                {workerGroupsOnly.length > 0 && <DropdownMenuSeparator />}
                {workerGroupsOnly.map((group) => (
                  <DropdownMenuItem
                    key={group.id}
                    onClick={() => openGroupManager(group)}
                    data-testid={`button-open-worker-group-${group.id}`}
                  >
                    <Users className="mr-2 h-4 w-4" />
                    <span className="truncate">{group.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button variant="outline" onClick={() => setNewWorkerDialogOpen(true)} data-testid="button-create-worker">
              <UserRoundPlus className="mr-2 h-4 w-4" />
              New Worker
            </Button>
            <Button
              onClick={() => setBulkPaymentDialogOpen(true)}
              disabled={selectedPayments.length === 0}
              data-testid="button-bulk-payment"
            >
              <Banknote className="mr-2 h-4 w-4" />
              Pay Selected ({selectedPayments.length})
            </Button>
          </div>
        </div>
      </Card>

      {selectedPayments.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold">{selectedPayments.length} workers ready for payment</p>
            <p className="text-xs text-muted-foreground">Review individual pay amounts below before processing.</p>
          </div>
          <Badge variant="secondary" className="w-fit text-sm font-semibold">
            {formatAmount(totalAmount)} total
          </Badge>
        </div>
      )}

      {workersOnly.length === 0 ? (
        <Card className="border-dashed py-16 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
            <Users className="h-5 w-5 text-muted-foreground" />
          </div>
          <h3 className="mt-4 font-semibold">No workers yet</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Workers are separate from Employees. Add a Worker here to manage worker payroll and deductions.
          </p>
          <Button className="mt-4" onClick={() => setNewWorkerDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> New Worker
          </Button>
        </Card>
      ) : filteredWorkers.length === 0 ? (
        <Card className="border-dashed py-14 text-center">
          <Search className="mx-auto h-5 w-5 text-muted-foreground" />
          <h3 className="mt-3 font-semibold">No matching workers</h3>
          <p className="mt-1 text-sm text-muted-foreground">Try another search or status filter.</p>
        </Card>
      ) : (
        <div className="space-y-5">
          {filteredGroups.map((group) => {
            const groupSelected = group.members.filter((member) => workerPayments[member.id]?.selected).length;
            const groupPayTotal = group.members.reduce((sum, member) => {
              const payment = workerPayments[member.id];
              return sum + (payment?.selected ? parseFloat(payment.amount || "0") : 0);
            }, 0);

            return (
              <section key={group.id} className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
                <div className="flex flex-col gap-3 border-b bg-muted/20 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate font-semibold tracking-tight">{group.name}</h3>
                      <Badge variant="outline">{group.members.length} workers</Badge>
                      {groupSelected > 0 && <Badge>{groupSelected} selected</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Worker-only group · {groupSelected > 0 ? `${formatAmount(groupPayTotal)} selected pay` : "No workers selected"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openGroupManager(group)}
                      data-testid={`button-manage-group-${group.id}`}
                    >
                      <Pencil className="mr-2 h-3.5 w-3.5" />
                      Manage
                    </Button>
                    <ConfirmationDialog
                      trigger={
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-destructive"
                          data-testid={`button-delete-group-${group.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      }
                      title="Delete Worker Group"
                      description={`Delete "${group.name}"? Workers will become ungrouped.`}
                      confirmText="Delete"
                      variant="destructive"
                      onConfirm={() => deleteWorkerGroupMutation.mutate(group.id)}
                    />
                  </div>
                </div>
                <WorkersTable
                  workers={group.members}
                  workerPayments={workerPayments}
                  workerGroups={workerGroupsOnly}
                  handleToggleWorker={handleToggleWorker}
                  handleUpdateAmount={handleUpdateAmount}
                  handleDeleteWorker={handleDeleteWorker}
                  setStatementEmployee={setStatementEmployee}
                  setWorkerOverrides={setWorkerOverrides}
                  formatAmount={formatAmount}
                  groupId={group.id}
                  setWorkerDeductionTarget={setWorkerDeductionTarget}
                  setSelectedWorkerForEdit={setSelectedWorkerForEdit}
                  setEditWorkerDialogOpen={setEditWorkerDialogOpen}
                />
              </section>
            );
          })}

          {filteredUngroupedWorkers.length > 0 && (
            <section className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
              <div className="border-b bg-muted/20 px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold tracking-tight">Ungrouped Workers</h3>
                  <Badge variant="outline">{filteredUngroupedWorkers.length} workers</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Workers that are not assigned to a worker group.</p>
              </div>
              <WorkersTable
                workers={filteredUngroupedWorkers}
                workerPayments={workerPayments}
                workerGroups={workerGroupsOnly}
                handleToggleWorker={handleToggleWorker}
                handleUpdateAmount={handleUpdateAmount}
                handleDeleteWorker={handleDeleteWorker}
                setStatementEmployee={setStatementEmployee}
                setWorkerOverrides={setWorkerOverrides}
                formatAmount={formatAmount}
                addWorkerToWorkerGroupMutation={addWorkerToWorkerGroupMutation}
                setWorkerDeductionTarget={setWorkerDeductionTarget}
                setSelectedWorkerForEdit={setSelectedWorkerForEdit}
                setEditWorkerDialogOpen={setEditWorkerDialogOpen}
              />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
