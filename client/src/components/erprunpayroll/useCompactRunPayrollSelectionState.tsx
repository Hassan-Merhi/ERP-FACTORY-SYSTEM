// Extracted from ./CompactRunPayrollSelection.tsx
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { useERPRunPayrollModel } from "./useERPRunPayrollModel";

type PayrollModel = ReturnType<typeof useERPRunPayrollModel>;

type GroupKey = number | "ungrouped";

export interface CompactRunPayrollSelectionProps {
  model: PayrollModel;
}

export function useCompactRunPayrollSelectionState({ model }: Pick<CompactRunPayrollSelectionProps, "model">) {
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
  const visibleWorkerCount = useMemo(
    () => workers.filter((worker) => filtered.has(worker.id)).length,
    [workers, filtered]
  );

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
    const groupBase = visibleIds.reduce((sum, id) => sum + parseFloat(workerById[id]?.monthlySalary || "0"), 0);

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
                      className={`cursor-pointer ${selected ? "bg-primary/6 hover:bg-primary/8" : "hover:bg-muted/25"}`}
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
                          className="text-[11px] no-default-active-elevate"
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
  return {
    isLoading,
    setActiveTab,
    setStep,
    searchQuery,
    setSearchQuery,
    previewDate,
    setPreviewDate,
    enterPreview,
    selectedWorkers,
    formatAmount,
    totalSelectedBase,
    workerGroups,
    ungroupedWorkers,
    filtered,
    draftCount,
    visibleWorkerCount,
    renderGroup,
  };
}
