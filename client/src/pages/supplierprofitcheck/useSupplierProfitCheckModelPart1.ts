// Extracted from ./useSupplierProfitCheckModel.tsx to keep that module under the source-size cap.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PeriodFilterValue } from "@/components/ui/period-filter";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { apiRequest } from "@/lib/queryClient";
import type { AnalysisRow, ColVisibility, LocationGroup, OtwContainer } from "./types";
import { loadColVisibility } from "./utils";

export type ProfitSourceType = "all" | "proforma" | "otw_containers";

// Stable empty default for the analysis rows. A `= []` default is a new array
// on every render while the analyze query is disabled (no supplier chosen),
// and the effect that seeds quantities from `rows` then replaced qtyMap with a
// new {} each time — re-rendering the page forever as soon as it opened.
const NO_ANALYSIS_ROWS: AnalysisRow[] = [];

export type SellPriceSource = "avg" | "location_group";

export interface SupplierOption {
  id: number;
  code?: string | null;
  legalName?: string | null;
  legal_name?: string | null;
  stockGroupId?: number | null;
}

export interface StockGroupOption {
  id: number;
  name: string;
}

export interface ProformaOption {
  id: number;
  reference: string;
}

export interface ImportedPriceRow {
  code: string;
  costPrice?: number;
  sellPrice?: number;
  qty?: number;
}

export interface ImportPreview {
  rows: AnalysisRow[];
  notFound: string[];
}

export interface SaveProformaResult {
  id: number;
  reference: string;
}

interface OverrideRow {
  stockItemId: number;
  poPrice: string;
  avgPrice: string;
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useSupplierProfitCheckModelPart1() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const queryClient = useQueryClient();
  const companyId = selectedCompany?.id;

