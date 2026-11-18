import { apiRequest, queryClient } from "@/lib/queryClient";
import { exportFileName } from "@/lib/exportFile";
import { useDataToolsModelPart1 } from "./useDataToolsModelPart1";
import { useDataToolsModelPart2 } from "./useDataToolsModelPart2";
export type { SilentTransferErrorLine, SilentTransferItem, SilentTransferWarnItem } from "./useDataToolsModelPart1";

export function useDataToolsModel() {
  const {
    allStockItems,
    appMode,
    bulkRenameOpen,
    costPriceErrors,
    costPriceFile,
    costPriceImportComplete,
    costPriceImportOpen,
    costPriceLocationId,
    costPricePreview,
    downloadCostPriceTemplate,
    downloadStockTemplate,
    dtCurrentUser,
    handleCostPriceDialogClose,
    handleCostPriceFileChange,
    handleCostPriceImport,
    isImportingCostPrice,
    isImportingStock,
    isSilentApplying,
    isSilentParsing,
    locations,
    modeApiRequest,
    selectedCompany,
    setBulkRenameOpen,
    setCostPriceImportOpen,
    setCostPriceLocationId,
    setIsImportingStock,
    setIsSilentApplying,
    setIsSilentParsing,
    setSilentAppliedCount,
    setSilentDstId,
    setSilentErrorLines,
    setSilentFile,
    setSilentImportLoading,
    setSilentImportMode,
    setSilentImportPreview,
    setSilentIncludeWarnings,
    setSilentParseError,
    setSilentProdApplying,
    setSilentProdDone,
    setSilentProdItems,
    setSilentProdLocId,
    setSilentProdOpen,
    setSilentProdSearchTerm,
    setSilentProdType,
    setSilentSrcId,
    setSilentStep,
    setSilentTransferOpen,
    setSilentValidItems,
    setSilentWarnItems,
    setStockErrors,
    setStockFile,
    setStockImportComplete,
    setStockImportOpen,
    setStockLocationId,
    setStockPreview,
    silentAppliedCount,
    silentDstId,
    silentErrorLines,
    silentFile,
    silentImportFileRef,
    silentImportLoading,
    silentImportMode,
    silentImportPreview,
    silentIncludeWarnings,
    silentLocInventory,
    silentLocInventoryLoading,
    silentParseError,
    silentProdApplying,
    silentProdDone,
    silentProdItems,
    silentProdLocId,
    silentProdOpen,
    silentProdSearchTerm,
    silentProdType,
    silentSrcId,
    silentStep,
    silentTransferOpen,
    silentValidItems,
    silentWarnItems,
    stockErrors,
    stockFile,
    stockImportComplete,
    stockImportOpen,
    stockLocationId,
    stockPreview,
    toast,
  } = useDataToolsModelPart1();
  const {
    downloadSilentTemplate,
    exportSilentExcel,
    handleSilentImportFile,
    handleStockDialogClose,
    handleStockFileChange,
    handleStockImport,
  } = useDataToolsModelPart2({
    allStockItems,
    modeApiRequest,
    setIsImportingStock,
    setSilentImportLoading,
    setSilentImportPreview,
    setStockErrors,
    setStockFile,
    setStockImportComplete,
    setStockImportOpen,
    setStockPreview,
    silentImportPreview,
    silentLocInventory,
    stockErrors,
    stockLocationId,
    stockPreview,
    toast,
  });
  const { applySilentImport, exportSilentPDF } = useDataToolsModelPart3({
    locations,
    setSilentImportMode,
    setSilentImportPreview,
    setSilentProdApplying,
    setSilentProdDone,
    silentImportPreview,
    silentProdLocId,
    toast,
  });

  return {
    toast,
    selectedCompany,
    appMode,
    costPriceLocationId,
    setCostPriceLocationId,
    stockLocationId,
    setStockLocationId,
    costPriceImportOpen,
    setCostPriceImportOpen,
    costPriceFile,
    costPricePreview,
    costPriceErrors,
    isImportingCostPrice,
    costPriceImportComplete,
    downloadCostPriceTemplate,
    handleCostPriceFileChange,
    handleCostPriceImport,
    handleCostPriceDialogClose,
    stockImportOpen,
    setStockImportOpen,
    stockFile,
    stockPreview,
    stockErrors,
    isImportingStock,
    stockImportComplete,
    downloadStockTemplate,
    handleStockFileChange,
    handleStockImport,
    handleStockDialogClose,
    dtCurrentUser,
    silentProdOpen,
    setSilentProdOpen,
    silentProdType,
    setSilentProdType,
    silentProdLocId,
    setSilentProdLocId,
    silentProdItems,
    setSilentProdItems,
    silentProdSearchTerm,
    setSilentProdSearchTerm,
    silentProdApplying,
    setSilentProdApplying,
    silentProdDone,
    setSilentProdDone,
    silentImportMode,
    setSilentImportMode,
    silentImportPreview,
    setSilentImportPreview,
    silentImportLoading,
    silentImportFileRef,
    silentTransferOpen,
    setSilentTransferOpen,
    silentSrcId,
    setSilentSrcId,
    silentDstId,
    setSilentDstId,
    silentFile,
    setSilentFile,
    silentValidItems,
    setSilentValidItems,
    silentWarnItems,
    setSilentWarnItems,
    silentErrorLines,
    setSilentErrorLines,
    silentIncludeWarnings,
    setSilentIncludeWarnings,
    silentParseError,
    setSilentParseError,
    silentStep,
    setSilentStep,
    isSilentParsing,
    setIsSilentParsing,
    isSilentApplying,
    setIsSilentApplying,
    silentAppliedCount,
    setSilentAppliedCount,
    bulkRenameOpen,
    setBulkRenameOpen,
    locations,
    allStockItems,
    silentLocInventory,
    silentLocInventoryLoading,
    downloadSilentTemplate,
    handleSilentImportFile,
    exportSilentExcel,
    exportSilentPDF,
    applySilentImport,
  };
}

