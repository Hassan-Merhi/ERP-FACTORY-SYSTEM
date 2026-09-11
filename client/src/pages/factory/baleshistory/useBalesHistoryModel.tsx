import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { isZebraMode, printRawZpl } from "@/lib/zebraPrint";
import { buildZplBatch } from "@/lib/zplBuilder";
import { getPaperFormat } from "@/components/LabelPrintSettings";
import {
  generateCombinedLabelsHtml,
  generateA5LabelsHtml,
  generateStickerLabelsHtml,
  prefetchBannersForPrint,
  type LabelData,
  type A4DesignColor,
} from "@/lib/labelHtml";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";
import type { FactoryMixBatch } from "@shared/schema";
import { type WeightEditBale } from "@/components/BaleWeightEditDialog";
import { useBalesHistoryDateKeyboard } from "./pagePolicies";

interface BaleRecord {
  id: number;
  referenceNumber: string;
  baleCode: string;
  articleCode?: string | null;
  category?: string | null;
  barcodeValue?: string | null;
  productName?: string | null;
  quantity: number;
  weightKg: string;
  status: string;
  mixBatchId?: number | null;
  stockEntryDate?: string | null;
  createdAt?: string | null;
}

interface BaleProduct {
  name?: string | null;
  articleCode?: string | null;
  sellingPrice?: string | null;
}

interface BaleRow {
  bale: BaleRecord;
  product?: BaleProduct | null;
  mixBatch?: { name?: string | null } | null;
  lastPrintedAt?: string | null;
}

type BalesPage = { items: BaleRow[]; total: number; page: number; limit: number; totalPages: number };

