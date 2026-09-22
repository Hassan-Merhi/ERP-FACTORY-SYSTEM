import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Search, SlidersHorizontal } from "lucide-react";
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
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useToast } from "@/hooks/use-toast";
import {
  translateFactoryStaffTrackingText,
  type FactoryStaffTrackingTranslationKey,
} from "@/i18n/factoryStaffTrackingTranslations";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import type { PeriodType, ProductionRow } from "../factoryProductionTargetsModel";

interface ProductionTargetsEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: ProductionRow[];
  periodType: PeriodType;
  periodStart: string;
  periodEnd: string;
  finalized: boolean;
}

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
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  const tr = (key: FactoryStaffTrackingTranslationKey) => translateFactoryStaffTrackingText(key, language);
  const [draftRows, setDraftRows] = useState<ProductionRow[]>([]);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("__all__");

  useEffect(() => {
    if (!open) return;
    setDraftRows(rows.map((row) => ({ ...row })));
    setSearch("");
    setCategoryFilter("__all__");
  }, [open, rows]);

  const originalById = useMemo(() => new Map(rows.map((row) => [row.personId, row])), [rows]);

  const changedCount = useMemo(
    () =>
      draftRows.filter((row) => {
        const original = originalById.get(row.personId);
        if (!original) return true;
        return (
          row.category.trim() !== original.category.trim() ||
          (row.targetBales ?? null) !== (original.targetBales ?? null)
        );
      }).length,
    [draftRows, originalById]
  );

  const categoryOptions = useMemo(
    () =>
      Array.from(new Set(draftRows.map((row) => row.category.trim()).filter(Boolean))).sort((left, right) =>
        left.localeCompare(right, undefined, { sensitivity: "base", numeric: true })
      ),
    [draftRows]
  );

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return draftRows
      .filter((row) => {
        const matchesSearch =
          !needle ||
          row.name.toLocaleLowerCase().includes(needle) ||
          (row.code || "").toLocaleLowerCase().includes(needle) ||
          row.category.toLocaleLowerCase().includes(needle);
        const matchesCategory = categoryFilter === "__all__" || row.category === categoryFilter;
        return matchesSearch && matchesCategory;
      })
      .sort((left, right) => {
        const categoryCompare = left.category.localeCompare(right.category, undefined, {
          sensitivity: "base",
          numeric: true,
        });
        if (categoryCompare !== 0) return categoryCompare;
        return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
      });
  }, [draftRows, search, categoryFilter]);

  const updateRow = (personId: number, patch: Partial<ProductionRow>) => {
    setDraftRows((current) => current.map((row) => (row.personId === personId ? { ...row, ...patch } : row)));
  };

  const categoryOverrideState = (row: ProductionRow) => {
    const original = originalById.get(row.personId);
    if (periodType !== "daily" || !original) return row.categoryOverridden === true;

    const categoryChanged = row.category.trim() !== original.category.trim();
    if (!categoryChanged) return original.categoryOverridden === true;

    // Returning to the repeating Daily Default removes the day-specific
    // category override so future default changes can flow through.
    return row.category.trim() !== (original.defaultCategory ?? "").trim();
  };

  const targetOverrideState = (row: ProductionRow) => {
    const original = originalById.get(row.personId);
    if (periodType !== "daily" || !original) return row.targetBalesOverridden === true;

    const targetChanged = (row.targetBales ?? null) !== (original.targetBales ?? null);
    if (!targetChanged) return original.targetBalesOverridden === true;

    // Setting the selected day's target back to the template removes the
    // day-specific override so later Daily Default changes can flow through.
    return (row.targetBales ?? null) !== (original.defaultTargetBales ?? null);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const response = await factoryApiRequest("POST", "/api/factory/staff-tracking/bulk", {
        page: "production",
        periodType,
        periodStart,
        periodEnd,
        finalize: false,
        records: draftRows.map((row) => ({
          personType: row.personType,
          personId: row.personId,
          groupName: row.groupName || "",
          category: row.category.trim(),
          categoryOverridden: categoryOverrideState(row),
          targetBales: row.targetBales,
          targetBalesOverridden: targetOverrideState(row),
          producedBales: null,
          status: row.status,
          notes: "",
        })),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || tr("saveDataFailed"));
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.setQueryData(
        ["/api/factory/staff-tracking", "production", periodType, periodStart, periodEnd],
        (current: unknown) =>
          current && typeof current === "object"
            ? {
                ...(current as Record<string, unknown>),
                rows: draftRows.map((row) => ({
                  ...row,
                  category: row.category.trim(),
                  categoryOverridden: categoryOverrideState(row),
                  targetBalesOverridden: targetOverrideState(row),
                })),
              }
            : current
      );
      void queryClient.invalidateQueries({
        queryKey: ["/api/factory/staff-tracking"],
        refetchType: "active",
      });
      toast({ title: tr("productionSaved") });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast({ title: tr("saveFailed"), description: error.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !saveMutation.isPending && onOpenChange(nextOpen)}>
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
              <DialogDescription className="mt-1">
                {tr("productionEditorDescription")}
              </DialogDescription>
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
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={tr("searchNameCodeCategory")}
              className="pl-9"
              data-testid="input-production-editor-search"
            />
          </div>
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
                <TableHead className="min-w-[230px]">{tr("person")}</TableHead>
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
                visibleRows.map((row) => (
                  <TableRow key={row.personId} className={!row.active ? "opacity-60" : undefined}>
                    <TableCell>
                      <div className="font-medium" dir="auto">
                        {row.name}
                      </div>
                      {!row.active && (
                        <Badge variant="outline" className="mt-1 h-5 px-1.5 text-[10px]">
                          {tr("inactive")}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Input
                        value={row.category}
                        disabled={finalized || saveMutation.isPending}
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
                        disabled={finalized || saveMutation.isPending}
                        onChange={(event) =>
                          updateRow(row.personId, { targetBales: targetValue(event.target.value) })
                        }
                        className="text-right tabular-nums"
                        data-testid={`input-production-target-${row.personId}`}
                      />
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {row.producedBales ?? 0}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{tr(row.status === "Absent" ? "absent" : row.status === "New" ? "new" : "present")}</Badge>
                    </TableCell>
                  </TableRow>
                ))
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
            disabled={saveMutation.isPending}
            data-testid="button-cancel-production-editor"
          >
            {tr("cancel")}
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={finalized || changedCount === 0 || saveMutation.isPending || draftRows.length === 0}
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