function useDataToolsModelPart3({
  locations,
  setSilentImportMode,
  setSilentImportPreview,
  setSilentProdApplying,
  setSilentProdDone,
  silentImportPreview,
  silentProdLocId,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useDataToolsModelPart1>>,
  | "locations"
  | "setSilentImportMode"
  | "setSilentImportPreview"
  | "setSilentProdApplying"
  | "setSilentProdDone"
  | "silentImportPreview"
  | "silentProdLocId"
  | "toast"
>) {
  const exportSilentPDF = async () => {
    const { jsPDF } = await import("jspdf");
    const autoTable = (await import("jspdf-autotable")).default;
    const document = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    document.setFontSize(14);
    document.text("Silent Adjustment Preview", 14, 18);
    document.setFontSize(10);
    document.text(
      `Location: ${locations.find((location) => String(location.id) === silentProdLocId)?.name || ""}   Date: ${new Date().toLocaleDateString()}`,
      14,
      25
    );
    const rows = silentImportPreview
      .filter((row) => row.status !== "not_found")
      .map((row, index) => [index + 1, row.stockItemName, row.newQty]);
    autoTable(document, {
      startY: 30,
      head: [["#", "Item Name", "New Qty"]],
      body: rows,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 30, 30] },
      columnStyles: { 0: { cellWidth: 12 }, 2: { cellWidth: 22, halign: "right" } },
    });
    document.save(exportFileName("silent adjustment preview", "pdf"));
  };

  const applySilentImport = async () => {
    const valid = silentImportPreview.filter((row) => row.stockItemId !== null && row.status !== "not_found");
    const productions = valid.filter((row) => row.change > 0);
    const consumptions = valid.filter((row) => row.change < 0);
    if (valid.length === 0) return;
    setSilentProdApplying(true);
    try {
      let totalApplied = 0;
      if (productions.length > 0) {
        const res = await apiRequest("POST", "/api/inventory/silent-production", {
          locationId: silentProdLocId,
          type: "Production",
          items: productions.map((row) => ({
            stockItemId: String(row.stockItemId),
            quantity: String(Math.abs(row.change)),
            rate: String(row.rate),
          })),
        });
        const data = await res.json();
        totalApplied += data.applied || productions.length;
      }
      if (consumptions.length > 0) {
        const res = await apiRequest("POST", "/api/inventory/silent-production", {
          locationId: silentProdLocId,
          type: "Consumption",
          items: consumptions.map((row) => ({
            stockItemId: String(row.stockItemId),
            quantity: String(Math.abs(row.change)),
            rate: "0",
          })),
        });
        const data = await res.json();
        totalApplied += data.applied || consumptions.length;
      }
      setSilentProdDone(totalApplied);
      setSilentImportPreview([]);
      setSilentImportMode(false);
      queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
      queryClient.invalidateQueries({ queryKey: ["/api/location-summary"] });
    } catch (error: unknown) {
      toast({
        title: "Import failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setSilentProdApplying(false);
    }
  };
  return { applySilentImport, exportSilentPDF };
}
