// Extracted from ./FactoryPendingLoadings.tsx to keep that module under the source-size cap.
import { visibleTabInterval } from "@/lib/queryPolicies";
import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import { apiRequest, keyStartsWith } from "@/lib/queryClient";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { UNDO_TIMEOUT_MS, type PendingLoad, type Proforma, type UndoItem } from "./FactoryPendingLoadingsTypes";

export function useFactoryPendingLoadingsStatePart1() {
  const { formatDisplayDate } = useDateFormat();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const recordChanges = useExistingRecordChangeAccess();
  const canStartLoading = recordChanges.canCreate("POST", "/api/factory/customer-orders-loading");
  const [deleteTarget, setDeleteTarget] = useState<PendingLoad | null>(null);
  const [linkTarget, setLinkTarget] = useState<PendingLoad | null>(null);
  const [collapsedCustomers, setCollapsedCustomers] = useState<Set<number>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [customerFilter, setCustomerFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest" | "bales">("newest");

  const toggleCustomer = (customerId: number) => {
    setCollapsedCustomers((prev) => {
      const next = new Set(prev);
      if (next.has(customerId)) next.delete(customerId);
      else next.add(customerId);
      return next;
    });
  };
  const [selectedProformaId, setSelectedProformaId] = useState<number | null>(null);
  const [undoItems, setUndoItems] = useState<UndoItem[]>([]);
  const [, forceRender] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Note editing state
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [editingNoteText, setEditingNoteText] = useState<string>("");

  const saveNoteMutation = useMutation({
    mutationFn: async ({ id, note }: { id: number; note: string }) => {
      const res = await apiRequest("PATCH", `/api/factory/customer-orders/${id}/loading-note`, { note });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      setEditingNoteId(null);
      toast({ title: "Note saved" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Failed to save note", description: error.message, variant: "destructive" });
    },
  });

  // Tick every 100ms to update progress bars
  useEffect(() => {
    tickRef.current = setInterval(() => {
      setUndoItems((prev) => {
        if (prev.length === 0) return prev;
        forceRender((n) => n + 1);
        return prev;
      });
    }, 100);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);
  const {
    data: loads = [],
    isLoading,
    isError: loadsError,
    refetch: refetchLoads,
  } = useQuery<PendingLoad[]>({
    queryKey: ["/api/factory/customer-orders?status=LOADING&profile=summary&pageSize=250"],
    refetchInterval: visibleTabInterval(60_000),
  });

  const { data: proformas = [], isLoading: proformasLoading } = useQuery<Proforma[]>({
    queryKey: ["/api/factory/customer-proformas", linkTarget?.customerId],
    queryFn: async () => {
      if (!linkTarget) return [];
      const res = await fetch(`/api/factory/customer-proformas?customerId=${linkTarget.customerId}&profile=summary`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch proformas");
      return res.json();
    },
    enabled: !!linkTarget,
  });

  const cancelMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/factory/customer-orders/${id}/cancel`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/v5/stock-allocation") });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/factory/customer-orders/${id}/restore-loading`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/v5/stock-allocation") });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Restore failed", description: err.message, variant: "destructive" });
    },
  });

  const handleDelete = (load: PendingLoad) => {
    setDeleteTarget(load);
  };

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;
    const load = deleteTarget;
    setDeleteTarget(null);
    cancelMutation.mutate(load.id);

    const timerId = setTimeout(() => {
      setUndoItems((prev) => prev.filter((u) => u.load.id !== load.id));
    }, UNDO_TIMEOUT_MS);

    setUndoItems((prev) => [
      ...prev.filter((u) => u.load.id !== load.id),
      { load, cancelledAt: Date.now(), timerId, elapsed: 0 },
    ]);
  };

  const handleUndo = (item: UndoItem) => {
    clearTimeout(item.timerId);
    setUndoItems((prev) => prev.filter((u) => u.load.id !== item.load.id));
    restoreMutation.mutate(item.load.id);
  };

  const dismissUndo = (item: UndoItem) => {
    clearTimeout(item.timerId);
    setUndoItems((prev) => prev.filter((u) => u.load.id !== item.load.id));
  };

  const linkProformaMutation = useMutation({
    mutationFn: async ({ orderId, proformaId }: { orderId: number; proformaId: number | null }) => {
      return await apiRequest("PATCH", `/api/factory/customer-orders/${orderId}/link-proforma`, { proformaId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/v5/stock-allocation") });
      toast({ title: "Proforma updated", description: "The loading's proforma has been saved successfully." });
      closeLinkDialog();
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Link failed", description: err.message, variant: "destructive" });
    },
  });

  const closeLinkDialog = () => {
    setLinkTarget(null);
    setSelectedProformaId(null);
  };

  const handleOpenLink = (load: PendingLoad) => {
    setLinkTarget(load);
    setSelectedProformaId(load.proformaIdUsed);
  };

  const handleConfirmLink = () => {
    if (!linkTarget) return;
    linkProformaMutation.mutate({ orderId: linkTarget.id, proformaId: selectedProformaId });
  };

  const handleExport = async (load: PendingLoad) => {
    try {
      await downloadFromUrl(`/api/factory/customer-orders/${load.id}/pending-export`, {
        fileName: exportFileName(`pending loading ${load.id}`, "xlsx"),
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "—";
    const date = formatDisplayDate(dateStr.split("T")[0]);
    const time = new Date(dateStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `${date} ${time}`;
  };

  // All dashboard totals come from the existing loading summary response; no financial
  // calculations, stock operations, or server requests are changed by these controls.
  const totalBales = loads.reduce((sum, load) => sum + (load.totalQtyBales || 0), 0);
  const totalKg = loads.reduce((sum, load) => sum + (Number.parseFloat(load.totalWeightKg || "0") || 0), 0);
  const customerCount = new Set(loads.map((load) => load.customerId)).size;
  const customerNames = new Map(
    loads.map((load) => [load.customerId, load.customerName || "Customer #" + load.customerId])
  );
  const search = searchTerm.trim().toLocaleLowerCase();
  const visibleLoads = loads
    .filter((load) => customerFilter === "all" || String(load.customerId) === customerFilter)
    .filter(
      (load) =>
        !search ||
        [
          load.customerName,
          String(load.id),
          load.proformaName,
          String(load.proformaIdUsed || ""),
          load.containerNotes,
        ].some((value) =>
          String(value || "")
            .toLocaleLowerCase()
            .includes(search)
        )
    )
    .sort((a, b) => {
      if (sortOrder === "bales") return (b.totalQtyBales || 0) - (a.totalQtyBales || 0);
      const difference = (Date.parse(a.loadingStartedAt || "") || 0) - (Date.parse(b.loadingStartedAt || "") || 0);
      return sortOrder === "newest" ? -difference : difference;
    });
  const groups = new Map<number, { customerId: number; customerName: string; loads: PendingLoad[] }>();
  for (const load of visibleLoads) {
    if (!groups.has(load.customerId)) {
      groups.set(load.customerId, {
        customerId: load.customerId,
        customerName: load.customerName || "Customer #" + load.customerId,
        loads: [],
      });
    }
    groups.get(load.customerId)!.loads.push(load);
  }
  return {
    refetchLoads,
    loadsError,
    canStartLoading,
    cancelMutation,
    closeLinkDialog,
    collapsedCustomers,
    customerCount,
    customerFilter,
    customerNames,
    deleteTarget,
    dismissUndo,
    editingNoteId,
    editingNoteText,
    formatDate,
    formatDisplayDate,
    groups,
    handleConfirmDelete,
    handleConfirmLink,
    handleDelete,
    handleExport,
    handleOpenLink,
    handleUndo,
    isLoading,
    linkProformaMutation,
    linkTarget,
    loads,
    navigate,
    proformas,
    proformasLoading,
    queryClient,
    recordChanges,
    restoreMutation,
    saveNoteMutation,
    searchTerm,
    selectedProformaId,
    setCustomerFilter,
    setDeleteTarget,
    setEditingNoteId,
    setEditingNoteText,
    setSearchTerm,
    setSelectedProformaId,
    setSortOrder,
    sortOrder,
    toggleCustomer,
    totalBales,
    totalKg,
    undoItems,
    visibleLoads,
  };
}
