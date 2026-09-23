import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type PeriodFilterValue } from "@/components/ui/period-filter";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { AnalysisRow, ColKey, ColVisibility, ComputedRow, LocationGroup, OtwContainer } from "./types";
import { ALL_COLUMNS, DEFAULT_COL_VISIBILITY, STATUS_OPTIONS, STORAGE_KEY_COLS, loadColVisibility } from "./utils";

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

interface SaveProformaResult {
  id: number;
  reference: string;
}
interface OverrideRow {
  stockItemId: number;
  poPrice: string;
  avgPrice: string;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useSupplierProfitCheckModel() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
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
  const debounceTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const debounceAvgTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
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
      const response = await apiRequest("PUT", "/api/supplier-profit-check/po-overrides", payload);
      return response.json();
    },
  });

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
    [supplierId, periodFilter, sellPriceSource, selectedLocationId, toast]
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
  }, [importPreview, importParsed, toast]);

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

  const handleManualPoChange = useCallback(
    (stockItemId: number, value: string) => {
      setManualPoPrices((previous) => ({ ...previous, [stockItemId]: value }));
      clearTimeout(debounceTimers.current[stockItemId]);
      const number = parseFloat(value);
      if (!Number.isNaN(number) && number > 0 && supplierId)
        debounceTimers.current[stockItemId] = setTimeout(
          () => saveOverrideMutation.mutate({ supplierId: Number(supplierId), stockItemId, poPrice: number }),
          800
        );
    },
    [supplierId, saveOverrideMutation]
  );

  const handleManualAvgChange = useCallback(
    (stockItemId: number, value: string) => {
      setManualAvgPrices((previous) => ({ ...previous, [stockItemId]: value }));
      clearTimeout(debounceAvgTimers.current[stockItemId]);
      const number = parseFloat(value);
      if (!Number.isNaN(number) && number > 0 && supplierId)
        debounceAvgTimers.current[stockItemId] = setTimeout(
          () => saveOverrideMutation.mutate({ supplierId: Number(supplierId), stockItemId, avgPrice: number }),
          800
        );
    },
    [supplierId, saveOverrideMutation]
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
    }
  }, []);

  useEffect(() => {
    const initialQty: Record<number, string> = {};
    for (const row of rows)
      if (row.proformaQty != null && row.proformaQty > 0) initialQty[row.stockItemId] = String(row.proformaQty);
    setQtyMap(initialQty);
    setSavedProforma(null);
    setAutosaveStatus("idle");
  }, [rows]);

  const totalBales = useMemo(() => {
    const fromProforma = rows.reduce((sum, row) => sum + (row.proformaQty ?? 0), 0);
    return fromProforma > 0
      ? fromProforma
      : Object.values(qtyMap).reduce((sum, value) => sum + (Number(value) || 0), 0);
  }, [rows, qtyMap]);
  const totalExtraCharges =
    (Number(freight) || 0) + (Number(duties) || 0) + (Number(otherCharges) || 0) + (Number(surcharge) || 0);
  const extraCostPerBale = totalBales > 0 ? totalExtraCharges / totalBales : 0;

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
    if (qtyVersion === 0) return;
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
    []
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
          const query = search.toLowerCase();
          if (!row.code.toLowerCase().includes(query) && !row.name.toLowerCase().includes(query)) return false;
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
    []
  );
  const resetCols = useCallback(() => {
    setColVisibility({ ...DEFAULT_COL_VISIBILITY });
    localStorage.setItem(STORAGE_KEY_COLS, JSON.stringify(DEFAULT_COL_VISIBILITY));
  }, []);
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
        const exportResponse = await fetch(`/api/supplier-profit-check/proforma/${data.id}/export-supplier`, {
          credentials: "include",
        });
        if (exportResponse.ok) {
          const blob = await exportResponse.blob();
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = `proforma-${data.reference}.xlsx`;
          anchor.click();
          URL.revokeObjectURL(url);
        }
      } catch {
        /* manual download remains available */
      }
    } catch (error: unknown) {
      toast({ title: "Save failed", description: errorMessage(error, "Save failed"), variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  }, [itemsWithQty, qtyMap, supplierId, proformaRef, proformaNotes, toast]);

  const handleExportSupplier = useCallback(async () => {
    if (!savedProforma) return;
    try {
      const response = await fetch(`/api/supplier-profit-check/proforma/${savedProforma.id}/export-supplier`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `proforma-${savedProforma.reference}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error: unknown) {
      toast({ title: "Export failed", description: errorMessage(error, "Export failed"), variant: "destructive" });
    }
  }, [savedProforma, toast]);

  const handleExportInternal = useCallback(async () => {
    try {
      const exportRows = itemsWithQty.map((row) => ({ ...row, qty: Number(qtyMap[row.stockItemId]) || 0 }));
      const response = await fetch("/api/supplier-profit-check/export-internal", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: exportRows,
          supplierName: selectedSupplier?.legalName || selectedSupplier?.legal_name || "",
          fromDate: periodFilter.fromDate,
          toDate: periodFilter.toDate,
          proformaRef: savedProforma?.reference || "",
        }),
      });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `profit-analysis-${savedProforma?.reference || "export"}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error: unknown) {
      toast({ title: "Export failed", description: errorMessage(error, "Export failed"), variant: "destructive" });
    }
  }, [itemsWithQty, qtyMap, selectedSupplier, periodFilter, savedProforma, toast]);

  return {
    toast,
    supplierId,
    setSupplierId,
    periodFilter,
    setPeriodFilter,
    sourceType,
    setSourceType,
    proformaId,
    setProformaId,
    otwContainerIds,
    setOtwContainerIds,
    sellPriceSource,
    setSellPriceSource,
    selectedLocationId,
    setSelectedLocationId,
    manualPoPrices,
    manualAvgPrices,
    freight,
    setFreight,
    duties,
    setDuties,
    otherCharges,
    setOtherCharges,
    surcharge,
    setSurcharge,
    colVisibility,
    showColPicker,
    setShowColPicker,
    showStatusPicker,
    setShowStatusPicker,
    qtyMap,
    setQtyMap,
    search,
    setSearch,
    activeStatuses,
    setActiveStatuses,
    savedProforma,
    showConfirmModal,
    setShowConfirmModal,
    isSaving,
    proformaRef,
    setProformaRef,
    proformaNotes,
    setProformaNotes,
    showAddItemDialog,
    setShowAddItemDialog,
    newItemCode,
    setNewItemCode,
    newItemName,
    setNewItemName,
    newItemGroupId,
    setNewItemGroupId,
    newItemDubaiPrice,
    setNewItemDubaiPrice,
    newItemAvgSell,
    setNewItemAvgSell,
    autosaveStatus,
    setQtyVersion,
    showImportDialog,
    setShowImportDialog,
    importedRows,
    setImportedRows,
    importParsed,
    importPreview,
    setImportPreview,
    importLoading,
    importFileRef,
    suppliers,
    stockGroups,
    selectedSupplier,
    linkStockGroupMutation,
    proformas,
    locationGroups,
    otwContainers,
    isLoadingOtw,
    rows,
    isLoading,
    loaded,
    queryEnabled,
    computedRows,
    filteredRows,
    summary,
    totalBales,
    totalExtraCharges,
    extraCostPerBale,
    itemsWithQty,
    visibleColCount,
    statusFilterLabel,
    addItemMutation,
    handleExcelFile,
    handleConfirmImport,
    handleManualPoChange,
    handleManualAvgChange,
    handleArrowNav,
    toggleStatus,
    toggleCol,
    resetCols,
    handleSaveProforma,
    handleExportSupplier,
    handleExportInternal,
  };
}
