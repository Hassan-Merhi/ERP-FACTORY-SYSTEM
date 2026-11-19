import { SearchField } from "@/components/ui/search-field";
import { TabsList, PillTabButton } from "@/components/ui/tabs";
import { Banknote, CheckCircle2, ClipboardList, History, PlayCircle, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useCompactRunPayrollSelectionState,
  type CompactRunPayrollSelectionProps,
} from "./useCompactRunPayrollSelectionState";

export function CompactRunPayrollSelection({ model }: CompactRunPayrollSelectionProps) {
  const {
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
  } = useCompactRunPayrollSelectionState({ model });

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
      <TabsList className="w-max max-w-full" aria-label="Payroll sections">
        <PillTabButton selected data-testid="tab-run-payroll">
          <PlayCircle className="mr-2 h-4 w-4" />
          Run Payroll
        </PillTabButton>
        <PillTabButton
          selected={false}
          onClick={() => {
            setActiveTab("history");
            setStep(1);
          }}
          data-testid="tab-payroll-history"
        >
          <History className="mr-2 h-4 w-4" />
          Payroll History
          {draftCount > 0 && (
            <Badge variant="outline" className="ml-2 text-[11px] no-default-active-elevate">
              {draftCount} draft
            </Badge>
          )}
        </PillTabButton>
      </TabsList>

      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <div className="border-b p-3 sm:p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <SearchField
              value={searchQuery}
              onValueChange={setSearchQuery}
              placeholder="Search by name, code, department..."
              wrapperClassName="flex-1 xl:max-w-2xl"
              className="bg-background"
              data-testid="input-search-workers"
            />

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
