// Extracted from ./usePosPriceListModel.ts
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { MasterItem, POSPriceListProps } from "./types";
import { usePosPriceListDataModel } from "./usePosPriceListDataModel";

export type ImportPreviewRow = {
  barcode: string;
  name: string;
  changes: { locationId: number; locationName: string; price: string }[];
};

export function usePosPriceListModelPart1({ posUser }: Pick<POSPriceListProps, "posUser">) {
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
  return {
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
  };
}
