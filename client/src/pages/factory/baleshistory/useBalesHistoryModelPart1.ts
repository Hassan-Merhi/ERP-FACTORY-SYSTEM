// Extracted from ./useBalesHistoryModel.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import type { LabelData } from "@/lib/labelHtml";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";
import type { WeightEditBale } from "@/components/BaleWeightEditDialog";
import { useBalesHistoryDateKeyboard } from "./pagePolicies";
import type { BaleRow, BalesPage } from "./useBalesHistoryModelTypes";

export function useBalesHistoryModelPart1() {
  const { selectedCompany } = useCompany();
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const recordChanges = useExistingRecordChangeAccess();
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");
  const [exportLoading, setExportLoading] = useState(false);
  const { colors: designColors } = useLabelDesignColors();

  const [searchTerm, setSearchTerm] = useState("");
  const [batchFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [currentPage, setCurrentPage] = useState(1);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkStatus, setBulkStatus] = useState("");
  const [editingNameId, setEditingNameId] = useState<number | null>(null);
  const [editingNameValue, setEditingNameValue] = useState("");
  const [designPickerOpen, setDesignPickerOpen] = useState(false);
  const [pendingReprintLabels, setPendingReprintLabels] = useState<LabelData[] | null>(null);
  const [repackConfirm, setRepackConfirm] = useState<BaleRow | null>(null);
  const [returnToStockBale, setReturnToStockBale] = useState<BaleRow | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const nameInputRef = useRef<HTMLInputElement>(null);
  const reimportFileRef = useRef<HTMLInputElement>(null);
  const namesFileRef = useRef<HTMLInputElement>(null);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [supervisorUsername, setSupervisorUsername] = useState("");
  const [supervisorPassword, setSupervisorPassword] = useState("");
  const [removalReason, setRemovalReason] = useState("");
  const [authError, setAuthError] = useState("");
  const [importingNames, setImportingNames] = useState(false);
  const [reimporting, setReimporting] = useState(false);
  const { toast } = useToast();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [weightEditBale, setWeightEditBale] = useState<WeightEditBale | null>(null);

  useBalesHistoryDateKeyboard(setDateFilter);

  // Debounce search term — sends to server only after 300 ms of inactivity.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchTerm), 300);
    return () => clearTimeout(t);
  }, [searchTerm]);

  // Never reuse previous-company selected bale IDs or pending edits.
  useEffect(() => {
    setSelectedIds(new Set());
    setReturnToStockBale(null);
    setWeightEditBale(null);
    setDeleteConfirm(null);
    setEditingNameId(null);
    setCurrentPage(1);
  }, [selectedCompany?.id]);

  // Reset to page 1 whenever any filter that changes the result set changes.
  useEffect(() => {
    setCurrentPage(1);
  }, [dateFilter, statusFilter, batchFilter, debouncedSearch]);

  const handleExport = async () => {
    setExportLoading(true);
    try {
      const params = new URLSearchParams();
      if (exportFrom) params.set("from", exportFrom);
      if (exportTo) params.set("to", exportTo);
      const url = `/api/factory/bales/stock-register.xlsx${params.toString() ? `?${params}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Export failed" }));
        throw new Error(err.message);
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `stock_register${exportFrom && exportTo ? `_${exportFrom}_to_${exportTo}` : "_all"}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
      setShowExportDialog(false);
    } catch (err) {
      toast({ title: "Export Failed", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setExportLoading(false);
    }
  };

  const { data: factoryAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });
  // View Only / Create Only company roles never change existing bales: the page
  // hides repack and delete (fullAccess-gated) and ignores rename, weight edit
  // and bulk-selection gestures. The server refuses the same writes.
  const scopedAccess =
    selectedCompany?.id && factoryAccess?.companyId === selectedCompany.id && factoryAccess.hasFactoryAccess === true
      ? factoryAccess
      : undefined;
  const myAccess = scopedAccess && !recordChanges.allowed ? { ...scopedAccess, fullAccess: false } : scopedAccess;

  const { data: balesResponse, isLoading } = useQuery<BalesPage>({
    queryKey: companyQueryKey(
      "/api/factory/bales",
      selectedCompany?.id,
      dateFilter,
      currentPage,
      statusFilter !== "all" ? statusFilter : undefined,
      batchFilter !== "all" ? batchFilter : undefined,
      debouncedSearch || undefined
    ),
    queryFn: async () => {
      const params = new URLSearchParams();
      // A reference/text search is global across production dates. Keeping the
      // selected date in the request made valid bales look missing when their
      // stored production date differed from the day currently open in Explorer.
      if (dateFilter && !debouncedSearch.trim()) params.set("date", dateFilter);
      // Lite mode: slim product/mixBatch payloads; skips lastPrintedAt lookup.
      params.set("lite", "1");
      params.set("page", String(currentPage));
      params.set("limit", "100");
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (batchFilter !== "all") params.set("mixBatchId", batchFilter);
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
      const path = `/api/factory/bales?${params.toString()}`;
      const res = await modeApiRequest("GET", path);
      if (!res.ok) throw new Error("Failed to fetch bales");
      return res.json();
    },
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: true,
    enabled: Boolean(selectedCompany?.id),
  });

  // Extract flat items + pagination metadata from the paginated response.
  const balesData = balesResponse?.items ?? null;
  const serverTotalPages = balesResponse?.totalPages ?? 1;
  const serverTotal = balesResponse?.total ?? 0;

  const deleteBale = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return await modeApiRequest("DELETE", `/api/factory/bales/${id}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders/loading-list/priority-scan-configs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders/loading-list"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/location-inventory"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      toast({ title: "Bale deleted" });
      setDeleteConfirm(null);
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error deleting bale", description: error.message, variant: "destructive" });
      setDeleteConfirm(null);
    },
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return await modeApiRequest("PATCH", `/api/factory/bales/${id}/status`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders/loading-list/priority-scan-configs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders/loading-list"] });
      toast({ title: "Status updated" });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error updating status", description: error.message, variant: "destructive" });
    },
  });

  const bulkUpdateStatus = useMutation({
    mutationFn: async ({ ids, status }: { ids: number[]; status: string }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return await modeApiRequest("PATCH", "/api/factory/bales/bulk-status", { ids, status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders/loading-list/priority-scan-configs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders/loading-list"] });
      setSelectedIds(new Set());
      setBulkStatus("");
      toast({ title: "Bulk status updated" });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error updating status", description: error.message, variant: "destructive" });
    },
  });

  const updateProductName = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return await modeApiRequest("PATCH", `/api/factory/bales/${id}/product-name`, { name });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      setEditingNameId(null);
      toast({ title: "Product name updated" });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error updating name", description: error.message, variant: "destructive" });
    },
  });

  const { data: returnToStockOrderInfo, isLoading: orderInfoLoading } = useQuery({
    queryKey: companyQueryKey("/api/factory/bales", selectedCompany?.id, returnToStockBale?.bale?.id, "order-info"),
    queryFn: async () => {
      if (!returnToStockBale) return null;
      const res = await modeApiRequest("GET", `/api/factory/bales/${returnToStockBale.bale.id}/order-info`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: Boolean(selectedCompany?.id) && !!returnToStockBale,
  });
  return {
    AdminDialog,
    authError,
    balesData,
    batchFilter,
    bulkStatus,
    bulkUpdateStatus,
    currentPage,
    dateFilter,
    deleteBale,
    deleteConfirm,
    designColors,
    designPickerOpen,
    editingNameId,
    editingNameValue,
    expandedGroups,
    exportFrom,
    exportLoading,
    exportTo,
    handleExport,
    importingNames,
    isLoading,
    modeApiRequest,
    myAccess,
    nameInputRef,
    namesFileRef,
    orderInfoLoading,
    pendingReprintLabels,
    recordChanges,
    reimportFileRef,
    reimporting,
    removalReason,
    removeDialogOpen,
    repackConfirm,
    returnToStockBale,
    returnToStockOrderInfo,
    searchTerm,
    selectedIds,
    serverTotal,
    serverTotalPages,
    setAuthError,
    setBulkStatus,
    setCurrentPage,
    setDateFilter,
    setDeleteConfirm,
    setDesignPickerOpen,
    setEditingNameId,
    setEditingNameValue,
    setExpandedGroups,
    setExportFrom,
    setExportTo,
    setImportingNames,
    setPendingReprintLabels,
    setReimporting,
    setRemovalReason,
    setRemoveDialogOpen,
    setRepackConfirm,
    setReturnToStockBale,
    setSearchTerm,
    setSelectedIds,
    setShowExportDialog,
    setStatusFilter,
    setSupervisorPassword,
    setSupervisorUsername,
    setWeightEditBale,
    showExportDialog,
    statusFilter,
    supervisorPassword,
    supervisorUsername,
    toast,
    updateProductName,
    updateStatus,
    weightEditBale,
    wrapAdminAction,
  };
}
