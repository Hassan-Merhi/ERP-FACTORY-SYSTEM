// Extracted from ./useErpPOImportStatePart2.ts
import { useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { draftStorageKey, type POImportContainer } from "./poimport/poImportShared";
import { useErpPOImportStatePart1 } from "./useErpPOImportStatePart1";

export function useErpPOImportStatePart3({
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
}: Pick<
  Pick<
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
  >,
  | "containerNumber"
  | "file"
  | "freightPaidBy"
  | "freightParentAccountId"
  | "importCurrency"
  | "importDate"
  | "parseMutation"
  | "preview"
  | "refreshStockItemsMutation"
  | "requiresImportCurrency"
  | "selectedCompany"
  | "selectedSupplier"
  | "setFile"
  | "setPreview"
  | "setValidationResult"
  | "toast"
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
  return {
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
  };
}
