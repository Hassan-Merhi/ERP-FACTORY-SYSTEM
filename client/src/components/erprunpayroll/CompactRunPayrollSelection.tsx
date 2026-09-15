import { useMemo, useState } from "react";
import {
  Banknote,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  History,
  PlayCircle,
  Search,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { useERPRunPayrollModel } from "./useERPRunPayrollModel";

type PayrollModel = ReturnType<typeof useERPRunPayrollModel>;
type GroupKey = number | "ungrouped";

interface CompactRunPayrollSelectionProps {
  model: PayrollModel;
}

export function CompactRunPayrollSelection({ model }: CompactRunPayrollSelectionProps) {
  const {
    searchQuery,
    setSearchQuery,
    selectedWorkers,
    previewDate,
    setPreviewDate,
    payrollRuns,
    workers,
    workerGroups,
    ungroupedWorkers,
    advanceBalanceByEmployee,
    filtered,
    workerById,
    toggleWorker,
    toggleGroupSelection,
    enterPreview,
    isLoading,
    totalSelectedBase,
    formatAmount,
    setActiveTab,
    setStep,
  } = model;

  // Intentionally start every group collapsed. The old page defaulted all
  // groups open, which made large payrolls render as a wall of worker cards.
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const draftCount = useMemo(() => payrollRuns.filter((run) => run.status === "DRAFT").length, [payrollRuns]);
  const visibleWorkerCount = useMemo(() => workers.filter((worker) => filtered.has(worker.id)).length, [workers, filtered]);

  const toggleExpanded = (key: GroupKey) => {
    const normalized = String(key);
    setExpandedGroups((previous) => ({ ...previous, [normalized]: !previous[normalized] }));
  };

  const renderGroup = (label: string, memberIds: number[], groupKey: GroupKey) => {
    const visibleIds = memberIds.filter((id) => filtered.has(id) && workerById[id]);
    if (visibleIds.length === 0) return null;

    const expanded = expandedGroups[String(groupKey)] === true;
    const selectedVisible = visibleIds.filter((id) => selectedWorkers.has(id));
    const allVisibleSelected = visibleIds.every((id) => selectedWorkers.has(id));
    const groupBase = visibleIds.reduce(
      (sum, id) => sum + parseFloat(workerById[id]?.monthlySalary || "0"),
      0
    );

    return (
      <section key={groupKey} className="overflow-hidden border-b last:border-b-0">
        <div className="flex min-h-14 items-center gap-3 bg-muted/20 px-3 sm:px-4">
          <button
            type="button"
            onClick={() => toggleExpanded(groupKey)}
            className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left transition-colors hover:text-primary"
            data-testid={`group-toggle-${groupKey}`}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">{label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {visibleIds.length} workers · {selectedVisible.length} selected
              </span>
            </span>
          </button>

          <div className="hidden items-center gap-6 text-right md:flex">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Salary</p>
              <p className="text-sm font-semibold tabular-nums">{formatAmount(groupBase)}</p>
            </div>
            <div className="w-24">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Selected</p>
              <p className="text-sm font-semibold tabular-nums">{selectedVisible.length}</p>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0"
            onClick={() => toggleGroupSelection(visibleIds)}
            data-testid={`group-select-all-${groupKey}`}
          >
            {allVisibleSelected ? "Deselect all" : "Select all"}
          </Button>
        </div>

        {expanded && (
          <div className="overflow-x-auto bg-background">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10 hover:bg-muted/10">
                  <TableHead className="w-12"></TableHead>
                  <TableHead className="min-w-[220px]">Worker</TableHead>
                  <TableHead className="min-w-[150px]">Department</TableHead>
                  <TableHead className="w-32 text-right">Salary</TableHead>
                  <TableHead className="w-36 text-right">Advance</TableHead>
                  <TableHead className="w-28 text-center">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleIds.map((id) => {
                  const worker = workerById[id];
                  const fullName = [worker.firstName, worker.lastName].filter(Boolean).join(" ");
                  const salary = parseFloat(worker.monthlySalary || "0");
                  const advanceBalance = advanceBalanceByEmployee[id] || 0;
                  const selected = selectedWorkers.has(id);

                  return (
                    <TableRow
                      key={id}
                      onClick={() => toggleWorker(id)}
                      className={`cursor-pointer ${selected ? "bg-primary/[0.06] hover:bg-primary/[0.08]" : "hover:bg-muted/25"}`}
                      data-testid={`row-worker-${id}`}
                    >
                      <TableCell onClick={(event) => event.stopPropagation()}>
                        <Checkbox
                          checked={selected}
                          onCheckedChange={() => toggleWorker(id)}
                          aria-label={`Select ${fullName}`}
                          data-testid={`checkbox-worker-${id}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{fullName}</p>
                          {worker.code && <p className="mt-0.5 text-xs text-muted-foreground">{worker.code}</p>}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{worker.department || "—"}</TableCell>
                      <TableCell className="text-right text-sm font-medium tabular-nums">
                        {formatAmount(salary)}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {advanceBalance > 0 ? (
                          <span className="font-medium text-amber-600 dark:text-amber-400">
                            -{formatAmount(advanceBalance)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge
                          variant={worker.active ? "outline" : "secondary"}
                          className="text-[10px] no-default-active-elevate"
                        >
                          {worker.active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-3 pt-3">
        <Skeleton className="h-10 w-72 max-w-full" />
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  const hasResults = visibleWorkerCount > 0;

  return (
    <div className="space-y-4 pt-3">
      <div className="inline-flex rounded-xl border bg-muted/30 p-1">
        <Button type="button" size="sm" variant="secondary" className="h-8 rounded-lg" data-testid="tab-run-payroll">
          <PlayCircle className="mr-2 h-4 w-4" />
          Run Payroll
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 rounded-lg text-muted-foreground"
          onClick={() => {
            setActiveTab("history");
            setStep(1);
          }}
          data-testid="tab-payroll-history"
        >
          <History className="mr-2 h-4 w-4" />
          Payroll History
          {draftCount > 0 && (
            <Badge variant="outline" className="ml-2 text-[10px] no-default-active-elevate">
              {draftCount} draft
            </Badge>
          )}
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="border-b p-3 sm:p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="relative min-w-0 flex-1 xl:max-w-2xl">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by name, code, department..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="h-10 bg-background pl-9"
                data-testid="input-search-workers"
              />
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Payroll Date</Label>
                <Input
                  type="date"
                  value={previewDate}
                  onChange={(event) => setPreviewDate(event.target.value)}
                  className="h-10 w-40 bg-background"
                  data-testid="input-payroll-date"
                />
              </div>
              <Button
                className="h-10"
                onClick={enterPreview}
                disabled={selectedWorkers.size === 0}
                data-testid="button-preview-payroll"
              >
                <ClipboardList className="mr-2 h-4 w-4" />
                Preview Payroll ({selectedWorkers.size})
              </Button>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 border-t pt-3 sm:flex sm:items-center sm:gap-6">
            <div className="flex items-center gap-2 text-sm">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Workers</span>
              <span className="font-semibold tabular-nums">{visibleWorkerCount}</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Selected</span>
              <span className="font-semibold tabular-nums">{selectedWorkers.size}</span>
            </div>
            <div className="col-span-2 flex items-center gap-2 text-sm sm:ml-auto">
              <Banknote className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Total</span>
              <span className="font-semibold tabular-nums">{formatAmount(totalSelectedBase)}</span>
            </div>
          </div>
        </div>

        {!hasResults ? (
          <div className="px-6 py-16 text-center text-muted-foreground">
            <Users className="mx-auto mb-3 h-9 w-9 opacity-40" />
            <p className="font-medium">{searchQuery ? "No workers match your search" : "No active workers found"}</p>
          </div>
        ) : (
          <div>
            {workerGroups.map((group) =>
              renderGroup(
                group.name,
                (group.members || []).map((member) => member.id),
                group.id
              )
            )}
            {ungroupedWorkers.some((worker) => filtered.has(worker.id)) &&
              renderGroup(
                "Ungrouped",
                ungroupedWorkers.map((worker) => worker.id),
                "ungrouped"
              )}
          </div>
        )}
      </div>
    </div>
  );
}
