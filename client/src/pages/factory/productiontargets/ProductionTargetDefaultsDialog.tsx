import { CalendarClock, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProductionWorkerLinkControl } from "./ProductionWorkerLinkControl";
import { SearchField } from "@/components/ui/search-field";
import {
  useProductionTargetDefaultsDialogState,
  type ProductionTargetDefaultsDialogProps,
} from "./useProductionTargetDefaultsDialogState";

function targetValue(value: string): number | null {
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function ProductionTargetDefaultsDialog({
  open,
  onOpenChange,
  rows,
  effectiveFrom,
}: ProductionTargetDefaultsDialogProps) {
  const {
    tr,
    draftDefaults,
    setDraftDefaults,
    search,
    setSearch,
    isLoading,
    changedRecords,
    visibleRows,
    updateTargetDefault,
    saveMutation,
  } = useProductionTargetDefaultsDialogState({ open, onOpenChange, rows, effectiveFrom });

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !saveMutation.isPending && onOpenChange(nextOpen)}>
      <DialogContent
        className="flex h-[88vh] w-[calc(100vw-1rem)] max-w-[980px] flex-col gap-0 overflow-hidden p-0"
        data-testid="dialog-production-target-defaults"
      >
        <DialogHeader className="shrink-0 border-b px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3 pr-7">
            <div>
              <DialogTitle className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-primary" />
                {tr("defaultTargets")}
              </DialogTitle>
              <DialogDescription className="mt-1">{tr("defaultTargetsDescription")}</DialogDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">{effectiveFrom}</Badge>
              {changedRecords.length > 0 && (
                <Badge variant="secondary" data-testid="badge-production-default-changes">
                  {changedRecords.length} {tr("changes")}
                </Badge>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="shrink-0 border-b px-5 py-3">
          <SearchField
            value={search}
            onValueChange={setSearch}
            placeholder={tr("searchNameCodeCategory")}
            data-testid="input-production-default-search"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <Table wrapperClassName="overflow-visible rounded-none border-0">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead className="min-w-[230px]">{tr("person")}</TableHead>
                <TableHead className="min-w-[180px]">{tr("category")}</TableHead>
                <TableHead className="w-[170px] text-right">{tr("dailyDefaultTarget")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-12 text-center text-muted-foreground">
                    {tr("loadingStaff")}
                  </TableCell>
                </TableRow>
              ) : visibleRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-12 text-center text-muted-foreground">
                    {tr("noMatchingStaff")}
                  </TableCell>
                </TableRow>
              ) : (
                visibleRows.map((row) => (
                  <TableRow key={row.personId}>
                    <TableCell>
                      <div className="font-medium" dir="auto">
                        {row.name}
                      </div>
                      {row.linkGroupId != null && (row.linkedWorkers?.length ?? 0) > 1 && (
                        <div className="mt-1 text-xs text-muted-foreground" dir="auto">
                          {tr("linkedWith")}:{" "}
                          {(row.linkedWorkers ?? [])
                            .filter((member) => member.workerId !== row.personId)
                            .map((member) => member.workerName)
                            .join(", ")}
                        </div>
                      )}
                      <div className="mt-1.5">
                        <ProductionWorkerLinkControl
                          row={row}
                          rows={rows}
                          effectiveFrom={effectiveFrom}
                          disabled={isLoading || saveMutation.isPending || changedRecords.length > 0}
                        />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Input
                        value={draftDefaults[row.personId]?.category ?? row.defaultCategory ?? row.category}
                        disabled={isLoading || saveMutation.isPending}
                        onChange={(event) =>
                          setDraftDefaults((current) => ({
                            ...current,
                            [row.personId]: {
                              category: event.target.value,
                              targetBales:
                                current[row.personId]?.targetBales !== undefined
                                  ? current[row.personId].targetBales
                                  : (row.defaultTargetBales ?? null),
                            },
                          }))
                        }
                        placeholder={tr("categoryStation")}
                        data-testid={`input-production-default-category-${row.personId}`}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        value={draftDefaults[row.personId]?.targetBales ?? ""}
                        disabled={isLoading || saveMutation.isPending}
                        onChange={(event) => updateTargetDefault(row, targetValue(event.target.value))}
                        className="text-right tabular-nums"
                        data-testid={`input-production-default-target-${row.personId}`}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <DialogFooter className="shrink-0 border-t px-5 py-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saveMutation.isPending}
            data-testid="button-cancel-production-defaults"
          >
            {tr("cancel")}
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={isLoading || changedRecords.length === 0 || saveMutation.isPending}
            data-testid="button-save-production-defaults"
          >
            {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {saveMutation.isPending ? tr("saving") : tr("saveChanges")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
