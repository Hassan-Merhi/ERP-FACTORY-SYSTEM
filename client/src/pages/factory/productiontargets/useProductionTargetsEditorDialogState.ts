// Extracted from ./ProductionTargetsEditorDialog.tsx
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useToast } from "@/hooks/use-toast";
import {
  translateFactoryStaffTrackingText,
  type FactoryStaffTrackingTranslationKey,
} from "@/i18n/factoryStaffTrackingTranslations";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import type { PeriodType, ProductionRow } from "../factoryProductionTargetsModel";

export interface ProductionTargetsEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: ProductionRow[];
  periodType: PeriodType;
  periodStart: string;
  periodEnd: string;
  finalized: boolean;
}

export function useProductionTargetsEditorDialogState({
  open,
  onOpenChange,
  rows,
  periodType,
  periodStart,
  periodEnd,
  finalized,
}: Pick<
  ProductionTargetsEditorDialogProps,
  "open" | "onOpenChange" | "rows" | "periodType" | "periodStart" | "periodEnd" | "finalized"
>) {
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
      Array.from(new Set(rows.map((row) => row.category.trim()).filter(Boolean))).sort((left, right) =>
        left.localeCompare(right, undefined, { sensitivity: "base", numeric: true })
      ),
    [rows]
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
        const savedCategory = originalById.get(row.personId)?.category ?? row.category;
        const matchesCategory = categoryFilter === "__all__" || savedCategory === categoryFilter;
        return matchesSearch && matchesCategory;
      })
      .sort((left, right) => {
        // Do not move workers between category groups while the user is typing.
        // Re-group only after the edit is saved and the server rows are refreshed.
        const leftCategory = originalById.get(left.personId)?.category ?? left.category;
        const rightCategory = originalById.get(right.personId)?.category ?? right.category;
        const categoryCompare = leftCategory.localeCompare(rightCategory, undefined, {
          sensitivity: "base",
          numeric: true,
        });
        if (categoryCompare !== 0) return categoryCompare;
        return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
      });
  }, [draftRows, search, categoryFilter, originalById]);

  const updateRow = (personId: number, patch: Partial<ProductionRow>) => {
    // Linked tablemates can have different daily targets.
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

  const busy = saveMutation.isPending;
  const canManageLinks = periodType === "daily" && !finalized && changedCount === 0;
  return {
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
  };
}
