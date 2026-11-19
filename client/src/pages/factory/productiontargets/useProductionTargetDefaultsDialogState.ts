// Extracted from ./ProductionTargetDefaultsDialog.tsx
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useToast } from "@/hooks/use-toast";
import {
  translateFactoryStaffTrackingText,
  type FactoryStaffTrackingTranslationKey,
} from "@/i18n/factoryStaffTrackingTranslations";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import type { ProductionRow } from "../factoryProductionTargetsModel";

export interface ProductionTargetDefaultsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: ProductionRow[];
  effectiveFrom: string;
}

interface TargetDefaultsResponse {
  asOf: string;
  targets: Array<{ workerId: number; category: string | null; targetBales: number | null }>;
}

interface TargetDefaultDraft {
  category: string;
  targetBales: number | null;
}

export function useProductionTargetDefaultsDialogState({
  open,
  onOpenChange,
  rows,
  effectiveFrom,
}: Pick<ProductionTargetDefaultsDialogProps, "open" | "onOpenChange" | "rows" | "effectiveFrom">) {
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  const tr = (key: FactoryStaffTrackingTranslationKey) => translateFactoryStaffTrackingText(key, language);
  const [draftDefaults, setDraftDefaults] = useState<Record<number, TargetDefaultDraft>>({});
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery<TargetDefaultsResponse>({
    queryKey: ["/api/factory/staff-tracking/production-target-defaults", effectiveFrom],
    queryFn: async () => {
      const params = new URLSearchParams({ asOf: effectiveFrom });
      const response = await factoryApiRequest(
        "GET",
        `/api/factory/staff-tracking/production-target-defaults?${params.toString()}`
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || tr("loadFailed"));
      }
      return response.json();
    },
    enabled: open && Boolean(effectiveFrom),
  });

  const defaultsById = useMemo(() => new Map((data?.targets ?? []).map((entry) => [entry.workerId, entry])), [data]);

  useEffect(() => {
    if (!open || !data) return;
    setDraftDefaults(
      Object.fromEntries(
        rows.map((row) => {
          const savedDefault = defaultsById.get(row.personId);
          return [
            row.personId,
            {
              category: savedDefault?.category ?? row.defaultCategory ?? row.category ?? "",
              targetBales: savedDefault?.targetBales ?? row.defaultTargetBales ?? null,
            },
          ];
        })
      )
    );
    setSearch("");
  }, [open, data, defaultsById, rows]);

  const changedRecords = useMemo(
    () =>
      rows
        .filter((row) => {
          const draft = draftDefaults[row.personId];
          if (!draft) return false;
          const savedDefault = defaultsById.get(row.personId);
          const originalCategory = savedDefault?.category ?? row.defaultCategory ?? row.category ?? "";
          const originalTarget = savedDefault?.targetBales ?? row.defaultTargetBales ?? null;
          return draft.category.trim() !== originalCategory.trim() || draft.targetBales !== originalTarget;
        })
        .map((row) => ({
          workerId: row.personId,
          category: (draftDefaults[row.personId]?.category ?? "").trim(),
          targetBales: draftDefaults[row.personId]?.targetBales ?? null,
        })),
    [rows, draftDefaults, defaultsById]
  );

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return [...rows]
      .filter(
        (row) =>
          !needle ||
          row.name.toLocaleLowerCase().includes(needle) ||
          (row.code || "").toLocaleLowerCase().includes(needle) ||
          (draftDefaults[row.personId]?.category ?? row.defaultCategory ?? row.category)
            .toLocaleLowerCase()
            .includes(needle)
      )
      .sort((left, right) => {
        // Keep the list visually stable while category text is being edited.
        // The new category grouping takes effect after Save + refetch.
        const leftCategory = defaultsById.get(left.personId)?.category ?? left.defaultCategory ?? left.category;
        const rightCategory = defaultsById.get(right.personId)?.category ?? right.defaultCategory ?? right.category;
        const categoryCompare = leftCategory.localeCompare(rightCategory, undefined, {
          sensitivity: "base",
          numeric: true,
        });
        if (categoryCompare !== 0) return categoryCompare;
        return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
      });
  }, [rows, search, draftDefaults, defaultsById]);

  const updateTargetDefault = (row: ProductionRow, targetBales: number | null) => {
    // Linking workers combines the table, not their saved individual targets.
    setDraftDefaults((current) => ({
      ...current,
      [row.personId]: {
        category: current[row.personId]?.category ?? row.defaultCategory ?? row.category ?? "",
        targetBales,
      },
    }));
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const response = await factoryApiRequest("POST", "/api/factory/staff-tracking/production-target-defaults", {
        effectiveFrom,
        records: changedRecords,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || tr("saveDataFailed"));
      }
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["/api/factory/staff-tracking"],
        refetchType: "active",
      });
      void queryClient.invalidateQueries({
        queryKey: ["/api/factory/staff-tracking/production-target-defaults"],
        refetchType: "active",
      });
      toast({ title: tr("defaultTargetsSaved") });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast({ title: tr("saveFailed"), description: error.message, variant: "destructive" });
    },
  });
  return {
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
  };
}
