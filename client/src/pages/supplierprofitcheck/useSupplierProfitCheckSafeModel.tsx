import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { apiRequest } from "@/lib/queryClient";
import {
  type ImportedPriceRow,
  type ImportPreview,
  type ProfitSourceType,
  type SupplierOption,
  useSupplierProfitCheckModel,
} from "./useSupplierProfitCheckModel";
import { deriveProfitCheckState, effectivePoPrice, effectiveSellPrice } from "./safeModel";

interface ImportMatch {
  inputIndex: number;
  inputCode: string;
  stockItemId: number;
  code: string;
}

interface ExtendedImportPreview extends ImportPreview {
  matches?: ImportMatch[];
}

interface BulkOverride {
  stockItemId: number;
  poPrice?: number | null;
  avgPrice?: number | null;
}

function parsedPositiveOrNull(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function useSupplierProfitCheckSafeModel() {
  const base = useSupplierProfitCheckModel();
  const { selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const companyId = selectedCompany?.id;

  // Profit Check intentionally inherits suppliers from an explicitly linked
  // parent company, matching PO/container supplier selection. Keep this cache
  // distinct from strict supplier pickers used by accounting workflows.
  const { data: scopedSuppliers = [] } = useQuery<SupplierOption[]>({
    queryKey: ["/api/suppliers", companyId, "allow-parent-fallback"],
    enabled: !!companyId,
    queryFn: async () => {
      const response = await fetch("/api/suppliers?allowParentFallback=true", { credentials: "include" });
      return response.ok ? ((await response.json()) as SupplierOption[]) : [];
    },
    staleTime: 5 * 60 * 1000,
  });
  const selectedSupplier = scopedSuppliers.find((supplier) => String(supplier.id) === base.supplierId);
  const {
    supplierId: activeSupplierId,
    sourceType: activeSourceType,
    proformaId: activeProformaId,
    otwContainerIds: activeOtwContainerIds,
    rows: analysisRows,
    setQtyMap: setOrderQuantities,
  } = base;

  useEffect(() => {
    if (
      !activeSupplierId ||
      (activeSourceType === "proforma" && !activeProformaId) ||
      (activeSourceType === "otw_containers" && activeOtwContainerIds.length === 0)
    ) {
      return;
    }
    const initialQty: Record<number, string> = {};
    for (const row of analysisRows) {
      if (row.proformaQty != null && row.proformaQty > 0) {
        initialQty[row.stockItemId] = String(row.proformaQty);
      }
    }
    setOrderQuantities(initialQty);
  }, [activeSupplierId, activeSourceType, activeProformaId, activeOtwContainerIds, analysisRows, setOrderQuantities]);

  const derived = useMemo(
    () =>
      deriveProfitCheckState({
        rows: base.rows,
        importedRows: base.importedRows,
        qtyMap: base.qtyMap,
        manualPoPrices: base.manualPoPrices,
        manualAvgPrices: base.manualAvgPrices,
        sellPriceSource: base.sellPriceSource,
        freight: base.freight,
        duties: base.duties,
        otherCharges: base.otherCharges,
        surcharge: base.surcharge,
        search: base.search,
        activeStatuses: base.activeStatuses,
      }),
    [
      base.rows,
      base.importedRows,
      base.qtyMap,
      base.manualPoPrices,
      base.manualAvgPrices,
      base.sellPriceSource,
      base.freight,
      base.duties,
      base.otherCharges,
      base.surcharge,
      base.search,
      base.activeStatuses,
    ]
  );

  const persistBulkOverrides = useCallback(
    async (overrides: BulkOverride[]) => {
      if (!base.supplierId || overrides.length === 0) return;
      const response = await apiRequest("PUT", "/api/supplier-profit-check/po-overrides/bulk", {
        supplierId: Number(base.supplierId),
        overrides,
      });
      if (!response.ok) throw new Error("Failed to save price overrides");
      await queryClient.invalidateQueries({
        queryKey: ["/api/supplier-profit-check/po-overrides", base.supplierId],
      });
    },
    [base.supplierId, queryClient]
  );

  const allManualOverrides = useCallback((): BulkOverride[] => {
    const stockItemIds = new Set<number>([
      ...Object.keys(base.manualPoPrices).map(Number),
      ...Object.keys(base.manualAvgPrices).map(Number),
    ]);
    return [...stockItemIds]
      .filter((stockItemId) => Number.isInteger(stockItemId) && stockItemId > 0)
      .map((stockItemId) => {
        const override: BulkOverride = { stockItemId };
        if (Object.prototype.hasOwnProperty.call(base.manualPoPrices, stockItemId)) {
          override.poPrice = parsedPositiveOrNull(base.manualPoPrices[stockItemId]);
        }
        if (Object.prototype.hasOwnProperty.call(base.manualAvgPrices, stockItemId)) {
          override.avgPrice = parsedPositiveOrNull(base.manualAvgPrices[stockItemId]);
        }
        return override;
      });
  }, [base.manualPoPrices, base.manualAvgPrices]);

  const setSupplierId: typeof base.setSupplierId = useCallback(
    (next) => {
      const supplierId = typeof next === "function" ? next(base.supplierId) : next;
      base.setSupplierId(supplierId);
      base.setProformaId("");
      base.setOtwContainerIds([]);
      base.setImportedRows([]);
      base.setQtyMap({});
      base.setFreight("");
      base.setDuties("");
      base.setOtherCharges("");
      base.setSurcharge("");
    },
    [base]
  );

  const setSourceType: typeof base.setSourceType = useCallback(
    (next) => {
      const sourceType = typeof next === "function" ? next(base.sourceType) : next;
      base.setSourceType(sourceType as ProfitSourceType);
      base.setProformaId("");
      base.setOtwContainerIds([]);
      base.setImportedRows([]);
      base.setQtyMap({});
    },
    [base]
  );

  const handleManualPoChange = useCallback(
    (stockItemId: number, value: string) => {
      base.handleManualPoChange(stockItemId, value);
      if (!base.supplierId) return;
      const price = parsedPositiveOrNull(value);
      if (price === null) {
        void apiRequest("PUT", "/api/supplier-profit-check/po-overrides", {
          supplierId: Number(base.supplierId),
          stockItemId,
          poPrice: null,
        }).then(() =>
          queryClient.invalidateQueries({ queryKey: ["/api/supplier-profit-check/po-overrides", base.supplierId] })
        );
      }
    },
    [base, queryClient]
  );

  const handleManualAvgChange = useCallback(
    (stockItemId: number, value: string) => {
      base.handleManualAvgChange(stockItemId, value);
      if (!base.supplierId) return;
      const price = parsedPositiveOrNull(value);
      if (price === null) {
        void apiRequest("PUT", "/api/supplier-profit-check/po-overrides", {
          supplierId: Number(base.supplierId),
          stockItemId,
          avgPrice: null,
        }).then(() =>
          queryClient.invalidateQueries({ queryKey: ["/api/supplier-profit-check/po-overrides", base.supplierId] })
        );
      }
    },
    [base, queryClient]
  );

  const handleConfirmImport = useCallback(async () => {
    const preview = base.importPreview as ExtendedImportPreview | null;
    if (!preview) return;

    const matches = preview.matches ?? [];
    const parsed = base.importParsed as ImportedPriceRow[];
    const byStockItem = new Map<number, { qty: number; poPrice?: number; avgPrice?: number }>();
    for (const match of matches) {
      const imported = parsed[match.inputIndex];
      if (!imported) continue;
      const current = byStockItem.get(match.stockItemId) ?? { qty: 0 };
      if (imported.qty && imported.qty > 0) current.qty += imported.qty;
      if (imported.costPrice && imported.costPrice > 0) current.poPrice = imported.costPrice;
      if (imported.sellPrice && imported.sellPrice > 0) current.avgPrice = imported.sellPrice;
      byStockItem.set(match.stockItemId, current);
    }

    base.handleConfirmImport();

    if (byStockItem.size > 0) {
      base.setQtyMap((previous) => {
        const next = { ...previous };
        for (const [stockItemId, imported] of byStockItem) {
          if (imported.qty > 0) next[stockItemId] = String(imported.qty);
        }
        return next;
      });
    }

    const overrides = [...byStockItem.entries()]
      .filter(([, imported]) => imported.poPrice !== undefined || imported.avgPrice !== undefined)
      .map(([stockItemId, imported]) => ({
        stockItemId,
        ...(imported.poPrice !== undefined ? { poPrice: imported.poPrice } : {}),
        ...(imported.avgPrice !== undefined ? { avgPrice: imported.avgPrice } : {}),
      }));
    if (overrides.length > 0 && base.supplierId) {
      try {
        await persistBulkOverrides(overrides);
      } catch (error) {
        base.toast({
          title: "Imported prices were not saved",
          description: error instanceof Error ? error.message : "Failed to save imported prices",
          variant: "destructive",
        });
      }
    }
  }, [base, persistBulkOverrides]);

  const handleSaveProforma = useCallback(async () => {
    try {
      await persistBulkOverrides(allManualOverrides());
    } catch (error) {
      base.toast({
        title: "Save failed",
        description: error instanceof Error ? error.message : "Failed to save price overrides",
        variant: "destructive",
      });
      return;
    }
    await base.handleSaveProforma();
  }, [allManualOverrides, base, persistBulkOverrides]);

  const handleExportInternal = useCallback(async () => {
    try {
      const exportRows = derived.itemsWithQty.map((row) => ({
        ...row,
        qty: Number(base.qtyMap[row.stockItemId]) || 0,
        effectivePoPrice: effectivePoPrice(row, base.manualPoPrices),
        effectiveSellPrice: effectiveSellPrice(row, base.manualAvgPrices, base.sellPriceSource),
        extraCostPerBale: derived.extraCostPerBale,
      }));
      const response = await fetch("/api/supplier-profit-check/export-internal", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: exportRows,
          supplierName: selectedSupplier?.legalName || selectedSupplier?.legal_name || "",
          fromDate: base.periodFilter.fromDate,
          toDate: base.periodFilter.toDate,
          proformaRef: base.savedProforma?.reference || "",
        }),
      });
      if (!response.ok) throw new Error("Export failed");
      downloadBlob(await response.blob(), `profit-analysis-${base.savedProforma?.reference || "export"}.xlsx`);
    } catch (error) {
      base.toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Export failed",
        variant: "destructive",
      });
    }
  }, [base, derived.extraCostPerBale, derived.itemsWithQty, selectedSupplier]);

  return {
    ...base,
    suppliers: scopedSuppliers,
    selectedSupplier,
    setSupplierId,
    setSourceType,
    handleManualPoChange,
    handleManualAvgChange,
    handleConfirmImport,
    handleSaveProforma,
    handleExportInternal,
    ...derived,
  };
}
