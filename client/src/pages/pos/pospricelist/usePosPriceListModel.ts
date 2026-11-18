import { getErrorDetails } from "@shared/errorUtils";
/**
 * Controller hook for the POS Price List page.
 *
 * Owns the location selection (including the synthetic "All Locations" master
 * mode), the two price-list queries, the unpriced detection and filtering, the
 * inline price editor with its keyboard grid navigation, and the Excel
 * template/export/import flows.
 */
import { useState, useRef, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { getDefaultPeriodValue } from "@/components/ui/period-filter";
import type { MasterItem, POSPriceListProps } from "./types";
import { buildPosPriceListExportRow, posPriceListExportColumns } from "./posPriceListExportRow";
import { usePosPriceListDataModel } from "./usePosPriceListDataModel";

export const PRIVILEGED_ROLES = ["Admin", "Owner", "Manager", "Developer"];

export type ImportPreviewRow = {
  barcode: string;
  name: string;
  changes: { locationId: number; locationName: string; price: string }[];
};

export function usePosPriceListModel({ posUser }: POSPriceListProps) {
  const pd = usePosPriceListDataModel({ posUser });

  const commitEdit = (): boolean => {
    if (!pd.editingItem || pd.updatePriceMutation.isPending) return false;
    const val = pd.editingItem.value.trim();
    if (!val || !Number.isFinite(Number(val)) || Number(val) < 0) {
      pd.toast({ title: "Invalid price", description: "Enter a valid number.", variant: "destructive" });
      return false;
    }
    pd.lastSavedRef.current = { stockItemId: pd.editingItem.stockItemId, locationId: pd.editingItem.locationId };
    pd.updatePriceMutation.mutate({
      stockItemId: pd.editingItem.stockItemId,
      locationId: pd.editingItem.locationId,
      sellingPrice: val,
    });
    return true;
  };

  const cancelEdit = () => pd.setEditingItem(null);

  const handleKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // Save first, then move right to the next location price (or down
      // to the next product when there is only one editable price column).
      pd.skipBlurSaveRef.current = true;
      if (commitEdit()) pd.navigateHorizontal("right");
      else pd.skipBlurSaveRef.current = false;
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
      return;
    }
    const vertical = e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : null;
    if (vertical) {
      e.preventDefault();
      pd.skipBlurSaveRef.current = true;
      commitEdit();
      pd.navigateEdit(vertical);
      return;
    }
    const horizontal = e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : null;
    if (horizontal) {
      e.preventDefault();
      pd.skipBlurSaveRef.current = true;
      commitEdit();
      pd.navigateHorizontal(horizontal);
    }
  };

  const handleBlur = () => {
    if (pd.skipBlurSaveRef.current) {
      pd.skipBlurSaveRef.current = false;
      return;
    }
    const current = pd.editingItemRef.current;
    if (!current) return;
    const val = current.value.trim();
    if (!val || isNaN(parseFloat(val))) {
      cancelEdit();
      return;
    }
    pd.lastSavedRef.current = { stockItemId: current.stockItemId, locationId: current.locationId };
    pd.updatePriceMutation.mutate({
      stockItemId: current.stockItemId,
      locationId: current.locationId,
      sellingPrice: val,
    });
  };

  const showCostPrice = (pd.isPrivileged || pd.currentUser?.role === "View Only") && !posUser;

  const [exporting, setExporting] = useState(false);

  // ── Import state ─────────────────────────────────────────────────────────────
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreviewRow[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const downloadTemplate = async () => {
    if (!pd.isAllMode || pd.masters.length === 0) return;
    const XLSX = await import("@/lib/excelHelper");
    const rows = pd.masterItems.map((item: MasterItem) => {
      const row: Record<string, unknown> = {
        Code: item.code || "",
        "Item Name": item.name,
        Group: item.stockGroupName || "",
      };
      for (const m of pd.masters) {
        const price = pd.masterPriceFor(item, m.id);
        row[m.name] = price && parseFloat(price) > 0 ? parseFloat(price) : "";
      }
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Price List");
    const dateStr = new Date().toLocaleDateString("en-CA");
    await XLSX.writeFile(wb, `price_list_template_${dateStr}.xlsx`);
  };

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImportError(null);
    try {
      const { read, utils } = await import("@/lib/excelHelper");
      const wb = await read(file);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rawRows = utils.sheet_to_json(ws, { defval: "" });
      if (rawRows.length === 0) {
        pd.toast({ title: "Empty file", description: "The file has no data rows.", variant: "destructive" });
        return;
      }

      // Build locationName → locationId map from current masters
      const nameToId = new Map<string, number>();
      for (const m of pd.masters) nameToId.set(m.name.toLowerCase().trim(), m.id);
      const locationCols = Object.keys(rawRows[0]).filter((col) => nameToId.has(col.toLowerCase().trim()));
      if (locationCols.length === 0) {
        pd.toast({
          title: "No location columns found",
          description: "Make sure you're uploading the template downloaded from this page.",
          variant: "destructive",
        });
        return;
      }

      const preview: ImportPreviewRow[] = [];
      for (const row of rawRows) {
        const barcode = String(row["Code"] || "").trim();
        const name = String(row["Item Name"] || "").trim();
        if (!barcode) continue;
        const changes: { locationId: number; locationName: string; price: string }[] = [];
        for (const col of locationCols) {
          const raw = row[col];
          const parsed = parseFloat(String(raw));
          if (!isNaN(parsed) && parsed > 0) {
            changes.push({
              locationId: nameToId.get(col.toLowerCase().trim())!,
              locationName: col,
              price: parsed.toFixed(2),
            });
          }
        }
        if (changes.length > 0) preview.push({ barcode, name, changes });
      }
      if (preview.length === 0) {
        pd.toast({
          title: "No prices to update",
          description: "All price cells in the file are blank. Fill in at least one price and try again.",
          variant: "destructive",
        });
        return;
      }
      setImportPreview(preview);
      setImportDialogOpen(true);
    } catch (err) {
      pd.toast({
        title: "Could not read file",
        description: getErrorDetails(err).optionalMessage || "Make sure it is a valid .xlsx file.",
        variant: "destructive",
      });
    }
  };

  const handleImportSubmit = async () => {
    if (importPreview.length === 0 || !pd.recordChanges.allowed) return;
    setImporting(true);
    try {
      const prices: { barcode: string; sellingPrice: string; locationId: number }[] = [];
      for (const item of importPreview) {
        for (const c of item.changes) {
          prices.push({ barcode: item.barcode, sellingPrice: c.price, locationId: c.locationId });
        }
      }
      const res = await apiRequest("POST", "/api/stock-items/bulk-update-prices", { prices });
      const data = await res.json();
      pd.toast({ title: "Price list uploaded", description: data.message || `Updated ${importPreview.length} items.` });
      setImportDialogOpen(false);
      setImportPreview([]);
      queryClient.invalidateQueries({ queryKey: ["/api/pos/price-list-by-masters"] });
      queryClient.invalidateQueries({ queryKey: ["/api/pos/price-list", pd.selectedLocationId] });
    } catch (err) {
      pd.toast({
        title: "Upload failed",
        description: getErrorDetails(err).message || "Something went wrong.",
        variant: "destructive",
      });
    } finally {
      setImporting(false);
    }
  };

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
