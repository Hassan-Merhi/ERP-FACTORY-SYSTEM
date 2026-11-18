// Extracted from ./FactoryContainers.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { factoryApiRequest } from "@/lib/factoryApi";
import type { FactorySupplier } from "@shared/schema";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { usePaginatedFilterState } from "@/hooks/use-paginated-filter-state";
import {
  type ContainerWithSupplier,
  otwContainerByCurrency,
  otwMergeCurrencyMaps,
  otwNum,
  STATUS_ACTIVE,
} from "./factory-containers/otwHelpers";
import type { ApiListRow } from "@shared/apiTypes";
import type { ContainerImportRow } from "./FactoryContainersTypes";

export function useFactoryContainersState() {
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();
  const [viewMode, setViewMode] = useState<"list" | "summary">("summary");
  const [openOtwGroups, setOpenOtwGroups] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [editingContainer, setEditingContainer] = useState<ContainerWithSupplier | null>(null);
  const [expandedSuppliers, setExpandedSuppliers] = useState<Set<string>>(new Set(["__all__"]));
  const [viewContainer, setViewContainer] = useState<ContainerWithSupplier | null>(null);
  const {
    filters: { searchQuery, statusFilter },
    setFilter,
    resetFilters,
    hasActiveFilters,
  } = usePaginatedFilterState<{ searchQuery: string; statusFilter: string }>({
    createInitialFilters: () => ({ searchQuery: "", statusFilter: "all" }),
    storageKey: selectedCompany?.id ? `erp-factory-containers-filters-v1:${selectedCompany.id}` : undefined,
  });
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [importOpen, setImportOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<ContainerImportRow[]>([]);
  const [importResult, setImportResult] = useState<{ imported: number; errors: string[]; total: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [reversingContainer, setReversingContainer] = useState<ContainerWithSupplier | null>(null);
  const [postOffloadContainer, setPostOffloadContainer] = useState<ContainerWithSupplier | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const { data: containers, isLoading } = useQuery<ContainerWithSupplier[]>({
    queryKey: companyQueryKey("/api/factory/containers", selectedCompany?.id),
  });
  const { data: suppliers } = useQuery<FactorySupplier[]>({
    queryKey: companyQueryKey("/api/factory/suppliers", selectedCompany?.id),
  });
  const { data: ledgerAccounts = [] } = useQuery<ApiListRow[]>({
    queryKey: companyQueryKey("/api/factory/containers/account-options", selectedCompany?.id),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // ── OTW Summary computed values ──────────────────────────────────────────
  const otwContainers = useMemo(() => (containers || []).filter((c) => STATUS_ACTIVE.has(c.status)), [containers]);

  const otwSupplierGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        supplierId: number | null;
        supplierName: string;
        containers: ContainerWithSupplier[];
        totalKg: number;
        totalsByCurrency: Record<string, number>;
      }
    >();
    for (const c of otwContainers) {
      const key = String(c.supplierId ?? "none");
      if (!map.has(key)) {
        map.set(key, {
          supplierId: c.supplierId ?? null,
          supplierName: c.supplierName || "No Supplier",
          containers: [],
          totalKg: 0,
          totalsByCurrency: {},
        });
      }
      const group = map.get(key)!;
      group.containers.push(c);
      group.totalKg += otwNum(c.totalKg);
      otwMergeCurrencyMaps(group.totalsByCurrency, otwContainerByCurrency(c));
    }
    return Array.from(map.values()).sort((a, b) => a.supplierName.localeCompare(b.supplierName));
  }, [otwContainers]);

  const otwGrandTotals = useMemo(() => {
    const totalsByCurrency: Record<string, number> = {};
    let count = 0;
    let kg = 0;
    for (const g of otwSupplierGroups) {
      count += g.containers.length;
      kg += g.totalKg;
      otwMergeCurrencyMaps(totalsByCurrency, g.totalsByCurrency);
    }
    return { containers: count, kg, totalsByCurrency };
  }, [otwSupplierGroups]);

  const fmtOtwKg = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const toggleOtwGroup = (key: string) => {
    setOpenOtwGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ── Import ────────────────────────────────────────────────────────────────
  const importMutation = useMutation({
    mutationFn: async (rows: ContainerImportRow[]) => {
      const res = await factoryApiRequest("POST", "/api/factory/containers/import-excel", { rows });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Import failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/containers", selectedCompany?.id) });
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/suppliers", selectedCompany?.id) });
      setImportResult(data);
      toast({
        title: "Import Complete",
        description: `${data.imported} of ${data.total} containers imported${data.errors.length > 0 ? ` (${data.errors.length} errors)` : ""}`,
      });
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Import Failed", description: err.message, variant: "destructive" });
    },
  });

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const XLSX = await import("@/lib/excelHelper");
    const data = await file.arrayBuffer();
    const wb = await XLSX.read(data, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const jsonRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
    const get = (row: Record<string, unknown>, keys: string[]) => {
      for (const k of keys) {
        const val = row[k] ?? row[k.toLowerCase()] ?? row[k.toUpperCase()];
        if (val !== undefined && val !== "") return String(val).trim();
      }
      return "";
    };
    const mapped = jsonRows
      .map((row) => ({
        containerNumber: get(row, ["Container Number", "Container #", "ContainerNumber", "container_number"]),
        supplierName: get(row, ["Supplier", "Supplier Name", "SupplierName"]),
        origin: get(row, ["Origin", "Country"]),
        totalKg: get(row, ["Total Kg", "TotalKg", "Weight", "KG", "Kg"]),
        ratePerKg: get(row, ["Rate/Kg", "Rate Per Kg", "RatePerKg", "Rate", "Price"]),
        currencyCode: get(row, ["Currency", "CurrencyCode"]) || "USD",
        fxRateToUsd: get(row, ["FX Rate", "FxRate", "fx_rate_to_usd"]) || "",
        fxSource: get(row, ["FX Source", "FxSource"]) || "",
        arrivalDate: get(row, ["Arrival Date", "ArrivalDate", "Date"]),
        notes: get(row, ["Notes", "Remarks"]),
        status: get(row, ["Status"]) || "PENDING",
        commissionAmount: get(row, ["Commission Amount", "CommissionAmount", "Commission"]) || "",
        commissionCurrencyCode: get(row, ["Commission Currency", "CommissionCurrency"]) || "USD",
      }))
      .filter((r) => r.containerNumber);
    setImportPreview(mapped);
    setImportResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const filteredContainers = containers?.filter((c) => {
    if (statusFilter === "HAS_WEIGHT") {
      if (!(parseFloat((c as { totalKg: string }).totalKg) > 0)) return false;
    } else if (statusFilter === "NO_WEIGHT") {
      if (parseFloat((c as { totalKg: string }).totalKg) > 0) return false;
    } else if (statusFilter !== "all" && c.status !== statusFilter) return false;
    if (searchQuery.trim()) {
      if (!searchAny(searchQuery, c.containerNumber, c.supplierName, c.origin)) return false;
    }
    return true;
  });

  // Keep supplier grouping, but list each supplier's offloaded containers by number.
  if (statusFilter === "OFFLOADED") {
    filteredContainers?.sort((a, b) =>
      (a.containerNumber ?? "").localeCompare(b.containerNumber ?? "", undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );
  }

  const openEdit = (c: ContainerWithSupplier) => {
    setEditingContainer(c);
  };
  return {
    bulkDeleteOpen,
    containers,
    createOpen,
    editingContainer,
    expandedSuppliers,
    fileInputRef,
    filteredContainers,
    fmtOtwKg,
    handleFileSelect,
    hasActiveFilters,
    importMutation,
    importOpen,
    importPreview,
    importResult,
    isLoading,
    ledgerAccounts,
    navigate,
    openEdit,
    openOtwGroups,
    otwContainers,
    otwGrandTotals,
    otwSupplierGroups,
    pendingDeleteId,
    postOffloadContainer,
    recordChanges,
    resetFilters,
    reversingContainer,
    searchQuery,
    selectedIds,
    setBulkDeleteOpen,
    setCreateOpen,
    setEditingContainer,
    setExpandedSuppliers,
    setFilter,
    setImportOpen,
    setImportPreview,
    setImportResult,
    setPendingDeleteId,
    setPostOffloadContainer,
    setReversingContainer,
    setSelectedIds,
    setViewContainer,
    setViewMode,
    statusFilter,
    suppliers,
    toggleOtwGroup,
    viewContainer,
    viewMode,
  };
}
