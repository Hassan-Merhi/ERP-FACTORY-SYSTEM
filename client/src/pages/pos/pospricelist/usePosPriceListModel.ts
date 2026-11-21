/**
 * Controller hook for the POS Price List page.
 *
 * Owns the location selection (including the synthetic "All Locations" master
 * mode), the two price-list queries, the unpriced detection and filtering, the
 * inline price editor with its keyboard grid navigation, and the Excel
 * template/export/import flows.
 */
import { getDefaultPeriodValue } from "@/components/ui/period-filter";
import type { POSPriceListProps } from "./types";
import { buildPosPriceListExportRow, posPriceListExportColumns } from "./posPriceListExportRow";
import { usePosPriceListModelPart1 } from "./usePosPriceListModelPart1";
export type { ImportPreviewRow } from "./usePosPriceListModelPart1";

export const PRIVILEGED_ROLES = ["Admin", "Owner", "Manager", "Developer"];

export function usePosPriceListModel({ posUser }: POSPriceListProps) {
  const {
    pd,
    commitEdit,
    cancelEdit,
    handleKeyDown,
    handleBlur,
    showCostPrice,
    setExporting,
    exporting,
    setImportDialogOpen,
    importDialogOpen,
    importing,
    setImportPreview,
    importPreview,
    setImportError,
    importError,
    importFileRef,
    downloadTemplate,
    handleImportFile,
    handleImportSubmit,
  } = usePosPriceListModelPart1({ posUser });

  const closeImportDialog = () => {
    setImportDialogOpen(false);
    setImportPreview([]);
  };

  const openImportFilePicker = () => {
    setImportError(null);
    importFileRef.current?.click();
  };

  const exportToExcel = async () => {
    if (pd.filteredItems.length === 0) return;
    setExporting(true);
    try {
      const rows = pd.filteredItems.map((item) =>
        buildPosPriceListExportRow(item, {
          showCostPrice,
          isAllMode: pd.isAllMode,
          masters: pd.masters,
          masterPriceFor: pd.masterPriceFor,
        })
      );

      const locationLabel = pd.isAllMode ? "all locations" : (pd.selectedLocation?.name ?? "unknown");
      const filterPart = pd.showUnpriced ? " unpriced" : pd.groupFilter !== "all" ? ` ${pd.groupFilter}` : "";
      const searchPart = pd.search.trim() ? ` search ${pd.search.trim()}` : "";
      const dateStr = new Date().toLocaleDateString("en-CA");

      const { columnsFromOperationalRows, exportOperationalWorkbook } = await import("@/lib/operationalExcelExport");
      const { headers, types } = posPriceListExportColumns({
        showCostPrice,
        isAllMode: pd.isAllMode,
        masters: pd.masters,
      });
      // In All Locations mode these price lists are intentionally re-importable:
      // the parser expects Code and location names in the first worksheet row.
      await exportOperationalWorkbook({
        title: "POS Price List",
        fileName: "price_list_" + locationLabel + filterPart + searchPart + "_" + dateStr + ".xlsx",
        mode: pd.isAllMode ? "import-template" : "report",
        filters: [
          { label: "Location", value: pd.isAllMode ? "All Locations" : (pd.selectedLocation?.name ?? "Unknown") },
        ],
        sheets: [
          {
            name: "Price List",
            rows,
            columns: columnsFromOperationalRows(rows, {
              orderedHeaders: headers,
              types,
            }),
          },
        ],
      });
    } catch (error) {
      pd.toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Unable to export",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  const selectLocation = (id: number) => {
    pd.setSelectedLocationId(id);
    pd.setSearch("");
    pd.setGroupFilter("all");
    pd.setEditingItem(null);
    pd.setShowUnpriced(false);
    pd.setShowZeroQty(false);
    pd.setHiddenUnpricedGroups(new Set());
  };

  const clearFilters = () => {
    pd.setSearch("");
    pd.setGroupFilter("all");
    pd.setShowUnpriced(false);
    pd.setHideZeroQty(false);
    pd.setShowZeroQty(false);
    pd.setHiddenUnpricedGroups(new Set());
    pd.setSalesPeriod(getDefaultPeriodValue("all_time"));
  };

  const toggleUnpriced = () => {
    pd.setShowUnpriced((v) => !v);
    pd.setHiddenUnpricedGroups(new Set());
    pd.setGroupFilter("all");
  };

  const toggleHiddenLocation = (id: number) =>
    pd.setHiddenLocations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleHiddenUnpricedGroup = (name: string) =>
    pd.setHiddenUnpricedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return {
    posUser,
    canEdit: pd.canEdit,
    canEditPrices: pd.canEditPrices,
    canChangeExistingRecords: pd.recordChanges.allowed,
    showCostPrice,
    formatAmount: pd.formatAmount,
    // locations
    locations: pd.locations,
    locationsLoading: pd.locationsLoading,
    selectedLocationId: pd.selectedLocationId,
    selectedLocation: pd.selectedLocation,
    selectLocation,
    isAllMode: pd.isAllMode,
    masters: pd.masters,
    visibleMasters: pd.visibleMasters,
    hiddenLocations: pd.hiddenLocations,
    setHiddenLocations: pd.setHiddenLocations,
    toggleHiddenLocation,
    // data
    isLoading: pd.isLoading,
    isError: pd.isError,
    error: pd.error,
    locationPricedList: pd.locationPricedList,
    filteredItems: pd.filteredItems,
    stockGroups: pd.stockGroups,
    isItemUnpriced: pd.isItemUnpriced,
    unpricedCount: pd.unpricedCount,
    unpricedByGroup: pd.unpricedByGroup,
    masterPriceFor: pd.masterPriceFor,
    // filters
    search: pd.search,
    setSearch: pd.setSearch,
    groupFilter: pd.groupFilter,
    setGroupFilter: pd.setGroupFilter,
    salesPeriod: pd.salesPeriod,
    setSalesPeriod: pd.setSalesPeriod,
    showUnpriced: pd.showUnpriced,
    toggleUnpriced,
    hideZeroQty: pd.hideZeroQty,
    setHideZeroQty: pd.setHideZeroQty,
    showZeroQty: pd.showZeroQty,
    setShowZeroQty: pd.setShowZeroQty,
    zeroQtyCount: pd.zeroQtyCount,
    hiddenUnpricedGroups: pd.hiddenUnpricedGroups,
    setHiddenUnpricedGroups: pd.setHiddenUnpricedGroups,
    toggleHiddenUnpricedGroup,
    clearFilters,
    // inline editing
    editingItem: pd.editingItem,
    setEditingItem: pd.setEditingItem,
    inputRef: pd.inputRef,
    startEdit: pd.startEdit,
    commitEdit,
    cancelEdit,
    handleKeyDown,
    handleBlur,
    updatePriceMutation: pd.updatePriceMutation,
    // excel
    exporting,
    exportToExcel,
    downloadTemplate,
    importFileRef,
    openImportFilePicker,
    handleImportFile,
    handleImportSubmit,
    closeImportDialog,
    importDialogOpen,
    setImportDialogOpen,
    importing,
    importPreview,
    importError,
  };
}

export type PosPriceListModel = ReturnType<typeof usePosPriceListModel>;