export function useBalesHistoryModel() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");
  const [exportLoading, setExportLoading] = useState(false);
  const { colors: designColors } = useLabelDesignColors();

  const [searchTerm, setSearchTerm] = useState("");
  const [batchFilter, _setBatchFilter] = useState("all");
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

  const { data: myAccess } = useQuery<{ fullAccess: boolean; pageKeys: string[]; hiddenCostFields: string[] }>({
    queryKey: ["/api/factory/my-access"],
  });
  const _hiddenCost = myAccess?.hiddenCostFields ?? [];

  const { data: balesResponse, isLoading } = useQuery<BalesPage>({
    queryKey: [
      "/api/factory/bales",
      dateFilter,
      currentPage,
      statusFilter !== "all" ? statusFilter : undefined,
      batchFilter !== "all" ? batchFilter : undefined,
      debouncedSearch || undefined,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFilter) params.set("date", dateFilter);
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
    refetchOnMount: false,
    placeholderData: (prev) => prev,
  });

  // Extract flat items + pagination metadata from the paginated response.
  const balesData = balesResponse?.items ?? null;
  const serverTotalPages = balesResponse?.totalPages ?? 1;
  const serverTotal = balesResponse?.total ?? 0;

  const { data: _mixBatches } = useQuery<FactoryMixBatch[]>({
    queryKey: ["/api/factory/mix-batches"],
  });

  const deleteBale = useMutation({
    mutationFn: async (id: number) => {
      return await modeApiRequest("DELETE", `/api/factory/bales/${id}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
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
      return await modeApiRequest("PATCH", `/api/factory/bales/${id}/status`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      toast({ title: "Status updated" });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error updating status", description: error.message, variant: "destructive" });
    },
  });

  const bulkUpdateStatus = useMutation({
    mutationFn: async ({ ids, status }: { ids: number[]; status: string }) => {
      return await modeApiRequest("PATCH", "/api/factory/bales/bulk-status", { ids, status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
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
    queryKey: ["/api/factory/bales", returnToStockBale?.bale?.id, "order-info"],
    queryFn: async () => {
      if (!returnToStockBale) return null;
      const res = await modeApiRequest("GET", `/api/factory/bales/${returnToStockBale.bale.id}/order-info`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!returnToStockBale,
  });

  const returnToStockMutation = useMutation({
    mutationFn: async (baleId: number) => {
      const res = await modeApiRequest("POST", `/api/factory/bales/${baleId}/return-to-stock`, {});
      if (!res.ok) {
        const err = await res.json();
        throw Object.assign(new Error(err.message || "Failed to return bale to stock"), { isLastBale: err.isLastBale });
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-balances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      setReturnToStockBale(null);
      const invoiceMsg = data.invoiceNumber
        ? ` Invoice ${data.invoiceNumber} updated to $${parseFloat(data.newGrandTotal || "0").toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`
        : "";
      toast({ title: "Bale returned to stock", description: `Bale removed from order.${invoiceMsg}` });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const repackBale = useMutation({
    mutationFn: async (id: number) => {
      return await modeApiRequest("POST", `/api/factory/bales/${id}/repack`, {});
    },
    onSuccess: async (response) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      setRepackConfirm(null);
      const data = await response.json();
      toast({ title: "Bale repacked", description: `New reference: ${data.newRefNum}` });

      const label: LabelData = {
        referenceNumber: data.newBale.referenceNumber || data.newRefNum,
        articleCode: data.newBale.articleCode || data.newBale.category || "",
        pieces: data.newBale.quantity || 1,
        approxWeightKg: data.newBale.weightKg || "0",
        productName: data.newBale.productName || data.newBale.category || "",
      };
      openBrowserReprint([label]);
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error repacking bale", description: error.message, variant: "destructive" });
      setRepackConfirm(null);
    },
  });

  const removeMutation = useMutation({
    mutationFn: async ({
      ids,
      supervisorUsername,
      supervisorPassword,
      reason,
    }: {
      ids: number[];
      supervisorUsername: string;
      supervisorPassword: string;
      reason: string;
    }) => {
      const response = await modeApiRequest("POST", "/api/factory/stock-entry/remove", {
        baleIds: ids,
        supervisorUsername,
        supervisorPassword,
        reason,
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Failed to remove bales");
      }
      return response.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/stock-entry/in-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      toast({ title: "Bales Removed", description: `${result.removed} bale(s) removed from stock` });
      setSelectedIds(new Set());
      setRemoveDialogOpen(false);
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      setAuthError(error.message);
    },
  });

  const bulkUpdateNamesMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/factory/bales/bulk-update-names", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Names updated",
        description: `Updated ${data.updated} bale${data.updated !== 1 ? "s" : ""}, skipped ${data.skipped}.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
    onSettled: () => setImportingNames(false),
  });

  const reimportMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/factory/bales/reimport", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Reimport failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Bales reimported",
        description: `Successfully reimported ${data.imported} bale(s) (${parseFloat(data.totalWeight).toFixed(1)} kg).`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/stock-entry/in-stock"] });
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Reimport failed", description: err.message, variant: "destructive" });
    },
    onSettled: () => setReimporting(false),
  });

  const startEditName = (baleId: number, currentName: string) => {
    setEditingNameId(baleId);
    setEditingNameValue(currentName);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  const saveEditName = (baleId: number) => {
    if (editingNameValue.trim()) {
      wrapAdminAction(
        () => updateProductName.mutate({ id: baleId, name: editingNameValue.trim() }),
        "Update Bale Name"
      );
    } else {
      setEditingNameId(null);
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (filteredItems: BaleRow[]) => {
    const filteredIds = filteredItems.map((r) => r.bale.id);
    const allSelected = filteredIds.every((id: number) => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredIds));
    }
  };

  const handleReprint = async (baleRow: BaleRow) => {
    const label: LabelData = {
      referenceNumber: baleRow.bale.referenceNumber || baleRow.bale.baleCode,
      articleCode: baleRow.product?.articleCode || baleRow.bale.articleCode || baleRow.bale.category || "",
      pieces: baleRow.bale.quantity || 1,
      approxWeightKg: baleRow.bale.weightKg || "0",
      productName: baleRow.bale.productName || baleRow.product?.name || baleRow.bale.category || "",
    };

    try {
      await modeApiRequest("POST", "/api/bale-label-prints/reprint", { baleId: baleRow.bale.id });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
    } catch {
      // Cache invalidation is best-effort; the next fetch corrects it and a failure here is not worth surfacing.
    }

    if (isZebraMode()) {
      try {
        const zpl = buildZplBatch([label], true);
        await printRawZpl(zpl);
        toast({ title: "Label sent to Zebra printer" });
      } catch (err) {
        toast({
          title: "Zebra print failed — falling back to browser",
          description: getErrorDetails(err).message,
          variant: "destructive",
        });
        openBrowserReprint([label]);
      }
    } else {
      openBrowserReprint([label]);
    }
  };

  const openBrowserReprint = (labels: LabelData[], designColor?: A4DesignColor) => {
    prefetchBannersForPrint();
    const fmt = getPaperFormat();
    if (fmt === "A4" && !designColor) {
      setPendingReprintLabels(labels);
      setDesignPickerOpen(true);
      return;
    }
    const paperHtml = fmt === "A5" ? generateA5LabelsHtml(labels) : generateCombinedLabelsHtml(labels, designColor);
    const stickerHtml = generateStickerLabelsHtml(labels);

    const w1 = window.open("", "_blank", "width=800,height=900");
    if (w1) {
      w1.document.write(paperHtml);
      w1.document.close();
      w1.focus();
      setTimeout(() => w1.print(), 500);
    }

    const w2 = window.open("", "_blank", "width=400,height=600");
    if (w2) {
      w2.document.write(stickerHtml);
      w2.document.close();
      w2.focus();
      const imgs = w2.document.images;
      let loaded = 0;
      const total = imgs.length;
      const tryPrint = () => {
        loaded++;
        if (loaded >= total) setTimeout(() => w2.print(), 300);
      };
      if (total === 0) {
        setTimeout(() => w2.print(), 300);
      } else {
        for (let i = 0; i < total; i++) {
          if (imgs[i].complete) tryPrint();
          else imgs[i].onload = imgs[i].onerror = tryPrint;
        }
      }
    }

    if (!w1 && !w2) {
      toast({ title: "Warning", description: "Please allow pop-ups to print labels", variant: "destructive" });
    }
  };

  const filtered = (balesData || []).filter((row) => {
    const bale = row.bale;
    const product = row.product;
    const batch = row.mixBatch;

    // Always hide deleted bales
    if (bale.status === "REMOVED" || bale.status === "DELETED") return false;

    if (batchFilter !== "all" && String(bale.mixBatchId) !== batchFilter) return false;
    if (statusFilter !== "all" && bale.status !== statusFilter) return false;

    // When the user is actively searching by text, skip the date filter so
    // bales from any date are included (e.g. searching an old reference number).
    if (dateFilter && !searchTerm) {
      // Prefer stockEntryDate (set on all stock-entry/waste-dispatch bales) so
      // backdated entries appear on the correct day. Fall back to createdAt for
      // pressing-batch bales that don't carry a stockEntryDate.
      const baleDate = bale.stockEntryDate
        ? bale.stockEntryDate
        : bale.createdAt
          ? new Date(bale.createdAt).toLocaleDateString("en-CA")
          : null;
      if (baleDate !== dateFilter) return false;
    }

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      const searchFields = [
        bale.baleCode,
        bale.referenceNumber,
        bale.barcodeValue,
        bale.category,
        product?.name,
        product?.articleCode,
        batch?.name,
      ]
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .map((s) => s.toLowerCase());
      if (!searchFields.some((f) => f.includes(term))) return false;
    }

    return true;
  });

  const totalWeight = filtered.reduce((sum: number, row) => sum + parseFloat(row.bale.weightKg || "0"), 0);
  const totalBales = filtered.reduce((sum: number, row) => sum + (row.bale.quantity || 1), 0);

  const groupedFiltered = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        productName: string;
        articleCode: string;
        sellingPrice: string | null;
        totalQty: number;
        totalWeightKg: number;
        rows: BaleRow[];
      }
    >();
    for (const row of filtered) {
      const { bale, product } = row;
      const name = product?.name || bale.productName || bale.category || "-";
      const article = product?.articleCode || bale.category || "-";
      const key = `${name}|||${article}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          productName: name,
          articleCode: article,
          sellingPrice: product?.sellingPrice ?? null,
          totalQty: 0,
          totalWeightKg: 0,
          rows: [],
        });
      }
      const g = map.get(key)!;
      g.rows.push(row);
      g.totalQty += bale.quantity || 1;
      g.totalWeightKg += parseFloat(bale.weightKg || "0");
    }
    return Array.from(map.values());
  }, [filtered]);

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const todayStr = new Date().toLocaleDateString("en-CA");
  const summaryDate = dateFilter || todayStr;
  const todayInStock = (balesData || []).filter((row) => {
    const bale = row.bale;
    if (bale.status !== "IN_STOCK") return false;
    const baleDate = bale.stockEntryDate
      ? bale.stockEntryDate
      : bale.createdAt
        ? new Date(bale.createdAt).toLocaleDateString("en-CA")
        : null;
    return baleDate === summaryDate;
  });

  // Robust classification: check category → productName → product.name with includes() matching
  // so "Garbage Bales", "GARBAGE", " garbage " and "wiper"/"WIPERS" all classify correctly
  const getBaleClassification = (row: BaleRow): "garbage" | "wipers" | "regular" => {
    const candidates = [row.bale?.category, row.bale?.productName, row.product?.name]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map((v) => v.toLowerCase().trim());

    for (const c of candidates) {
      if (c.includes("garbage")) return "garbage";
      if (c.includes("wiper")) return "wipers";
    }
    return "regular";
  };

  const todayGarbage = todayInStock.filter((row) => getBaleClassification(row) === "garbage");
  const todayWipers = todayInStock.filter((row) => getBaleClassification(row) === "wipers");
  const todayRegular = todayInStock.filter((row) => getBaleClassification(row) === "regular");
  const regularQty = todayRegular.reduce((sum: number, row) => sum + (row.bale.quantity || 1), 0);
  const regularKg = todayRegular.reduce((sum: number, row) => sum + parseFloat(row.bale.weightKg || "0"), 0);
  const garbageQty = todayGarbage.reduce((sum: number, row) => sum + (row.bale.quantity || 1), 0);
  const garbageKg = todayGarbage.reduce((sum: number, row) => sum + parseFloat(row.bale.weightKg || "0"), 0);
  const wipersQty = todayWipers.reduce((sum: number, row) => sum + (row.bale.quantity || 1), 0);
  const wipersKg = todayWipers.reduce((sum: number, row) => sum + parseFloat(row.bale.weightKg || "0"), 0);

  return {
    wrapAdminAction,
    AdminDialog,
    showExportDialog,
    setShowExportDialog,
    exportFrom,
    setExportFrom,
    exportTo,
    setExportTo,
    exportLoading,
    designColors,
    searchTerm,
    setSearchTerm,
    statusFilter,
    setStatusFilter,
    dateFilter,
    setDateFilter,
    currentPage,
    setCurrentPage,
    deleteConfirm,
    setDeleteConfirm,
    selectedIds,
    setSelectedIds,
    bulkStatus,
    setBulkStatus,
    editingNameId,
    setEditingNameId,
    editingNameValue,
    setEditingNameValue,
    designPickerOpen,
    setDesignPickerOpen,
    pendingReprintLabels,
    setPendingReprintLabels,
    repackConfirm,
    setRepackConfirm,
    returnToStockBale,
    setReturnToStockBale,
    expandedGroups,
    nameInputRef,
    reimportFileRef,
    namesFileRef,
    removeDialogOpen,
    setRemoveDialogOpen,
    supervisorUsername,
    setSupervisorUsername,
    supervisorPassword,
    setSupervisorPassword,
    removalReason,
    setRemovalReason,
    authError,
    setAuthError,
    importingNames,
    setImportingNames,
    reimporting,
    setReimporting,
    weightEditBale,
    setWeightEditBale,
    handleExport,
    myAccess,
    isLoading,
    balesData,
    serverTotalPages,
    serverTotal,
    deleteBale,
    updateStatus,
    bulkUpdateStatus,
    returnToStockOrderInfo,
    orderInfoLoading,
    returnToStockMutation,
    repackBale,
    removeMutation,
    bulkUpdateNamesMutation,
    reimportMutation,
    startEditName,
    saveEditName,
    toggleSelect,
    toggleSelectAll,
    handleReprint,
    openBrowserReprint,
    filtered,
    totalWeight,
    totalBales,
    groupedFiltered,
    toggleGroup,
    todayStr,
    summaryDate,
    regularQty,
    regularKg,
    garbageQty,
    garbageKg,
    wipersQty,
    wipersKg,
  } as const;
}
