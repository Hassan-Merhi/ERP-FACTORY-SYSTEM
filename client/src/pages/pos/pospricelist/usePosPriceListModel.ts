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
import { buildPosPriceListExportRow } from "./posPriceListExportRow";
import { usePosPriceListDataModel } from "./usePosPriceListDataModel";

export const PRIVILEGED_ROLES = ["Admin", "Owner", "Manager", "Developer"];

export type ImportPreviewRow = {
  barcode: string;
  name: string;
  changes: { locationId: number; locationName: string; price: string }[];
};

export function usePosPriceListModel({ posUser }: POSPriceListProps) {
  const p = usePosPriceListDataModel({ posUser });

  const cancelEdit = () => p.setEditingItem(null);

  const handleKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // Save first, then move right to the next location price (or down
      // to the next product when there is only one editable price column).
      p.skipBlurSaveRef.current = true;
      if (p.commitEdit()) p.navigateHorizontal("right");
      else p.skipBlurSaveRef.current = false;
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
      p.skipBlurSaveRef.current = true;
      p.commitEdit();
      p.navigateEdit(vertical);
      return;
    }
    const horizontal = e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : null;
    if (horizontal) {
      e.preventDefault();
      p.skipBlurSaveRef.current = true;
      p.commitEdit();
      p.navigateHorizontal(horizontal);
    }
  };

  const handleBlur = () => {
    if (p.skipBlurSaveRef.current) {
      p.skipBlurSaveRef.current = false;
      return;
    }
    const current = p.editingItemRef.current;
    if (!current) return;
    const val = current.value.trim();
    if (!val || isNaN(parseFloat(val))) {
      cancelEdit();
      return;
    }
    p.lastSavedRef.current = { stockItemId: current.stockItemId, locationId: current.locationId };
    p.updatePriceMutation.mutate({
      stockItemId: current.stockItemId,
      locationId: current.locationId,
      sellingPrice: val,
    });
  };

  const canEdit = !posUser;
  // Price edits and imports change existing items; read-only roles keep the view filters only.
  const canEditPrices = canEdit && p.recordChanges.allowed;
  const showCostPrice = (p.isPrivileged || p.currentUser?.role === "View Only") && !posUser;

  const [exporting, setExporting] = useState(false);

  // ── Import state ─────────────────────────────────────────────────────────────
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreviewRow[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const downloadTemplate = async () => {
    if (!p.isAllMode || p.masters.length === 0) return;
    const XLSX = await import("@/lib/excelHelper");
    const rows = p.masterItems.map((item: MasterItem) => {
      const row: Record<string, unknown> = {
        Code: item.code || "",
        "Item Name": item.name,
        Group: item.stockGroupName || "",
      };
      for (const m of p.masters) {
        const price = p.masterPriceFor(item, m.id);
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
        p.toast({ title: "Empty file", description: "The file has no data rows.", variant: "destructive" });
        return;
      }

      // Build locationName → locationId map from current masters
      const nameToId = new Map<string, number>();
      for (const m of p.masters) nameToId.set(m.name.toLowerCase().trim(), m.id);
      const locationCols = Object.keys(rawRows[0]).filter((col) => nameToId.has(col.toLowerCase().trim()));
      if (locationCols.length === 0) {
        p.toast({
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
        p.toast({
          title: "No prices to update",
          description: "All price cells in the file are blank. Fill in at least one price and try again.",
          variant: "destructive",
        });
        return;
      }
      setImportPreview(preview);
      setImportDialogOpen(true);
    } catch (err) {
      p.toast({
        title: "Could not read file",
        description: getErrorDetails(err).optionalMessage || "Make sure it is a valid .xlsx file.",
        variant: "destructive",
      });
    }
  };

  const handleImportSubmit = async () => {
    if (importPreview.length === 0 || !p.recordChanges.allowed) return;
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
      p.toast({ title: "Price list uploaded", description: data.message || `Updated ${importPreview.length} items.` });
      setImportDialogOpen(false);
      setImportPreview([]);
      queryClient.invalidateQueries({ queryKey: ["/api/pos/price-list-by-masters"] });
      queryClient.invalidateQueries({ queryKey: ["/api/pos/price-list", p.selectedLocationId] });
    } catch (err) {
      p.toast({
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
    if (p.filteredItems.length === 0) return;
    setExporting(true);
    try {
      const rows = p.filteredItems.map((item) =>
        buildPosPriceListExportRow(item, {
          showCostPrice,
          isAllMode: p.isAllMode,
          masters: p.masters,
          masterPriceFor: p.masterPriceFor,
        })
      );

      const locationLabel = p.isAllMode ? "all locations" : (p.selectedLocation?.name ?? "unknown");
      const filterPart = p.showUnpriced ? " unpriced" : p.groupFilter !== "all" ? ` ${p.groupFilter}` : "";
      const searchPart = p.search.trim() ? ` search ${p.search.trim()}` : "";
      const dateStr = new Date().toLocaleDateString("en-CA");

      const { columnsFromOperationalRows, exportOperationalWorkbook } = await import("@/lib/operationalExcelExport");
      const headers = [
        "Code",
        "Item Name",
        "Group",
        ...(showCostPrice ? ["Cost Price", "Cost + Offloading"] : []),
        ...(p.isAllMode
          ? ["Total Qty", ...p.masters.map((master) => master.name)]
          : ["Highest Price Sold", "Lowest Price Sold", "Qty Sold", "Selling Price", "Qty in Stock"]),
      ];
      const types: Record<string, "auto" | "money" | "decimal"> = {};
      for (const key of headers.slice(3)) types[key] = key.includes("Qty") ? "decimal" : "money";
      // In All Locations mode these price lists are intentionally re-importable:
      // the parser expects Code and location names in the first worksheet row.
      await exportOperationalWorkbook({
        title: "POS Price List",
        fileName: "price_list_" + locationLabel + filterPart + searchPart + "_" + dateStr + ".xlsx",
        mode: p.isAllMode ? "import-template" : "report",
        filters: [
          { label: "Location", value: p.isAllMode ? "All Locations" : (p.selectedLocation?.name ?? "Unknown") },
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
    } finally {
      setExporting(false);
    }
  };

  const selectLocation = (id: number) => {
    p.setSelectedLocationId(id);
    p.setSearch("");
    p.setGroupFilter("all");
    p.setEditingItem(null);
    p.setShowUnpriced(false);
    p.setShowZeroQty(false);
    p.setHiddenUnpricedGroups(new Set());
  };

  const clearFilters = () => {
    p.setSearch("");
    p.setGroupFilter("all");
    p.setShowUnpriced(false);
    p.setHideZeroQty(false);
    p.setShowZeroQty(false);
    p.setHiddenUnpricedGroups(new Set());
    p.setSalesPeriod(getDefaultPeriodValue("all_time"));
  };

  const toggleUnpriced = () => {
    p.setShowUnpriced((v) => !v);
    p.setHiddenUnpricedGroups(new Set());
    p.setGroupFilter("all");
  };

  const toggleHiddenLocation = (id: number) =>
    p.setHiddenLocations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleHiddenUnpricedGroup = (name: string) =>
    p.setHiddenUnpricedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return {
    posUser,
    canEdit,
    canEditPrices,
    canChangeExistingRecords: p.recordChanges.allowed,
    showCostPrice,
    formatAmount: p.formatAmount,
    // locations
    locations: p.locations,
    locationsLoading: p.locationsLoading,
    selectedLocationId: p.selectedLocationId,
    selectedLocation: p.selectedLocation,
    selectLocation,
    isAllMode: p.isAllMode,
    masters: p.masters,
    visibleMasters: p.visibleMasters,
    hiddenLocations: p.hiddenLocations,
    setHiddenLocations: p.setHiddenLocations,
    toggleHiddenLocation,
    // data
    isLoading: p.isLoading,
    isError: p.isError,
    error: p.error,
    locationPricedList: p.locationPricedList,
    filteredItems: p.filteredItems,
    stockGroups: p.stockGroups,
    isItemUnpriced: p.isItemUnpriced,
    unpricedCount: p.unpricedCount,
    unpricedByGroup: p.unpricedByGroup,
    masterPriceFor: p.masterPriceFor,
    // filters
    search: p.search,
    setSearch: p.setSearch,
    groupFilter: p.groupFilter,
    setGroupFilter: p.setGroupFilter,
    salesPeriod: p.salesPeriod,
    setSalesPeriod: p.setSalesPeriod,
    showUnpriced: p.showUnpriced,
    toggleUnpriced,
    hideZeroQty: p.hideZeroQty,
    setHideZeroQty: p.setHideZeroQty,
    showZeroQty: p.showZeroQty,
    setShowZeroQty: p.setShowZeroQty,
    zeroQtyCount: p.zeroQtyCount,
    hiddenUnpricedGroups: p.hiddenUnpricedGroups,
    setHiddenUnpricedGroups: p.setHiddenUnpricedGroups,
    toggleHiddenUnpricedGroup,
    clearFilters,
    // inline editing
    editingItem: p.editingItem,
    setEditingItem: p.setEditingItem,
    inputRef: p.inputRef,
    startEdit: p.startEdit,
    commitEdit: p.commitEdit,
    cancelEdit,
    handleKeyDown,
    handleBlur,
    updatePriceMutation: p.updatePriceMutation,
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
