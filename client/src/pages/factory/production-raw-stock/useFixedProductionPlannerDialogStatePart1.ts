// Extracted from ./useFixedProductionPlannerDialogState.ts
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useToast } from "@/hooks/use-toast";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import {
  type FixedProductionPlannerTranslationKey,
  translateFixedPlannerApiMessage,
  translateFixedProductionPlanner,
} from "@/i18n/fixedProductionPlannerTranslations";
import { queryClient } from "@/lib/queryClient";
import type { RawStockRow } from "./RawStockTable";
import type { OffloadSupplierOption } from "./offloadDialogTypes";
import {
  calculateFixedProductionCategoryRows,
  type FixedPlanCategory,
  visibleFixedProductionRows,
} from "./fixedProductionPlannerCalculations";
import {
  CATEGORIES_KEY,
  CATEGORIES_SNAPSHOT_KEY,
  OTW_KEY,
  OTW_SNAPSHOT_KEY,
  PLAN_KEY,
  PLAN_SNAPSHOT_KEY,
  apiRequest,
  type FixedProductionPlannerDialogProps,
  type OtwContainer,
  type PlannerRecord,
} from "./FixedProductionPlannerDialogTypes";

export function useFixedProductionPlannerDialogStatePart1({
  open,
  rawStock,
  rawStockLoading,
  rawStockError,
  suppliers,
  suppliersLoading,
  suppliersError,
}: Pick<
  FixedProductionPlannerDialogProps,
  "open" | "rawStock" | "rawStockLoading" | "rawStockError" | "suppliers" | "suppliersLoading" | "suppliersError"
>) {
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  // Read-only roles can view, refresh and download the plan but never save, unlock or send it.
  const recordChanges = useExistingRecordChangeAccess();
  const tr = (key: FixedProductionPlannerTranslationKey, params?: Record<string, string | number>) =>
    translateFixedProductionPlanner(key, language, params);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [hasEdits, setHasEdits] = useState(false);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);
  // Freeze displayed stock while the popup is open; only Refresh replaces it.
  const [stockSnapshot, setStockSnapshot] = useState<RawStockRow[] | null>(null);
  const [supplierSnapshot, setSupplierSnapshot] = useState<OffloadSupplierOption[] | null>(null);

  const planQuery = useQuery<PlannerRecord>({
    queryKey: [...PLAN_SNAPSHOT_KEY],
    // Do not automatically fetch or react to cache invalidation. Fetch on
    // opening the dialog or when the user explicitly presses Refresh.
    enabled: false,
    queryFn: async () => {
      const res = await apiRequest("GET", PLAN_KEY[0]);
      return res.json();
    },
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    staleTime: "static",
    refetchInterval: false,
  });
  const otwQuery = useQuery<OtwContainer[]>({
    queryKey: [...OTW_SNAPSHOT_KEY],
    enabled: false,
    queryFn: async () => {
      const res = await apiRequest("GET", OTW_KEY[0]);
      return res.json();
    },
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    staleTime: "static",
    refetchInterval: false,
  });
  const categoryQuery = useQuery<FixedPlanCategory[]>({
    queryKey: [...CATEGORIES_SNAPSHOT_KEY],
    enabled: false,
    queryFn: async () => {
      const res = await apiRequest("GET", CATEGORIES_KEY[0]);
      return res.json();
    },
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    staleTime: "static",
    refetchInterval: false,
  });

  const { refetch: refetchPlan } = planQuery;
  const { refetch: refetchOtw } = otwQuery;
  const { refetch: refetchCategories } = categoryQuery;

  // Each opening starts a single fresh snapshot. Disabled React Query observers
  // never refetch due to Factory-wide invalidation, polling, or reconnect.
  useEffect(() => {
    if (!open) return;
    void Promise.all([refetchPlan(), refetchOtw(), refetchCategories()]);
  }, [open, refetchPlan, refetchOtw, refetchCategories]);

  useEffect(() => {
    if (!open || stockSnapshot !== null) return;
    // The parent Raw Materials page can already be background-refetching when
    // this popup opens. Use its last complete cache value instead of waiting
    // for that unrelated refresh to finish (or capturing a placeholder []).
    const cachedStock = queryClient.getQueryData<RawStockRow[]>(["/api/factory/raw-stock"]);
    const cachedSuppliers = queryClient.getQueryData<OffloadSupplierOption[]>(["/api/factory/suppliers"]);
    if ((rawStockLoading || rawStockError) && !cachedStock) return;
    if ((suppliersLoading || suppliersError) && !cachedSuppliers) return;
    setStockSnapshot(cachedStock ?? rawStock);
    setSupplierSnapshot(cachedSuppliers ?? suppliers);
  }, [open, rawStock, suppliers, rawStockLoading, suppliersLoading, rawStockError, suppliersError, stockSnapshot]);

  const planCategories = useMemo(() => categoryQuery.data ?? [], [categoryQuery.data]);
  const currentStock = useMemo(() => stockSnapshot ?? [], [stockSnapshot]);
  const currentSuppliers = useMemo(() => supplierSnapshot ?? [], [supplierSnapshot]);
  const initialRows = useMemo(
    () =>
      calculateFixedProductionCategoryRows(
        planCategories,
        currentSuppliers,
        currentStock,
        otwQuery.data ?? [],
        planQuery.data?.allocations20t ?? {}
      ),
    [planCategories, currentSuppliers, currentStock, otwQuery.data, planQuery.data?.allocations20t]
  );

  useEffect(() => {
    if (!open || !planQuery.data || !categoryQuery.data || !stockSnapshot || hasEdits) return;
    setInputs(Object.fromEntries(initialRows.map((row) => [row.id, String(row.allocation20)])));
  }, [open, planQuery.data, categoryQuery.data, stockSnapshot, initialRows, hasEdits]);

  // Discard unsaved changes when closing: reopening loads the last saved plan.
  useEffect(() => {
    if (!open) {
      setHasEdits(false);
      setStockSnapshot(null);
      setSupplierSnapshot(null);
    }
  }, [open]);

  const saveMutation = useMutation({
    mutationFn: async (allocations20t: Record<string, number>) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", PLAN_KEY[0] + "/save", {
        allocations20t,
        expectedRevision: planQuery.data?.revision ?? 0,
      });
      return res.json() as Promise<PlannerRecord>;
    },
    onSuccess: async (savedPlan: PlannerRecord) => {
      // Saving is a deliberate user action; update this frozen snapshot directly.
      // Invalidate only the live plan so the parent report stays synchronized.
      setHasEdits(false);
      queryClient.setQueryData([...PLAN_SNAPSHOT_KEY], savedPlan);
      await queryClient.invalidateQueries({ queryKey: [...PLAN_KEY], exact: true });
      toast({ title: tr("savedTitle"), description: tr("savedInfo") });
    },
    onError: (err: Error) =>
      toast({
        title: tr("saveError"),
        description: translateFixedPlannerApiMessage(err.message, language),
        variant: "destructive",
      }),
  });

  const unlockMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", PLAN_KEY[0] + "/unlock", {
        expectedRevision: planQuery.data?.revision,
      });
      return res.json() as Promise<PlannerRecord>;
    },
    onSuccess: async (unlockedPlan: PlannerRecord) => {
      setHasEdits(false);
      queryClient.setQueryData([...PLAN_SNAPSHOT_KEY], unlockedPlan);
      await queryClient.invalidateQueries({ queryKey: [...PLAN_KEY], exact: true });
      toast({ title: tr("unlockedTitle"), description: tr("unlockedInfo") });
    },
    onError: (err: Error) =>
      toast({
        title: tr("unlockError"),
        description: translateFixedPlannerApiMessage(err.message, language),
        variant: "destructive",
      }),
  });

  const rows = useMemo(
    () =>
      visibleFixedProductionRows(
        calculateFixedProductionCategoryRows(
          planCategories,
          currentSuppliers,
          currentStock,
          otwQuery.data ?? [],
          inputs
        )
      ),
    [planCategories, currentSuppliers, currentStock, otwQuery.data, inputs]
  );
  return {
    toast,
    language,
    recordChanges,
    tr,
    inputs,
    setInputs,
    hasEdits,
    setHasEdits,
    isManualRefreshing,
    setIsManualRefreshing,
    reportRef,
    stockSnapshot,
    setStockSnapshot,
    supplierSnapshot,
    setSupplierSnapshot,
    planQuery,
    otwQuery,
    categoryQuery,
    planCategories,
    currentStock,
    currentSuppliers,
    saveMutation,
    unlockMutation,
    rows,
  };
}
