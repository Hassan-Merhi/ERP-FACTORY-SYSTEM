// Extracted from ./useSupplierProfitCheckSafeModel.tsx
import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { apiRequest } from "@/lib/queryClient";
import { type ProfitSourceType, type SupplierOption, useSupplierProfitCheckModel } from "./useSupplierProfitCheckModel";
import { deriveProfitCheckState } from "./safeModel";

interface BulkOverride {
  stockItemId: number;
  poPrice?: number | null;
  avgPrice?: number | null;
}

export function parsedPositiveOrNull(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function useSupplierProfitCheckSafeModelPart1() {
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
      if (!base.canChangeExistingRecords || !base.supplierId || overrides.length === 0) return;
      const response = await apiRequest("PUT", "/api/supplier-profit-check/po-overrides/bulk", {
        supplierId: Number(base.supplierId),
        overrides,
      });
      if (!response.ok) throw new Error("Failed to save price overrides");
      await queryClient.invalidateQueries({
        queryKey: ["/api/supplier-profit-check/po-overrides", base.supplierId],
      });
    },
    [base.canChangeExistingRecords, base.supplierId, queryClient]
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
  return {
    base,
    queryClient,
    scopedSuppliers,
    selectedSupplier,
    derived,
    persistBulkOverrides,
    allManualOverrides,
    setSupplierId,
    setSourceType,
  };
}
