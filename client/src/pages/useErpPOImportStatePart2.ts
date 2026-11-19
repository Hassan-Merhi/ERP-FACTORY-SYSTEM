// Extracted from ./POImport.tsx to keep that module under the source-size cap.
import { useCallback, useEffect } from "react";
import { draftStorageKey } from "./poimport/poImportShared";
import { useErpPOImportStatePart1 } from "./useErpPOImportStatePart1";
import { useErpPOImportStatePart3 } from "./useErpPOImportStatePart3";

export function useErpPOImportStatePart2({
  containerNumber,
  file,
  freightPaidBy,
  freightParentAccountId,
  importCurrency,
  importDate,
  importMutation,
  parseMutation,
  preview,
  refreshInFlight,
  refreshStockItemsMutation,
  requiresImportCurrency,
  selectedCompany,
  selectedSupplier,
  setContainerNumber,
  setFile,
  setFreightPaidBy,
  setFreightParentAccountId,
  setPreview,
  setSelectedSupplier,
  setValidatedAgainstStockItemsAt,
  setValidationResult,
  stockItemsUpdatedAt,
  toast,
  validateMutation,
  validatedAgainstStockItemsAt,
  validationResult,
}: Pick<
  Awaited<ReturnType<typeof useErpPOImportStatePart1>>,
  | "containerNumber"
  | "file"
  | "freightPaidBy"
  | "freightParentAccountId"
  | "importCurrency"
  | "importDate"
  | "importMutation"
  | "parseMutation"
  | "preview"
  | "refreshInFlight"
  | "refreshStockItemsMutation"
  | "requiresImportCurrency"
  | "selectedCompany"
  | "selectedSupplier"
  | "setContainerNumber"
  | "setFile"
  | "setFreightPaidBy"
  | "setFreightParentAccountId"
  | "setPreview"
  | "setSelectedSupplier"
  | "setValidatedAgainstStockItemsAt"
  | "setValidationResult"
  | "stockItemsUpdatedAt"
  | "toast"
  | "validateMutation"
  | "validatedAgainstStockItemsAt"
  | "validationResult"
>) {
  const {
    handleFileChange,
    handleParse,
    selectedContainer,
    isNativeZmw,
    priceSymbol,
    rateLoading,
    lockedRate,
    hasValidationErrors,
    isValidated,
    buildPayload,
    refreshStockItemsMutate,
  } = useErpPOImportStatePart3({
    containerNumber,
    file,
    freightPaidBy,
    freightParentAccountId,
    importCurrency,
    importDate,
    parseMutation,
    preview,
    refreshStockItemsMutation,
    requiresImportCurrency,
    selectedCompany,
    selectedSupplier,
    setFile,
    setPreview,
    setValidationResult,
    toast,
    validationResult,
  });
  const refreshStockItems = useCallback(() => {
    if (!preview || refreshInFlight.current) return;
    refreshInFlight.current = true;
    refreshStockItemsMutate(buildPayload());
  }, [preview, refreshStockItemsMutate, buildPayload, refreshInFlight]);

  const hasUnresolvedItems = Boolean(
    preview?.preview.some((container) => container.items.some((item) => !item.stockItemId || !item.itemName))
  );

  // A stock item may have been added by a different tab, where React Query
  // invalidation in this tab is not delivered. Recheck on return to the tab.
  useEffect(() => {
    if (!hasUnresolvedItems) return;
    const onReturn = () => {
      if (!document.hidden) refreshStockItems();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [hasUnresolvedItems, refreshStockItems]);

  // StockItemCreateDialog invalidates this key when an item is saved within
  // the current tab. Handle that signal even before the user first validates.
  useEffect(() => {
    if (
      !preview ||
      !hasUnresolvedItems ||
      !stockItemsUpdatedAt ||
      stockItemsUpdatedAt <= validatedAgainstStockItemsAt
    ) {
      return;
    }
    setValidatedAgainstStockItemsAt(stockItemsUpdatedAt);
    refreshStockItems();
  }, [
    preview,
    hasUnresolvedItems,
    stockItemsUpdatedAt,
    validatedAgainstStockItemsAt,
    refreshStockItems,
    setValidatedAgainstStockItemsAt,
  ]);

  const checkRequiredFields = () => {
    if (requiresImportCurrency && !importCurrency) {
      toast({
        title: "Invoice currency required",
        description: "Choose whether this purchase invoice is in USD or Kwacha (ZMW) before validating.",
        variant: "destructive",
      });
      return false;
    }
    if (isNativeZmw && !lockedRate) {
      toast({
        title: "Historical rate required",
        description: "Approve the USD/ZMW company rate for the import date before validating.",
        variant: "destructive",
      });
      return false;
    }
    if (!selectedCompany?.id) {
      toast({ title: "Company required", description: "Please select a company first", variant: "destructive" });
      return false;
    }
    if (!selectedSupplier) {
      toast({ title: "Supplier required", description: "Please select a supplier", variant: "destructive" });
      return false;
    }
    if (!containerNumber) {
      toast({
        title: "Container number required",
        description: "Please enter a container number",
        variant: "destructive",
      });
      return false;
    }
    if (!preview) {
      toast({ title: "No preview data", description: "Please parse the file first", variant: "destructive" });
      return false;
    }
    return true;
  };

  const handleValidate = () => {
    if (!checkRequiredFields()) return;
    setValidatedAgainstStockItemsAt(stockItemsUpdatedAt);
    validateMutation.mutate(buildPayload());
  };

  const handleImport = () => {
    if (!checkRequiredFields()) return;
    if (!isValidated) {
      toast({
        title: "Validation required",
        description: "Please validate the data before importing",
        variant: "destructive",
      });
      return;
    }
    if (hasValidationErrors) {
      toast({
        title: "Validation errors present",
        description: "Please fix validation errors before importing",
        variant: "destructive",
      });
      return;
    }
    if (freightPaidBy === "parent" && Number(selectedContainer?.charges?.freight || 0) > 0 && !freightParentAccountId) {
      toast({
        title: "Parent freight account required",
        description: "Please select a parent company account to book the freight against",
        variant: "destructive",
      });
      return;
    }
    importMutation.mutate(buildPayload());
  };

  const handleCancel = () => {
    if (selectedCompany?.id) {
      try {
        window.sessionStorage.removeItem(draftStorageKey(selectedCompany.id));
      } catch {
        // In-memory cancellation still succeeds.
      }
    }
    setFile(null);
    setPreview(null);
    setValidationResult(null);
    setContainerNumber("");
    setSelectedSupplier("");
    setFreightPaidBy("supplier");
    setFreightParentAccountId("");
  };
  return {
    handleCancel,
    handleFileChange,
    handleImport,
    handleParse,
    handleValidate,
    hasValidationErrors,
    isNativeZmw,
    isValidated,
    lockedRate,
    priceSymbol,
    rateLoading,
    refreshStockItems,
    selectedContainer,
  };
}
