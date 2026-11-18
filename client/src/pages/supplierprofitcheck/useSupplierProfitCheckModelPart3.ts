// Extracted from ./useSupplierProfitCheckModel.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import { useCallback, useEffect, useMemo } from "react";
import { apiRequest } from "@/lib/queryClient";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import type { ColKey, ComputedRow } from "./types";
import { ALL_COLUMNS, DEFAULT_COL_VISIBILITY, STATUS_OPTIONS, STORAGE_KEY_COLS } from "./utils";
import {
  errorMessage,
  useSupplierProfitCheckModelPart1,
  type SaveProformaResult,
} from "./useSupplierProfitCheckModelPart1";
import { useSupplierProfitCheckModelPart2 } from "./useSupplierProfitCheckModelPart2";

export function useSupplierProfitCheckModelPart3({
  activeStatuses,
  autosaveTimerRef,
  colVisibility,
  extraCostPerBale,
  importedRows,
  isLoading,
  manualAvgPrices,
  manualPoPrices,
  periodFilter,
  proformaId,
  proformaNotes,
  proformaRef,
  qtyMap,
  qtyVersion,
  queryEnabled,
  recordChanges,
  rows,
  savedProforma,
  search,
  selectedSupplier,
  sellPriceSource,
  setActiveStatuses,
  setAutosaveStatus,
  setColVisibility,
  setIsSaving,
  setSavedProforma,
  setShowConfirmModal,
  sourceType,
  supplierId,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useSupplierProfitCheckModelPart1>> &
    Awaited<ReturnType<typeof useSupplierProfitCheckModelPart2>>,
  | "activeStatuses"
  | "autosaveTimerRef"
  | "colVisibility"
  | "extraCostPerBale"
  | "importedRows"
  | "isLoading"
  | "manualAvgPrices"
  | "manualPoPrices"
  | "periodFilter"
  | "proformaId"
  | "proformaNotes"
  | "proformaRef"
  | "qtyMap"
  | "qtyVersion"
  | "queryEnabled"
  | "recordChanges"
  | "rows"
  | "savedProforma"
  | "search"
  | "selectedSupplier"
  | "sellPriceSource"
  | "setActiveStatuses"
  | "setAutosaveStatus"
  | "setColVisibility"
  | "setIsSaving"
  | "setSavedProforma"
  | "setShowConfirmModal"
  | "sourceType"
  | "supplierId"
  | "toast"
>) {
  const computedRows = useMemo<ComputedRow[]>(() => {
    const existingIds = new Set(rows.map((row) => row.stockItemId));
    const allRows = [...rows, ...importedRows.filter((row) => !existingIds.has(row.stockItemId))];
    return allRows.map((row) => {
      const manualPo = parseFloat(manualPoPrices[row.stockItemId] ?? "");
      const poPrice = !Number.isNaN(manualPo) && manualPo > 0 ? manualPo : row.poPrice;
      const manualAvg = parseFloat(manualAvgPrices[row.stockItemId] ?? "");
      const sell =
        sellPriceSource === "location_group"
          ? (row.groupSellingPrice ?? null)
          : !Number.isNaN(manualAvg) && manualAvg > 0
            ? manualAvg
            : row.avgSellingPrice;
      const landingCost = poPrice != null ? poPrice + extraCostPerBale : null;
      const costProfit = sell != null && landingCost != null ? sell - landingCost : null;
      const costProfitPct = costProfit != null && sell != null && sell > 0 ? (costProfit / sell) * 100 : null;
      const computedStatus =
        sell == null || poPrice == null
          ? "no_sales_data"
          : costProfit! > 0
            ? "gaining"
            : costProfit! < 0
              ? "losing"
              : "break_even";
      return {
        ...row,
        landingCost,
        costProfit,
        costProfitPct,
        computedStatus,
        hassanProfit: row.configPrice - row.inventoryAvgCost,
      };
    });
  }, [rows, importedRows, extraCostPerBale, manualPoPrices, manualAvgPrices, sellPriceSource]);

  useEffect(() => {
    if (qtyVersion === 0 || !recordChanges.allowed) return;
    const targetId = sourceType === "proforma" && proformaId ? Number(proformaId) : (savedProforma?.id ?? null);
    if (!targetId) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    setAutosaveStatus("saving");
    autosaveTimerRef.current = setTimeout(async () => {
      try {
        const items = computedRows
          .filter((row) => Number(qtyMap[row.stockItemId]) > 0)
          .map((row) => ({
            barcode: row.code,
            code: row.code,
            name: row.name,
            itemName: row.name,
            qty: Number(qtyMap[row.stockItemId]) || 0,
            supplierPrice: row.poPrice ?? row.nCost,
            weight: 0,
          }));
        const response = await apiRequest("PUT", `/api/supplier-profit-check/proforma/${targetId}/update-items`, {
          items,
        });
        if (!response.ok) throw new Error("Save failed");
        setAutosaveStatus("saved");
        setTimeout(() => setAutosaveStatus("idle"), 2500);
      } catch {
        setAutosaveStatus("error");
        setTimeout(() => setAutosaveStatus("idle"), 3000);
      }
    }, 1200);
  }, [qtyVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleStatus = useCallback(
    (value: string) =>
      setActiveStatuses((previous) =>
        previous.includes(value) ? previous.filter((status) => status !== value) : [...previous, value]
      ),
    [setActiveStatuses]
  );
  const statusFilterLabel = useMemo(
    () =>
      activeStatuses.length === 0
        ? "All Statuses"
        : activeStatuses.length === 1
          ? (STATUS_OPTIONS.find((status) => status.value === activeStatuses[0])?.label ?? activeStatuses[0])
          : `${activeStatuses.length} statuses`,
    [activeStatuses]
  );
  const filteredRows = useMemo(
    () =>
      computedRows.filter((row) => {
        if (search) {
          if (!searchAny(search, row.code, row.name)) return false;
        }
        if (activeStatuses.length > 0) {
          const matchesStatus = activeStatuses.includes(row.computedStatus);
          const matchesMissingPo = activeStatuses.includes("missing_po") && row.poPriceSource === "missing";
          if (!matchesStatus && !matchesMissingPo) return false;
        }
        return true;
      }),
    [computedRows, search, activeStatuses]
  );

  const summary = useMemo(() => {
    const withQty = computedRows.filter((row) => Number(qtyMap[row.stockItemId]) > 0);
    const totalQty = withQty.reduce((sum, row) => sum + (Number(qtyMap[row.stockItemId]) || 0), 0);
    const totalLandingCost = withQty.reduce(
      (sum, row) => (row.landingCost != null ? sum + (Number(qtyMap[row.stockItemId]) || 0) * row.landingCost : sum),
      0
    );
    const effectiveSellPrice = (row: ComputedRow) =>
      sellPriceSource === "location_group" ? row.groupSellingPrice : row.avgSellingPrice;
    const totalEstSales = withQty.reduce((sum, row) => {
      const price = effectiveSellPrice(row);
      return price != null ? sum + (Number(qtyMap[row.stockItemId]) || 0) * price : sum;
    }, 0);
    const totalCostProfit = withQty.reduce(
      (sum, row) => (row.costProfit != null ? sum + (Number(qtyMap[row.stockItemId]) || 0) * row.costProfit : sum),
      0
    );
    return {
      totalItems: computedRows.length,
      selectedCount: withQty.length,
      totalQty,
      totalLandingCost,
      totalEstSales,
      totalCostProfit,
      costProfitPct: totalEstSales > 0 ? (totalCostProfit / totalEstSales) * 100 : null,
      losingCount: computedRows.filter((row) => row.computedStatus === "losing").length,
      noDataCount: computedRows.filter((row) => row.computedStatus === "no_sales_data").length,
      missingPoCount: computedRows.filter((row) => row.poPriceSource === "missing").length,
      noGroupPriceCount:
        sellPriceSource === "location_group" ? computedRows.filter((row) => row.groupSellingPrice == null).length : 0,
    };
  }, [computedRows, qtyMap, sellPriceSource]);

  const itemsWithQty = useMemo(
    () => computedRows.filter((row) => Number(qtyMap[row.stockItemId]) > 0),
    [computedRows, qtyMap]
  );
  const toggleCol = useCallback(
    (key: ColKey) =>
      setColVisibility((previous) => {
        const next = { ...previous, [key]: !previous[key] };
        localStorage.setItem(STORAGE_KEY_COLS, JSON.stringify(next));
        return next;
      }),
    [setColVisibility]
  );
  const resetCols = useCallback(() => {
    setColVisibility({ ...DEFAULT_COL_VISIBILITY });
    localStorage.setItem(STORAGE_KEY_COLS, JSON.stringify(DEFAULT_COL_VISIBILITY));
  }, [setColVisibility]);
  const visibleColCount = ALL_COLUMNS.filter((column) => colVisibility[column.key]).length;
  const loaded = queryEnabled && !isLoading && rows.length >= 0;

  const handleSaveProforma = useCallback(async () => {
    setIsSaving(true);
    try {
      const items = itemsWithQty.map((row) => ({
        barcode: row.code,
        code: row.code,
        name: row.name,
        itemName: row.name,
        qty: Number(qtyMap[row.stockItemId]) || 0,
        supplierPrice: row.poPrice ?? row.nCost,
        weight: 0,
      }));
      const response = await apiRequest("POST", "/api/supplier-profit-check/save-proforma", {
        supplierId: Number(supplierId),
        reference: proformaRef || undefined,
        notes: proformaNotes || undefined,
        items,
      });
      const data = (await response.json()) as SaveProformaResult;
      setSavedProforma(data);
      setShowConfirmModal(false);
      toast({ title: "Proforma saved", description: `Reference: ${data.reference}` });
      try {
        await downloadFromUrl(`/api/supplier-profit-check/proforma/${data.id}/export-supplier`, {
          fileName: exportFileName(`proforma ${data.reference}`, "xlsx"),
        });
      } catch {
        /* manual download remains available */
      }
    } catch (error: unknown) {
      toast({ title: "Save failed", description: errorMessage(error, "Save failed"), variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  }, [
    itemsWithQty,
    qtyMap,
    supplierId,
    proformaRef,
    proformaNotes,
    toast,
    setIsSaving,
    setSavedProforma,
    setShowConfirmModal,
  ]);

  const handleExportSupplier = useCallback(async () => {
    if (!savedProforma) return;
    try {
      await downloadFromUrl(`/api/supplier-profit-check/proforma/${savedProforma.id}/export-supplier`, {
        fileName: exportFileName(`proforma ${savedProforma.reference}`, "xlsx"),
      });
    } catch (error: unknown) {
      toast({ title: "Export failed", description: errorMessage(error, "Export failed"), variant: "destructive" });
    }
  }, [savedProforma, toast]);

  const handleExportInternal = useCallback(async () => {
    try {
      const exportRows = itemsWithQty.map((row) => ({ ...row, qty: Number(qtyMap[row.stockItemId]) || 0 }));
      await downloadFromUrl("/api/supplier-profit-check/export-internal", {
        method: "POST",
        body: {
          rows: exportRows,
          supplierName: selectedSupplier?.legalName || selectedSupplier?.legal_name || "",
          fromDate: periodFilter.fromDate,
          toDate: periodFilter.toDate,
          proformaRef: savedProforma?.reference || "",
        },
        fileName: exportFileName(`profit analysis ${savedProforma?.reference ?? ""}`, "xlsx", {
          from: periodFilter.fromDate,
          to: periodFilter.toDate,
        }),
      });
    } catch (error: unknown) {
      toast({ title: "Export failed", description: errorMessage(error, "Export failed"), variant: "destructive" });
    }
  }, [itemsWithQty, qtyMap, selectedSupplier, periodFilter, savedProforma, toast]);
  return {
    computedRows,
    filteredRows,
    handleExportInternal,
    handleExportSupplier,
    handleSaveProforma,
    itemsWithQty,
    loaded,
    resetCols,
    statusFilterLabel,
    summary,
    toggleCol,
    toggleStatus,
    visibleColCount,
  };
}
