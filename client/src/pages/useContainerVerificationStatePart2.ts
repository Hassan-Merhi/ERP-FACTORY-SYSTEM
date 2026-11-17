// Extracted from ./ContainerVerification.tsx to keep that module under the source-size cap.
import { useEffect } from "react";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import { useContainerVerificationStatePart1 } from "./useContainerVerificationStatePart1";

export function useContainerVerificationStatePart2({
  autoCompare,
  autoCompareTriggered,
  autoPopulateMutation,
  autoSupplierId,
  containerData,
  containerId,
  generateComparison,
  proformas,
  selectedProformaId,
  selectedSupplierData,
  selectedSupplierId,
  setAutoCompareTriggered,
  setSelectedProformaId,
  setSelectedSupplierId,
  suppliers,
  toast,
  verificationResult,
}: Pick<
  Awaited<ReturnType<typeof useContainerVerificationStatePart1>>,
  | "autoCompare"
  | "autoCompareTriggered"
  | "autoPopulateMutation"
  | "autoSupplierId"
  | "containerData"
  | "containerId"
  | "generateComparison"
  | "proformas"
  | "selectedProformaId"
  | "selectedSupplierData"
  | "selectedSupplierId"
  | "setAutoCompareTriggered"
  | "setSelectedProformaId"
  | "setSelectedSupplierId"
  | "suppliers"
  | "toast"
  | "verificationResult"
>) {
  const openSelectedProforma = () => {
    if (!selectedSupplierId || !selectedProformaId) return;
    window.open(
      `/suppliers/${selectedSupplierId}/proformas?proformaId=${selectedProformaId}`,
      "_blank",
      "noopener,noreferrer"
    );
  };

  const exportToExcel = async () => {
    if (!selectedSupplierId || !selectedProformaId) return;
    if (!navigator.onLine) {
      toast({ title: "Not available offline", description: "Exports require a connection" });
      return;
    }
    try {
      await downloadFromUrl(
        `/api/suppliers/${selectedSupplierId}/containers/${containerId}/verification-export.xlsx?proformaId=${selectedProformaId}`,
        { fileName: exportFileName(`container verification ${containerId}`, "xlsx") }
      );
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const exportSummaryExcel = async () => {
    if (!selectedSupplierId || !selectedProformaId) return;
    if (!navigator.onLine) {
      toast({ title: "Not available offline", description: "Exports require a connection" });
      return;
    }
    try {
      await downloadFromUrl(
        `/api/suppliers/${selectedSupplierId}/containers/${containerId}/verification-summary-export.xlsx?proformaId=${selectedProformaId}`,
        { fileName: exportFileName(`container verification summary ${containerId}`, "xlsx") }
      );
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const requestAutoPopulate = () => {
    if (!navigator.onLine) {
      toast({ title: "Not available offline", description: "Refresh requires a connection" });
      return;
    }
    autoPopulateMutation.mutate(true);
  };

  useEffect(() => {
    const supplierId = containerData?.container?.supplierId;
    if (supplierId && !selectedSupplierId) {
      setSelectedSupplierId(String(supplierId));
    }
  }, [containerData, selectedSupplierId, setSelectedSupplierId]);

  useEffect(() => {
    if (
      containerData?.container &&
      !autoPopulateMutation.isPending &&
      !autoPopulateMutation.isSuccess &&
      !autoPopulateMutation.isError &&
      navigator.onLine
    ) {
      autoPopulateMutation.mutate(false);
    }
  }, [containerData, autoPopulateMutation]);

  // Auto-select supplier when opened via "Compare" from Daybook (supplierId URL param).
  // Do not require the supplier to exist in the active company's list: containers can
  // legitimately reference a supplier visible through the parent-company fallback.
  useEffect(() => {
    if (!autoSupplierId || selectedSupplierId) return;
    setSelectedSupplierId(autoSupplierId);
  }, [autoSupplierId, selectedSupplierId, setSelectedSupplierId]);

  // Auto-select proforma when opened via "Compare" button from Daybook.
  // Prefers the starred proforma; falls back to the most recent if none is starred.
  useEffect(() => {
    if (!autoCompare || !selectedSupplierId || proformas.length === 0 || selectedProformaId) return;
    const destinationId = containerData?.container?.companyId;
    const eligible = proformas.filter((p) => (p.destinationCompanyId ?? p.companyId) === destinationId);
    const starred = eligible.find((p) => p.isStarred);
    const pick = starred ?? eligible[eligible.length - 1];
    if (pick) setSelectedProformaId(String(pick.id));
  }, [autoCompare, selectedSupplierId, proformas, selectedProformaId, containerData, setSelectedProformaId]);

  // Auto-generate only after the current container details have been refreshed.
  useEffect(() => {
    if (
      !autoCompare ||
      !selectedSupplierId ||
      !selectedProformaId ||
      autoCompareTriggered ||
      !autoPopulateMutation.isSuccess
    )
      return;
    setAutoCompareTriggered(true);
    generateComparison(selectedSupplierId, selectedProformaId, false);
  }, [
    autoCompare,
    selectedSupplierId,
    selectedProformaId,
    autoCompareTriggered,
    autoPopulateMutation.isSuccess,
    generateComparison,
    setAutoCompareTriggered,
  ]);

  const container = containerData?.container;
  const selectedSupplier = selectedSupplierData?.supplier ?? selectedSupplierData;
  const selectedSupplierMissingFromList =
    !!selectedSupplierId && !suppliers.some((supplier) => String(supplier.id) === selectedSupplierId);
  const overloaded = verificationResult?.comparison.filter((c) => c.statusQty === "OVER_LOADED") || [];
  const lessLoaded =
    verificationResult?.comparison.filter(
      (c) => c.statusQty === "UNDER_LOADED" || c.statusQty === "MISSING_FROM_LOADED"
    ) || [];
  const notRequested = verificationResult?.comparison.filter((c) => c.statusQty === "LOADED_NOT_IN_PROFORMA") || [];
  const priceDiffs = verificationResult?.comparison.filter((c) => c.priceStatus === "PRICE_DIFF") || [];
  return {
    container,
    exportSummaryExcel,
    exportToExcel,
    lessLoaded,
    notRequested,
    openSelectedProforma,
    overloaded,
    priceDiffs,
    requestAutoPopulate,
    selectedSupplier,
    selectedSupplierMissingFromList,
  };
}
