// Extracted from ./useFactoryContainerLoadingScanModel.ts to keep that module under the source-size cap.
import { type ChangeEvent, type KeyboardEvent, useCallback } from "react";
import { getErrorDetails } from "@shared/errorUtils";
import { summarizeLoadedBales } from "./loadedBales";
import { useProformaComparison } from "./useProformaComparison";
import { BALE_IMPORT_EMPTY_HINT, baleImportRowCount, parseBaleImportWorkbook } from "./baleImportFile";
import { useFactoryContainerLoadingScanModelPart1 } from "./useFactoryContainerLoadingScanModelPart1";
import { useFactoryContainerLoadingScanModelPart2 } from "./useFactoryContainerLoadingScanModelPart2";
import { useFactoryContainerLoadingScanModelPart4 } from "./useFactoryContainerLoadingScanModelPart4";

export function useFactoryContainerLoadingScanModelPart3({
  addBaleMutation,
  bulkImportMutation,
  canCreateLoading,
  chosenProforma,
  createOrderMutation,
  customerId,
  ignoreProformaRef,
  importMode,
  importPreview,
  importRefNumbers,
  loadingNote,
  orderDate,
  orderDetail,
  orderId,
  pendingBypassBaleRef,
  pendingBypassOverloadRef,
  proformaCapacity,
  proformas,
  recordChanges,
  scanCode,
  scanFlash,
  scanSubmissionInFlightRef,
  selectedLocationId,
  setExpandedGroups,
  setImportMode,
  setImportPreview,
  setImportRefNumbers,
  setPendingBypassBaleRef,
  setPendingBypassOverloadRef,
  setPendingOrders,
  setShowImportDialog,
  setShowPendingWarning,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useFactoryContainerLoadingScanModelPart1>> &
    Awaited<ReturnType<typeof useFactoryContainerLoadingScanModelPart2>>,
  | "addBaleMutation"
  | "bulkImportMutation"
  | "canCreateLoading"
  | "chosenProforma"
  | "createOrderMutation"
  | "customerId"
  | "ignoreProformaRef"
  | "importMode"
  | "importPreview"
  | "importRefNumbers"
  | "loadingNote"
  | "orderDate"
  | "orderDetail"
  | "orderId"
  | "pendingBypassBaleRef"
  | "pendingBypassOverloadRef"
  | "proformaCapacity"
  | "proformas"
  | "recordChanges"
  | "scanCode"
  | "scanFlash"
  | "scanSubmissionInFlightRef"
  | "selectedLocationId"
  | "setExpandedGroups"
  | "setImportMode"
  | "setImportPreview"
  | "setImportRefNumbers"
  | "setPendingBypassBaleRef"
  | "setPendingBypassOverloadRef"
  | "setPendingOrders"
  | "setShowImportDialog"
  | "setShowPendingWarning"
  | "toast"
>) {
  const { handleStartLoading, startNewLoadingAnyway, downloadTemplate } = useFactoryContainerLoadingScanModelPart4({
    canCreateLoading,
    chosenProforma,
    createOrderMutation,
    customerId,
    loadingNote,
    orderDate,
    selectedLocationId,
    setPendingOrders,
    setShowPendingWarning,
  });

  const submitScannedCode = useCallback(
    (code: string) => {
      if (!code.trim() || !orderId || !selectedLocationId || !recordChanges.allowed) return;

      // Hardware scanners can emit duplicate Enter events before React renders
      // mutation.isPending=true. Lock synchronously so one scan yields one POST.
      if (scanSubmissionInFlightRef.current || addBaleMutation.isPending) return;

      // Avoid posting into a stale/non-scannable loading from an old UI state.
      if (!orderDetail) return;
      const orderIsScannable =
        orderDetail.status === "DRAFT" ||
        orderDetail.status === "LOADING" ||
        (orderDetail.status === "PENDING_VERIFICATION" && !orderDetail.proformaIdUsed);
      if (!orderIsScannable) {
        toast({
          title: "Loading is no longer scannable",
          description: "Refresh or reopen the loading before scanning another bale.",
          variant: "destructive",
        });
        return;
      }

      const trimmed = code.trim();
      const isBypassProforma = pendingBypassBaleRef !== null && pendingBypassBaleRef === trimmed;
      const isBypassOverload = pendingBypassOverloadRef !== null && pendingBypassOverloadRef === trimmed;
      if (pendingBypassBaleRef !== null && !isBypassProforma) setPendingBypassBaleRef(null);
      if (pendingBypassOverloadRef !== null && !isBypassOverload) setPendingBypassOverloadRef(null);
      scanSubmissionInFlightRef.current = true;
      addBaleMutation.mutate({
        scanCode: trimmed,
        locationId: parseInt(selectedLocationId),
        // When ignoreProforma is ON, always bypass the proforma check so the
        // first scan succeeds immediately (item still appears as "Not in Proforma"
        // in the comparison table — only the double-scan requirement is skipped).
        allowBypassProforma: ignoreProformaRef.current ? true : isBypassProforma || undefined,
        allowBypassOverload: isBypassOverload || undefined,
      });
    },
    [
      orderId,
      selectedLocationId,
      recordChanges.allowed,
      orderDetail,
      pendingBypassBaleRef,
      pendingBypassOverloadRef,
      addBaleMutation,
      toast,
      ignoreProformaRef,
      scanSubmissionInFlightRef,
      setPendingBypassBaleRef,
      setPendingBypassOverloadRef,
    ]
  );

  const handleScan = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      submitScannedCode(scanCode);
    },
    [scanCode, submitScannedCode]
  );

  const handleImportFile = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (evt) => {
        try {
          const result = await parseBaleImportWorkbook(evt.target?.result as ArrayBuffer);
          if (baleImportRowCount(result) === 0) {
            toast({
              title: "No valid rows found",
              description: BALE_IMPORT_EMPTY_HINT[result.mode],
              variant: "destructive",
            });
            return;
          }
          setImportMode(result.mode);
          setImportRefNumbers(result.mode === "refNumber" ? result.refNumbers : []);
          setImportPreview(result.mode === "articleCode" ? result.rows : []);
          setShowImportDialog(true);
        } catch (err) {
          toast({ title: "Parse error", description: getErrorDetails(err).message, variant: "destructive" });
        }
      };
      reader.readAsArrayBuffer(file);
      e.target.value = "";
    },
    [toast, setImportMode, setImportPreview, setImportRefNumbers, setShowImportDialog]
  );

  const toggleGroup = useCallback(
    (articleCode: string) => {
      setExpandedGroups((prev) => {
        const next = new Set(prev);
        if (next.has(articleCode)) next.delete(articleCode);
        else next.add(articleCode);
        return next;
      });
    },
    [setExpandedGroups]
  );

  const closeImportDialog = () => {
    setShowImportDialog(false);
    setImportPreview([]);
    setImportRefNumbers([]);
  };

  const submitImport = () => {
    if (importMode === "refNumber") {
      bulkImportMutation.mutate({ mode: "refNumber", refNumbers: importRefNumbers });
    } else {
      bulkImportMutation.mutate({ mode: "articleCode", items: importPreview });
    }
  };

  const bales = orderDetail?.bales || [];

  const { groupedBalesMap, orderedGroups, totalWeight, loadedByArticle } = summarizeLoadedBales(bales);

  const {
    stockCounts,
    stockLocationId,
    linkedProforma,
    proformaProgress,
    fulfilledCount,
    totalLines,
    remainingProformaBales,
    extraArticles,
  } = useProformaComparison({ proformaCapacity, proformas, orderDetail, selectedLocationId, loadedByArticle });

  const scanInputClass =
    scanFlash === "success"
      ? "ring-2 ring-green-500 bg-green-50 dark:bg-green-950 transition-all"
      : scanFlash === "error"
        ? "ring-2 ring-red-500 bg-red-50 dark:bg-red-950 transition-all"
        : "";
  return {
    bales,
    closeImportDialog,
    downloadTemplate,
    extraArticles,
    fulfilledCount,
    groupedBalesMap,
    handleImportFile,
    handleScan,
    handleStartLoading,
    linkedProforma,
    loadedByArticle,
    orderedGroups,
    proformaProgress,
    remainingProformaBales,
    scanInputClass,
    startNewLoadingAnyway,
    stockCounts,
    stockLocationId,
    submitImport,
    submitScannedCode,
    toggleGroup,
    totalLines,
    totalWeight,
  };
}
