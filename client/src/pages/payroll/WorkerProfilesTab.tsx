import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, HardHat, Pencil, MinusCircle } from "lucide-react";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { ERPWorkerDetail } from "@/components/ERPWorkerDetail";
import type { Employee } from "@shared/schema";
import type { Employee as DetailEmployee } from "@/components/erpworkerdetail/types";
import type { WorkerGroup } from "./payrollTypes";
import { getEmpAvatarColor, getEmpInitials } from "./payrollSchemas";

interface AddWorkerToGroupMutation {
  mutate: (variables: { groupId: number; workerId: number }) => void;
}

interface WorkerProfilesTabProps {
  selectedWorkerProfileId: number | null;
  setSelectedWorkerProfileId: (val: number | null) => void;
  workerStaff: Employee[];
  workerGroups: WorkerGroup[];
  workerProfileGroupFilter: number | null;
  setWorkerProfileGroupFilter: (val: number | null) => void;
  workerProfileSearch: string;
  setWorkerProfileSearch: (val: string) => void;
  employeesLoading: boolean;
  setNewWorkerDialogOpen: (val: boolean) => void;
  addWorkerToWorkerGroupMutation: AddWorkerToGroupMutation;
  setWorkerDeductionTarget: (val: Employee | null) => void;
  setSelectedWorkerForEdit: (val: Employee | null) => void;
  setEditWorkerDialogOpen: (val: boolean) => void;
}

