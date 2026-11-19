// Extracted from ./FixedProductionPlannerDialog.tsx to keep that module under the source-size cap.
import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { translateFixedPlannerApiMessage } from "@/i18n/fixedProductionPlannerTranslations";
import {
  calculateFixedProductionCategoryRows,
  sumFixedProductionRows,
  visibleFixedProductionRows,
} from "./fixedProductionPlannerCalculations";
import { apiRequest, type FixedProductionPlannerDialogProps } from "./FixedProductionPlannerDialogTypes";
import { useFixedProductionPlannerDialogStatePart1 } from "./useFixedProductionPlannerDialogStatePart1";

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
  const {
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
  } = useFixedProductionPlannerDialogStatePart1({
    open,
    rawStock,
    rawStockLoading,
    rawStockError,
    suppliers,
    suppliersLoading,
    suppliersError,
  });
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
