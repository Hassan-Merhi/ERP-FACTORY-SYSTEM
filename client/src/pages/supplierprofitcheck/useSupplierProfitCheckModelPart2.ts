// Extracted from ./useSupplierProfitCheckModel.tsx to keep that module under the source-size cap.
import { useCallback, useEffect, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  errorMessage,
  useSupplierProfitCheckModelPart1,
  type ImportPreview,
  type ImportedPriceRow,
} from "./useSupplierProfitCheckModelPart1";

export function useSupplierProfitCheckModelPart2({
  duties,
  freight,
  importParsed,
  importPreview,
  otherCharges,
  periodFilter,
  qtyMap,
  queryClient,
  recordChanges,
  rows,
  saveOverrideMutation,
  selectedLocationId,
  sellPriceSource,
  setAutosaveStatus,
  setImportLoading,
  setImportParsed,
  setImportPreview,
  setImportedRows,
  setManualAvgPrices,
  setManualPoPrices,
  setNewItemAvgSell,
  setNewItemCode,
  setNewItemDubaiPrice,
  setNewItemGroupId,
  setNewItemName,
  setQtyMap,
  setSavedProforma,
  setShowAddItemDialog,
  setShowImportDialog,
  supplierId,
  surcharge,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useSupplierProfitCheckModelPart1>>,
  | "duties"
  | "freight"
  | "importParsed"
  | "importPreview"
  | "otherCharges"
  | "periodFilter"
  | "qtyMap"
  | "queryClient"
  | "recordChanges"
  | "rows"
  | "saveOverrideMutation"
  | "selectedLocationId"
  | "sellPriceSource"
  | "setAutosaveStatus"
  | "setImportLoading"
  | "setImportParsed"
  | "setImportPreview"
  | "setImportedRows"
  | "setManualAvgPrices"
  | "setManualPoPrices"
  | "setNewItemAvgSell"
  | "setNewItemCode"
  | "setNewItemDubaiPrice"
  | "setNewItemGroupId"
  | "setNewItemName"
  | "setQtyMap"
  | "setSavedProforma"
  | "setShowAddItemDialog"
  | "setShowImportDialog"
  | "supplierId"
  | "surcharge"
  | "toast"
>) {
  const handleExcelFile = useCallback(
    async (file: File) => {
      try {
        const XLSX = await import("xlsx-js-style");
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { type: "array" });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, defval: "" }) as unknown[][];
        if (raw.length < 2) {
          toast({ title: "Empty file", description: "The Excel file has no data rows.", variant: "destructive" });
          return;
        }
        const headers = raw[0].map((heading) => String(heading).toLowerCase().trim());
        const colCode = headers.findIndex(
          (heading) => heading.includes("code") || heading === "item" || heading === "barcode"
        );
        const colCost = headers.findIndex(
          (heading) => heading.includes("cost") || heading.includes("dubai") || heading.includes("po")
        );
        const colSell = headers.findIndex(
          (heading) => heading.includes("sell") || heading.includes("price") || heading.includes("avg")
        );
        const colQty = headers.findIndex((heading) => heading.includes("qty") || heading.includes("quantity"));
        const codeIndex = colCode >= 0 ? colCode : 0;
        const parsed: ImportedPriceRow[] = [];
        for (let index = 1; index < raw.length; index += 1) {
          const row = raw[index];
          const code = String(row[codeIndex] ?? "").trim();
          if (!code) continue;
          const costPrice = colCost >= 0 ? parseFloat(String(row[colCost] ?? "")) : Number.NaN;
          const sellPrice = colSell >= 0 && colSell !== codeIndex ? parseFloat(String(row[colSell] ?? "")) : Number.NaN;
          const qty = colQty >= 0 ? parseFloat(String(row[colQty] ?? "")) : Number.NaN;
          parsed.push({
            code,
            costPrice: !Number.isNaN(costPrice) && costPrice > 0 ? costPrice : undefined,
            sellPrice: !Number.isNaN(sellPrice) && sellPrice > 0 ? sellPrice : undefined,
            qty: !Number.isNaN(qty) && qty > 0 ? qty : undefined,
          });
        }
        if (!parsed.length) {
          toast({ title: "No valid codes found", variant: "destructive" });
          return;
        }
        setImportParsed(parsed);
        setImportPreview(null);
        setShowImportDialog(true);
        setImportLoading(true);
        try {
          const response = await apiRequest("POST", "/api/supplier-profit-check/import-by-codes", {
            codes: parsed.map((item) => item.code),
            supplierId: supplierId ? Number(supplierId) : undefined,
            fromDate: periodFilter.fromDate || undefined,
            toDate: periodFilter.toDate || undefined,
            sellPriceSource,
            locationId:
              sellPriceSource === "location_group" && selectedLocationId ? Number(selectedLocationId) : undefined,
          });
          setImportPreview((await response.json()) as ImportPreview);
        } catch (error: unknown) {
          toast({ title: "Import failed", description: errorMessage(error, "Import failed"), variant: "destructive" });
        } finally {
          setImportLoading(false);
        }
      } catch (error: unknown) {
        toast({
          title: "Failed to parse file",
          description: errorMessage(error, "Failed to parse file"),
          variant: "destructive",
        });
      }
    },
    [
      supplierId,
      periodFilter,
      sellPriceSource,
      selectedLocationId,
      toast,
      setImportLoading,
      setImportParsed,
      setImportPreview,
      setShowImportDialog,
    ]
  );

  const handleConfirmImport = useCallback(() => {
    if (!importPreview) return;
    const newRows = importPreview.rows;
    setImportedRows((previous) => {
      const existingIds = new Set(previous.map((row) => row.stockItemId));
      return [...previous, ...newRows.filter((row) => !existingIds.has(row.stockItemId))];
    });
    const parsedByCode = new Map(importParsed.map((item) => [item.code.toLowerCase(), item]));
    setQtyMap((previous) => {
      const next = { ...previous };
      for (const row of newRows) {
        const item = parsedByCode.get(row.code.toLowerCase());
        if (item?.qty && item.qty > 0 && !next[row.stockItemId]) next[row.stockItemId] = String(item.qty);
      }
      return next;
    });
    setManualPoPrices((previous) => {
      const next = { ...previous };
      for (const row of newRows) {
        const item = parsedByCode.get(row.code.toLowerCase());
        if (item?.costPrice && item.costPrice > 0 && !next[row.stockItemId])
          next[row.stockItemId] = String(item.costPrice);
      }
      return next;
    });
    setManualAvgPrices((previous) => {
      const next = { ...previous };
      for (const row of newRows) {
        const item = parsedByCode.get(row.code.toLowerCase());
        if (item?.sellPrice && item.sellPrice > 0 && !next[row.stockItemId])
          next[row.stockItemId] = String(item.sellPrice);
      }
      return next;
    });
    setShowImportDialog(false);
    setImportPreview(null);
    toast({
      title: "Items imported",
      description: `${newRows.length} item(s) added to the analysis${importPreview.notFound.length > 0 ? ` (${importPreview.notFound.length} code(s) not found)` : ""}`,
    });
  }, [
    importPreview,
    importParsed,
    toast,
    setImportPreview,
    setImportedRows,
    setManualAvgPrices,
    setManualPoPrices,
    setQtyMap,
    setShowImportDialog,
  ]);

  const addItemMutation = useMutation({
    mutationFn: async (payload: {
      code: string;
      name: string;
      supplierId: number;
      stockGroupId?: number;
      dubaiPrice?: number;
      avgSellPrice?: number;
    }) => {
      const response = await apiRequest("POST", "/api/supplier-profit-check/add-stock-item", payload);
      const data = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(data.message ?? "Failed to add item");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/supplier-profit-check/analyze"] });
      queryClient.invalidateQueries({ queryKey: ["/api/supplier-profit-check/po-overrides", supplierId] });
      setShowAddItemDialog(false);
      setNewItemCode("");
      setNewItemName("");
      setNewItemGroupId("");
      setNewItemDubaiPrice("");
      setNewItemAvgSell("");
      toast({ title: "Item added", description: "The item is now included in the analysis." });
    },
    onError: (error: unknown) =>
      toast({
        title: "Failed to add item",
        description: errorMessage(error, "Failed to add item"),
        variant: "destructive",
      }),
  });

  // These handlers are called only after the full price is committed by the
  // input (blur, Enter or Arrow navigation). Save immediately, not 800ms after
  // the first keystroke, so keyboard navigation persists each completed row.
  const handleManualPoChange = useCallback(
    (stockItemId: number, value: string) => {
      setManualPoPrices((previous) => ({ ...previous, [stockItemId]: value }));
      const number = Number(value);
      if (recordChanges.allowed && value.trim() && Number.isFinite(number) && number > 0 && supplierId)
        saveOverrideMutation.mutate({ supplierId: Number(supplierId), stockItemId, poPrice: number });
    },
    [supplierId, saveOverrideMutation, recordChanges.allowed, setManualPoPrices]
  );

  const handleManualAvgChange = useCallback(
    (stockItemId: number, value: string) => {
      setManualAvgPrices((previous) => ({ ...previous, [stockItemId]: value }));
      const number = Number(value);
      if (recordChanges.allowed && value.trim() && Number.isFinite(number) && number > 0 && supplierId)
        saveOverrideMutation.mutate({ supplierId: Number(supplierId), stockItemId, avgPrice: number });
    },
    [supplierId, saveOverrideMutation, recordChanges.allowed, setManualAvgPrices]
  );

  const handleArrowNav = useCallback((event: React.KeyboardEvent<HTMLInputElement>, dataAttr: string) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(`[${dataAttr}]`));
    const index = inputs.indexOf(event.currentTarget);
    const target = event.key === "ArrowDown" ? inputs[index + 1] : inputs[index - 1];
    if (target) {
      target.focus();
      target.select();
    } else {
      // Even at the last/first row, Arrow navigation must commit the edit.
      event.currentTarget.blur();
    }
  }, []);

  useEffect(() => {
    const initialQty: Record<number, string> = {};
    for (const row of rows)
      if (row.proformaQty != null && row.proformaQty > 0) initialQty[row.stockItemId] = String(row.proformaQty);
    setQtyMap(initialQty);
    setSavedProforma(null);
    setAutosaveStatus("idle");
  }, [rows, setAutosaveStatus, setQtyMap, setSavedProforma]);

  const totalBales = useMemo(() => {
    const fromProforma = rows.reduce((sum, row) => sum + (row.proformaQty ?? 0), 0);
    return fromProforma > 0
      ? fromProforma
      : Object.values(qtyMap).reduce((sum, value) => sum + (Number(value) || 0), 0);
  }, [rows, qtyMap]);
  const totalExtraCharges =
    (Number(freight) || 0) + (Number(duties) || 0) + (Number(otherCharges) || 0) + (Number(surcharge) || 0);
  const extraCostPerBale = totalBales > 0 ? totalExtraCharges / totalBales : 0;
  return {
    addItemMutation,
    extraCostPerBale,
    handleArrowNav,
    handleConfirmImport,
    handleExcelFile,
    handleManualAvgChange,
    handleManualPoChange,
    totalBales,
    totalExtraCharges,
  };
}
