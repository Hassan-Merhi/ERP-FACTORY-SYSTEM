import { Loader2, SlidersHorizontal } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProductionWorkerLinkControl } from "./ProductionWorkerLinkControl";
import { SearchField } from "@/components/ui/search-field";
import {
  useProductionTargetsEditorDialogState,
  type ProductionTargetsEditorDialogProps,
} from "./useProductionTargetsEditorDialogState";

function targetValue(value: string): number | null {
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function ProductionTargetsEditorDialog({
  open,
  onOpenChange,
  rows,
  periodType,
  periodStart,
  periodEnd,
  finalized,
}: ProductionTargetsEditorDialogProps) {
  const {
    tr,
    draftRows,
    search,
    setSearch,
    categoryFilter,
    setCategoryFilter,
    changedCount,
    categoryOptions,
    visibleRows,
    updateRow,
    saveMutation,
    busy,
    canManageLinks,
  } = useProductionTargetsEditorDialogState({
    open,
    onOpenChange,
    rows,
    periodType,
    periodStart,
    periodEnd,
    finalized,
  });

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      <DialogContent
        className="flex h-[88vh] w-[calc(100vw-1rem)] max-w-[1180px] flex-col gap-0 overflow-hidden p-0"
        data-testid="dialog-production-targets-editor"
      >
        <DialogHeader className="shrink-0 border-b px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3 pr-7">
            <div>
              <DialogTitle className="flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-primary" />
                {tr("editTargets")}
              </DialogTitle>
              <DialogDescription className="mt-1">{tr("productionEditorDescription")}</DialogDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">
                {periodStart === periodEnd ? periodStart : `${periodStart} — ${periodEnd}`}
              </Badge>
              {changedCount > 0 && (
                <Badge variant="secondary" data-testid="badge-production-editor-changes">
                  {changedCount} {tr("changes")}
                </Badge>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-5 py-3">
          <SearchField
            value={search}
            onValueChange={setSearch}
            placeholder={tr("searchNameCodeCategory")}
            wrapperClassName="min-w-[220px] flex-1"
            data-testid="input-production-editor-search"
          />
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-[190px]" data-testid="select-production-editor-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{tr("allCategories")}</SelectItem>
              {categoryOptions.map((category) => (
                <SelectItem key={category} value={category}>
                  {category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <datalist id="production-editor-category-options">
          {categoryOptions.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>

        <div className="min-h-0 flex-1 overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead className="min-w-[300px]">{tr("person")}</TableHead>
                <TableHead className="min-w-[220px]">{tr("category")}</TableHead>
                <TableHead className="w-[130px] text-right">{tr("target")}</TableHead>
                <TableHead className="w-[120px] text-right">{tr("produced")}</TableHead>
                <TableHead className="w-[130px]">{tr("status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-12 text-center text-muted-foreground">
                    {tr("noMatchingStaff")}
                  </TableCell>
                </TableRow>
              ) : (
                visibleRows.map((row) => {
                  const linkedPartners = (row.linkedWorkers ?? []).filter((member) => member.workerId !== row.personId);
                  return (
                    <TableRow key={row.personId} className={!row.active ? "opacity-60" : undefined}>
                      <TableCell>
                        <div className="font-medium" dir="auto">
                          {row.name}
                        </div>
                        {!row.active && (
                          <Badge variant="outline" className="mt-1 h-5 px-1.5 text-[11px]">
                            {tr("inactive")}
                          </Badge>
                        )}

                        {row.linkGroupId != null && linkedPartners.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <Badge variant="secondary" className="gap-1 text-[11px] font-normal">
                              <span dir="auto">
                                {tr("linkedWith")}: {linkedPartners.map((member) => member.workerName).join(", ")}
                              </span>
                            </Badge>
                          </div>
                        )}
                        {periodType === "daily" && (
                          <div className="mt-1.5">
                            <ProductionWorkerLinkControl
                              row={row}
                              rows={draftRows}
                              effectiveFrom={periodStart}
                              disabled={!canManageLinks || busy}
                            />
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Input
                          value={row.category}
                          disabled={finalized || busy}
                          onChange={(event) => updateRow(row.personId, { category: event.target.value })}
                          placeholder={tr("categoryStation")}
                          list="production-editor-category-options"
                          data-testid={`input-production-category-${row.personId}`}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min="0"
                          step="1"
                          value={row.targetBales ?? ""}
                          disabled={finalized || busy}
                          onChange={(event) =>
                            updateRow(row.personId, { targetBales: targetValue(event.target.value) })
                          }
                          className="text-right tabular-nums"
                          data-testid={`input-production-target-${row.personId}`}
                        />
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{row.producedBales ?? 0}</TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {tr(row.status === "Absent" ? "absent" : row.status === "New" ? "new" : "present")}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        <DialogFooter className="shrink-0 border-t px-5 py-4 sm:justify-between">
          <div className="mr-auto text-xs text-muted-foreground">
            {finalized ? tr("productionLockedDetail") : tr("editorChangesSaveTogether")}
          </div>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            data-testid="button-cancel-production-editor"
          >
            {tr("cancel")}
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={finalized || changedCount === 0 || busy || draftRows.length === 0}
            data-testid="button-save-production-editor"
          >
            {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {saveMutation.isPending ? tr("saving") : tr("saveChanges")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