  const [supplierId, setSupplierId] = useState("");
  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>({ fromDate: "", toDate: "", preset: "all_time" });
  const [sourceType, setSourceType] = useState<ProfitSourceType>("all");
  const [proformaId, setProformaId] = useState("");
  const [otwContainerIds, setOtwContainerIds] = useState<number[]>([]);
  const [sellPriceSource, setSellPriceSource] = useState<SellPriceSource>("avg");
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [manualPoPrices, setManualPoPrices] = useState<Record<number, string>>({});
  const [manualAvgPrices, setManualAvgPrices] = useState<Record<number, string>>({});
  const [freight, setFreight] = useState("");
  const [duties, setDuties] = useState("");
  const [otherCharges, setOtherCharges] = useState("");
  const [surcharge, setSurcharge] = useState("");
  const [colVisibility, setColVisibility] = useState<ColVisibility>(loadColVisibility);
  const [showColPicker, setShowColPicker] = useState(false);
  const [showStatusPicker, setShowStatusPicker] = useState(false);
  const [qtyMap, setQtyMap] = useState<Record<number, string>>({});
  const [search, setSearch] = useState("");
  const [activeStatuses, setActiveStatuses] = useState<string[]>([]);
  const [savedProforma, setSavedProforma] = useState<SaveProformaResult | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [proformaRef, setProformaRef] = useState("");
  const [proformaNotes, setProformaNotes] = useState("");
  const [showAddItemDialog, setShowAddItemDialog] = useState(false);
  const [newItemCode, setNewItemCode] = useState("");
  const [newItemName, setNewItemName] = useState("");
  const [newItemGroupId, setNewItemGroupId] = useState("");
  const [newItemDubaiPrice, setNewItemDubaiPrice] = useState("");
  const [newItemAvgSell, setNewItemAvgSell] = useState("");
  const [autosaveStatus, setAutosaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [qtyVersion, setQtyVersion] = useState(0);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importedRows, setImportedRows] = useState<AnalysisRow[]>([]);
  const [importParsed, setImportParsed] = useState<ImportedPriceRow[]>([]);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);

  const { data: suppliers = [] } = useQuery<SupplierOption[]>({
    queryKey: ["/api/suppliers-all-spc"],
    queryFn: async () => {
      const response = await fetch("/api/suppliers", { credentials: "include" });
      return response.ok ? ((await response.json()) as SupplierOption[]) : [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: stockGroups = [] } = useQuery<StockGroupOption[]>({
    queryKey: ["/api/stock-groups", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const response = await fetch(`/api/stock-groups?companyId=${companyId}`, { credentials: "include" });
      return response.ok ? ((await response.json()) as StockGroupOption[]) : [];
    },
  });

  const selectedSupplier = suppliers.find((supplier) => String(supplier.id) === supplierId);

  const linkStockGroupMutation = useMutation({
    mutationFn: async (stockGroupId: number | null) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const response = await apiRequest("PATCH", `/api/suppliers/${supplierId}/stock-group`, { stockGroupId });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers", companyId] });
      toast({ title: "Supplier stock group updated" });
    },
    onError: (error: unknown) =>
      toast({
        title: "Failed to update",
        description: errorMessage(error, "Failed to update"),
        variant: "destructive",
      }),
  });

  const { data: proformas = [] } = useQuery<ProformaOption[]>({
    queryKey: ["/api/suppliers", supplierId, "proformas"],
    enabled: !!supplierId && sourceType === "proforma",
    queryFn: async () => {
      const response = await fetch(`/api/suppliers/${supplierId}/proformas`, { credentials: "include" });
      return response.ok ? ((await response.json()) as ProformaOption[]) : [];
    },
  });

  const { data: locationGroups = [] } = useQuery<LocationGroup[]>({
    queryKey: ["/api/supplier-profit-check/location-groups", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const response = await fetch("/api/supplier-profit-check/location-groups", { credentials: "include" });
      return response.ok ? ((await response.json()) as LocationGroup[]) : [];
    },
  });

  const { data: otwContainers = [], isLoading: isLoadingOtw } = useQuery<OtwContainer[]>({
    queryKey: ["/api/supplier-profit-check/otw-containers", supplierId],
    enabled: !!supplierId && sourceType === "otw_containers",
    queryFn: async () => {
      const response = await fetch(`/api/supplier-profit-check/otw-containers?supplierId=${supplierId}`, {
        credentials: "include",
      });
      return response.ok ? ((await response.json()) as OtwContainer[]) : [];
    },
  });

  const queryEnabled =
    !!supplierId &&
    (sourceType === "all" ||
      (sourceType === "proforma" && !!proformaId) ||
      (sourceType === "otw_containers" && otwContainerIds.length > 0));
  const { data: rows = NO_ANALYSIS_ROWS, isLoading } = useQuery<AnalysisRow[]>({
    queryKey: [
      "/api/supplier-profit-check/analyze",
      supplierId,
      periodFilter.fromDate,
      periodFilter.toDate,
      sourceType,
      proformaId,
      otwContainerIds,
      sellPriceSource,
      selectedLocationId,
    ],
    enabled: queryEnabled,
    queryFn: async () => {
      const response = await apiRequest("POST", "/api/supplier-profit-check/analyze", {
        supplierId: Number(supplierId),
        fromDate: periodFilter.fromDate,
        toDate: periodFilter.toDate,
        sourceType,
        proformaId: proformaId ? Number(proformaId) : undefined,
        containerIds: sourceType === "otw_containers" ? otwContainerIds : undefined,
        sellPriceSource,
        locationId: sellPriceSource === "location_group" && selectedLocationId ? Number(selectedLocationId) : undefined,
      });
      return (await response.json()) as AnalysisRow[];
    },
  });

  const { data: overridesData } = useQuery<OverrideRow[]>({
    queryKey: ["/api/supplier-profit-check/po-overrides", supplierId],
    enabled: !!supplierId,
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/supplier-profit-check/po-overrides?supplierId=${supplierId}`);
      return (await response.json()) as OverrideRow[];
    },
  });

  useEffect(() => {
    const initialPo: Record<number, string> = {};
    const initialAverage: Record<number, string> = {};
    for (const override of overridesData ?? []) {
      if (override.poPrice != null)
        initialPo[override.stockItemId] = String(parseFloat(parseFloat(String(override.poPrice)).toFixed(2)));
      if (override.avgPrice != null)
        initialAverage[override.stockItemId] = String(parseFloat(parseFloat(String(override.avgPrice)).toFixed(2)));
    }
    setManualPoPrices(initialPo);
    setManualAvgPrices(initialAverage);
  }, [overridesData]);

  useEffect(() => {
    if (sellPriceSource === "location_group" && locationGroups.length > 0 && !selectedLocationId)
      setSelectedLocationId(String(locationGroups[0].id));
  }, [locationGroups, sellPriceSource]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveOverrideMutation = useMutation({
    mutationFn: async (payload: { supplierId: number; stockItemId: number; poPrice?: number; avgPrice?: number }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const response = await apiRequest("PUT", "/api/supplier-profit-check/po-overrides", payload);
      return response.json();
    },
  });
  return {
    activeStatuses,
    autosaveStatus,
    autosaveTimerRef,
    colVisibility,
    duties,
    freight,
    importFileRef,
    importLoading,
    importParsed,
    importPreview,
    importedRows,
    isLoading,
    isLoadingOtw,
    isSaving,
    linkStockGroupMutation,
    locationGroups,
    manualAvgPrices,
    manualPoPrices,
    newItemAvgSell,
    newItemCode,
    newItemDubaiPrice,
    newItemGroupId,
    newItemName,
    otherCharges,
    otwContainerIds,
    otwContainers,
    periodFilter,
    proformaId,
    proformaNotes,
    proformaRef,
    proformas,
    qtyMap,
    qtyVersion,
    queryClient,
    queryEnabled,
    recordChanges,
    rows,
    saveOverrideMutation,
    savedProforma,
    search,
    selectedLocationId,
    selectedSupplier,
    sellPriceSource,
    setActiveStatuses,
    setAutosaveStatus,
    setColVisibility,
    setDuties,
    setFreight,
    setImportLoading,
    setImportParsed,
    setImportPreview,
    setImportedRows,
    setIsSaving,
    setManualAvgPrices,
    setManualPoPrices,
    setNewItemAvgSell,
    setNewItemCode,
    setNewItemDubaiPrice,
    setNewItemGroupId,
    setNewItemName,
    setOtherCharges,
    setOtwContainerIds,
    setPeriodFilter,
    setProformaId,
    setProformaNotes,
    setProformaRef,
    setQtyMap,
    setQtyVersion,
    setSavedProforma,
    setSearch,
    setSelectedLocationId,
    setSellPriceSource,
    setShowAddItemDialog,
    setShowColPicker,
    setShowConfirmModal,
    setShowImportDialog,
    setShowStatusPicker,
    setSourceType,
    setSupplierId,
    setSurcharge,
    showAddItemDialog,
    showColPicker,
    showConfirmModal,
    showImportDialog,
    showStatusPicker,
    sourceType,
    stockGroups,
    supplierId,
    suppliers,
    surcharge,
    toast,
  };
}
