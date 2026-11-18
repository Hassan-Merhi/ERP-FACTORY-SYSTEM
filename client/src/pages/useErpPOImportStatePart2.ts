// Extracted from ./POImport.tsx to keep that module under the source-size cap.
import { useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { draftStorageKey, type POImportContainer } from "./poimport/poImportShared";
import { useErpPOImportStatePart1 } from "./useErpPOImportStatePart1";

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
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      // Safari will not fire a second change event for the same Excel file
      // unless the native file input is reset. The File object is retained
      // independently in React state, including while parsing asynchronously.
      e.currentTarget.value = "";
      setPreview(null);
      setValidationResult(null);
      if (selectedCompany?.id) {
        try {
          window.sessionStorage.removeItem(draftStorageKey(selectedCompany.id));
        } catch {
          // Continue parsing if session storage is unavailable.
        }
      }
    }
  };

  const handleParse = () => {
    if (!file) {
      toast({
        title: "No file selected",
        description: "Please select an Excel file to upload",
        variant: "destructive",
      });
      return;
    }
    if (!navigator.onLine) {
      toast({
        title: "Not available offline",
        description: "File imports require a connection",
        variant: "destructive",
      });
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    parseMutation.mutate(formData);
  };

  const selectedContainer = preview?.preview?.find((c: POImportContainer) => c.containerNumber === containerNumber);
  const isNativeZmw = requiresImportCurrency
    ? importCurrency === "ZMW"
    : Boolean(selectedContainer?.items.some((item) => item.currency?.toUpperCase() === "ZMW"));
  const priceSymbol = isNativeZmw ? "K" : "$";
  const { data: approvedRate, isLoading: rateLoading } = useQuery<{ rate: string } | null>({
    queryKey: ["/api/exchange-rates/latest", selectedCompany?.id, "USD", "ZMW", importDate],
    enabled: isNativeZmw && Boolean(selectedCompany?.id) && Boolean(importDate),
    queryFn: async () => {
      const response = await fetch(`/api/exchange-rates/latest?fromCurrency=USD&toCurrency=ZMW&asOf=${importDate}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Unable to load the approved historical USD/ZMW rate");
      return response.json();
    },
  });
  useEffect(() => setValidationResult(null), [approvedRate?.rate, isNativeZmw, setValidationResult]);
  const lockedRate = isNativeZmw ? (approvedRate?.rate ?? "") : undefined;
  const hasValidationErrors = Boolean(validationResult?.errors?.length);
  const isValidated = validationResult !== null;

  const buildPayload = useCallback(
    () => ({
      fileHash: preview!.fileHash,
      fileName: preview!.fileName,
      containerNumber,
      supplierId: Number.parseInt(selectedSupplier, 10),
      importDate,
      exchangeRate: lockedRate,
      currency: requiresImportCurrency ? importCurrency || undefined : undefined,
      preview: preview!.preview,
      freightPaidBy,
      freightParentAccountId: freightParentAccountId ? Number.parseInt(freightParentAccountId, 10) : null,
    }),
    [
      preview,
      containerNumber,
      selectedSupplier,
      importDate,
      lockedRate,
      requiresImportCurrency,
      importCurrency,
      freightPaidBy,
      freightParentAccountId,
    ]
  );

  const refreshStockItemsMutate = refreshStockItemsMutation.mutate;
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
