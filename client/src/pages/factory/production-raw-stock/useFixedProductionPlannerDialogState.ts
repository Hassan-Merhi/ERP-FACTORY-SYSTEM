// Extracted from ./FixedProductionPlannerDialog.tsx to keep that module under the source-size cap.
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
  sumFixedProductionRows,
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

export function useFixedProductionPlannerDialogState({
  open,
  onOpenChange,
  rawStock,
  rawStockLoading,
  rawStockError,
  suppliers,
  suppliersLoading,
  suppliersError,
}: FixedProductionPlannerDialogProps) {
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
  const totals = useMemo(() => sumFixedProductionRows(rows), [rows]);

  // WhatsApp images always use saved allocations, never unsaved edits.
  const reportRows = useMemo(
    () =>
      visibleFixedProductionRows(
        calculateFixedProductionCategoryRows(
          planCategories,
          currentSuppliers,
          currentStock,
          otwQuery.data ?? [],
          planQuery.data?.allocations20t ?? {}
        )
      ),
    [planCategories, currentSuppliers, currentStock, otwQuery.data, planQuery.data?.allocations20t]
  );
  const reportTotals = useMemo(() => sumFixedProductionRows(reportRows), [reportRows]);

  const reportDate = (() => {
    const now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
  })();
  const reportDateLabel = reportDate.split("-").reverse().join("/");

  const captureImage = async (): Promise<string> => {
    if (!reportRef.current) throw new Error(tr("imageNotReady"));
    const html2canvas = (await import("html2canvas")).default;
    const canvas = await html2canvas(reportRef.current, {
      backgroundColor: "#ffffff",
      scale: 2,
      logging: false,
      useCORS: true,
    });
    return canvas.toDataURL("image/png");
  };

  const whatsappMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const imageBase64 = await captureImage();
      const res = await apiRequest("POST", "/api/factory/send-mix-batch-image-whatsapp", {
        imageBase64,
        date: reportDate,
        fileName: `FixedProductionPlan_${reportDate}.png`,
        caption: tr("reportCaption", { date: reportDateLabel }),
        reportLabel: tr("title"),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || tr("sendErrorInfo"));
      }
      return res.json();
    },
    onSuccess: () => toast({ title: tr("sendSuccess") }),
    onError: (error: Error) =>
      toast({
        title: tr("sendError"),
        description: translateFixedPlannerApiMessage(error.message, language),
        variant: "destructive",
      }),
  });

  const downloadImage = async () => {
    try {
      const imageBase64 = await captureImage();
      const link = document.createElement("a");
      link.href = imageBase64;
      link.download = `FixedProductionPlan_${reportDate}.png`;
      link.click();
    } catch (error) {
      toast({
        title: tr("downloadError"),
        description: error instanceof Error ? error.message : tr("unknownError"),
        variant: "destructive",
      });
    }
  };

  // Ignore background query errors after the original values have been
  // captured. Only the explicit Refresh button may replace these snapshots.
  const snapshotError = (stockSnapshot === null && rawStockError) || (supplierSnapshot === null && suppliersError);
  const locked = planQuery.data?.locked ?? false;
  const ready =
    !!planQuery.data &&
    !!otwQuery.data &&
    !!categoryQuery.data &&
    stockSnapshot !== null &&
    supplierSnapshot !== null &&
    !planQuery.isFetching &&
    !otwQuery.isFetching &&
    !categoryQuery.isFetching &&
    !snapshotError;
  const pending = saveMutation.isPending || unlockMutation.isPending || whatsappMutation.isPending;

  const saveAndLock = () => {
    if (locked || pending || !ready) return;
    // Keep saved allocations for currently hidden zero-balance suppliers.
    // When their stock returns the saved setting reappears; don't send IDs
    // belonging to removed suppliers to the backend.
    const supplierIds = new Set(currentSuppliers.map((supplier) => String(supplier.id)));
    const categoryIds = new Set(planCategories.map((category) => `cat:${category.id}`));
    categoryIds.add("cat:uncategorized");
    const allocations: Record<string, number> = Object.fromEntries(
      Object.entries(planQuery.data?.allocations20t ?? {}).filter(
        ([key]) => supplierIds.has(key) || categoryIds.has(key)
      )
    );
    for (const row of rows) {
      const raw = inputs[row.id]?.trim() ?? "";
      const quantity = raw === "" ? 0 : Number(raw);
      if (
        !Number.isFinite(quantity) ||
        quantity < 0 ||
        !Number.isSafeInteger(Math.trunc(quantity)) ||
        !/^\d+(?:\.\d{1,3})?$/.test(raw || "0")
      ) {
        toast({
          title: tr("invalidQuantity"),
          description: tr("invalidQuantityInfo", { name: row.name }),
          variant: "destructive",
        });
        return;
      }
      allocations[row.id] = quantity;
    }
    saveMutation.mutate(allocations);
  };
  return {
    categoryQuery,
    downloadImage,
    hasEdits,
    inputs,
    isManualRefreshing,
    locked,
    onOpenChange,
    open,
    otwQuery,
    pending,
    planQuery,
    ready,
    recordChanges,
    reportDateLabel,
    reportRef,
    reportRows,
    reportTotals,
    rows,
    saveAndLock,
    saveMutation,
    setHasEdits,
    setInputs,
    setIsManualRefreshing,
    setStockSnapshot,
    setSupplierSnapshot,
    snapshotError,
    totals,
    tr,
    unlockMutation,
    whatsappMutation,
  };
}