export function WorkerProfilesTab({
  selectedWorkerProfileId,
  setSelectedWorkerProfileId,
  workerStaff,
  workerGroups,
  workerProfileGroupFilter,
  setWorkerProfileGroupFilter,
  workerProfileSearch,
  setWorkerProfileSearch,
  employeesLoading,
  setNewWorkerDialogOpen,
  addWorkerToWorkerGroupMutation,
  setWorkerDeductionTarget,
  setSelectedWorkerForEdit,
  setEditWorkerDialogOpen,
}: WorkerProfilesTabProps) {
  const { formatAmount } = useCurrencyContext();

  const selectedWorkerProfile = selectedWorkerProfileId
    ? (workerStaff.find((w) => w.id === selectedWorkerProfileId) ?? null)
    : null;

  // Workers belonging to the selected group filter (-1 = ungrouped)
  const allGroupedWorkerIds = workerGroups.flatMap((g) => (g.members || []).map((m) => m.id));
  const workerIdsInSelectedGroup =
    workerProfileGroupFilter === -1
      ? workerStaff.filter((w) => !allGroupedWorkerIds.includes(w.id)).map((w) => w.id)
      : workerProfileGroupFilter !== null
        ? (workerGroups.find((g) => g.id === workerProfileGroupFilter)?.members || []).map((m) => m.id)
        : null;

  const filteredWorkers = workerStaff.filter((w) => {
    if (w.active === false) return false;
    if (workerIdsInSelectedGroup !== null && !workerIdsInSelectedGroup.includes(w.id)) return false;
    const q = workerProfileSearch.toLowerCase();
    if (!q) return true;
    return (
      `${w.firstName} ${w.lastName}`.toLowerCase().includes(q) ||
      (w.code || "").toLowerCase().includes(q) ||
      (w.department || "").toLowerCase().includes(q)
    );
  });

  // Group membership lookup: workerId → group name
  const workerGroupMap: Record<number, string> = {};
  workerGroups.forEach((g) =>
    (g.members || []).forEach((m) => {
      workerGroupMap[m.id] = g.name;
    })
  );

  if (selectedWorkerProfile) {
    return (
      <ERPWorkerDetail
        worker={{
          ...selectedWorkerProfile,
          email: selectedWorkerProfile.email ?? undefined,
          phone: selectedWorkerProfile.phone ?? undefined,
          department: selectedWorkerProfile.department ?? undefined,
          openingBalance: selectedWorkerProfile.openingBalance ?? undefined,
          currentBalance: selectedWorkerProfile.currentBalance ?? undefined,
          totalDeposits: selectedWorkerProfile.totalDeposits ?? undefined,
          totalWithdrawals: selectedWorkerProfile.totalWithdrawals ?? undefined,
        } satisfies DetailEmployee}
        onBack={() => setSelectedWorkerProfileId(null)}
        onEdit={(w) => {
          setSelectedWorkerForEdit(
            w as {
              id: number;
              companyId: number;
              code: string;
              phone: string | null;
              openingBalance: string | null;
              active: boolean;
              deletedAt: Date | null;
              createdAt: Date;
              email: string | null;
              firstName: string;
              lastName: string;
              joinDate: string;
              department: string | null;
              employeeType: string;
              monthlySalary: string;
              currentBalance: string;
              totalDeposits: string;
              totalWithdrawals: string;
              salesBonusPct: string | null;
              salesBonusPctSourceCompanyId: number | null;
              salesBonusPctLocationId: number | null;
              balesBonusRate: string | null;
            } | null
          );
          setEditWorkerDialogOpen(true);
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">Worker Profiles</h2>
          <p className="text-sm text-muted-foreground">
            Click a worker to view their profile, statement, advances, and documents
          </p>
        </div>
        <Button onClick={() => setNewWorkerDialogOpen(true)} data-testid="button-new-worker-profile">
          <Plus className="h-4 w-4 mr-2" /> New Worker
        </Button>
      </div>

      {/* Group filter tabs */}
      {workerGroups.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setWorkerProfileGroupFilter(null)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${workerProfileGroupFilter === null ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80"}`}
            data-testid="filter-group-all"
          >
            All Workers ({workerStaff.length})
          </button>
          {workerGroups.map((g) => {
            const count = workerStaff.filter((w) => (g.members || []).some((m: { id: number }) => m.id === w.id)).length;
            return (
              <button
                key={g.id}
                onClick={() => setWorkerProfileGroupFilter(g.id)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${workerProfileGroupFilter === g.id ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80"}`}
                data-testid={`filter-group-${g.id}`}
              >
                {g.name} ({count})
              </button>
            );
          })}
          {(() => {
            const ungroupedCount = workerStaff.filter(
              (w) => !workerGroups.some((g) => (g.members || []).some((m: { id: number }) => m.id === w.id))
            ).length;
            if (ungroupedCount === 0) return null;
            return (
              <button
                onClick={() => setWorkerProfileGroupFilter(-1)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${workerProfileGroupFilter === -1 ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80"}`}
                data-testid="filter-group-ungrouped"
              >
                Ungrouped ({ungroupedCount})
              </button>
            );
          })()}
        </div>
      )}

      {/* Search */}
      <Input
        placeholder="Search by name, code, or department..."
        value={workerProfileSearch}
        onChange={(e) => setWorkerProfileSearch(e.target.value)}
        data-testid="input-search-worker-profiles"
      />

      {/* Card grid */}
      {employeesLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : filteredWorkers.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <HardHat className="mx-auto h-8 w-8 mb-3 opacity-30" />
            <p className="text-sm">
              {workerStaff.length === 0
                ? "No workers found. Create workers using the New Worker button."
                : "No workers match your search or filter."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {filteredWorkers.map((worker) => {
            const initials = getEmpInitials(worker.firstName, worker.lastName);
            const avatarColor = getEmpAvatarColor(`${worker.firstName}${worker.lastName}`);
            const isActive = worker.active !== false;
            return (
              <Card
                key={worker.id}
                className="cursor-pointer hover-elevate"
                onClick={() => setSelectedWorkerProfileId(worker.id)}
                data-testid={`card-worker-profile-${worker.id}`}
              >
                <CardContent className="p-4 flex flex-col items-center text-center relative">
                  <div className="absolute top-3 right-3">
                    <Badge
                      variant={isActive ? "default" : "secondary"}
                      className="text-xs"
                      data-testid={`badge-worker-status-${worker.id}`}
                    >
                      {isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  <Avatar className="h-14 w-14 mt-1 mb-3">
                    <AvatarFallback className={`text-base font-semibold ${avatarColor}`}>{initials}</AvatarFallback>
                  </Avatar>
                  <p
                    className="font-semibold text-sm leading-tight uppercase"
                    data-testid={`text-worker-name-${worker.id}`}
                  >
                    {[worker.firstName, worker.lastName].filter(Boolean).join(" ")}
                  </p>
                  {workerGroupMap[worker.id] ? (
                    <Badge variant="secondary" className="mt-2 text-xs">
                      {workerGroupMap[worker.id]}
                    </Badge>
                  ) : workerGroups.length > 0 ? (
                    <div className="mt-2 w-full" onClick={(e) => e.stopPropagation()}>
                      <Select
                        onValueChange={(groupId) => {
                          addWorkerToWorkerGroupMutation.mutate({
                            groupId: parseInt(groupId),
                            workerId: worker.id,
                          });
                        }}
                      >
                        <SelectTrigger
                          className="h-7 text-xs w-full"
                          data-testid={`select-card-move-group-${worker.id}`}
                        >
                          <SelectValue placeholder="Add to group…" />
                        </SelectTrigger>
                        <SelectContent>
                          {workerGroups.map((g) => (
                            <SelectItem key={g.id} value={String(g.id)}>
                              {g.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                  <p className="font-mono text-sm font-medium mt-2" data-testid={`text-worker-salary-${worker.id}`}>
                    {formatAmount(parseFloat(worker.monthlySalary || "0"))}
                  </p>
                  <div className="mt-2 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        setWorkerDeductionTarget(worker);
                      }}
                      data-testid={`button-deduction-worker-${worker.id}`}
                      title="Add deduction"
                    >
                      <MinusCircle className="h-3.5 w-3.5 text-amber-500" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedWorkerForEdit(worker);
                        setEditWorkerDialogOpen(true);
                      }}
                      data-testid={`button-edit-profile-worker-${worker.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
