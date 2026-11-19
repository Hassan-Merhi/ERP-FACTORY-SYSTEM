import { useCallback } from "react";
import { apiRequest } from "@/lib/queryClient";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import { type ImportedPriceRow, type ImportPreview } from "./useSupplierProfitCheckModel";
import { effectivePoPrice, effectiveSellPrice } from "./safeModel";
import { useSupplierProfitCheckSafeModelPart1, parsedPositiveOrNull } from "./useSupplierProfitCheckSafeModelPart1";

interface ImportMatch {
  inputIndex: number;
  inputCode: string;
  stockItemId: number;
  code: string;
}

interface ExtendedImportPreview extends ImportPreview {
  matches?: ImportMatch[];
}

export function useSupplierProfitCheckSafeModel() {
  const {
    base,
    queryClient,
    scopedSuppliers,
    selectedSupplier,
    derived,
    persistBulkOverrides,
    allManualOverrides,
    setSupplierId,
    setSourceType,
  } = useSupplierProfitCheckSafeModelPart1();

  const handleManualPoChange = useCallback(
    (stockItemId: number, value: string) => {
      base.handleManualPoChange(stockItemId, value);
      if (!base.canChangeExistingRecords || !base.supplierId) return;
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
      if (!base.canChangeExistingRecords || !base.supplierId) return;
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
      await downloadFromUrl("/api/supplier-profit-check/export-internal", {
        method: "POST",
        body: {
          rows: exportRows,
          supplierName: selectedSupplier?.legalName || selectedSupplier?.legal_name || "",
          fromDate: base.periodFilter.fromDate,
          toDate: base.periodFilter.toDate,
          proformaRef: base.savedProforma?.reference || "",
        },
        fileName: exportFileName(`profit analysis ${base.savedProforma?.reference ?? ""}`, "xlsx", {
          from: base.periodFilter.fromDate,
          to: base.periodFilter.toDate,
        }),
      });
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
