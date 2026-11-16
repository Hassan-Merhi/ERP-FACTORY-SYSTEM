// Extracted from ./FactoryPendingLoadings.tsx to keep that module under the source-size cap.
import { visibleTabInterval } from "@/lib/queryPolicies";
import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useLocation } from "wouter";
import { Clock, Download, Link, Package, Pencil, Play, Save, Trash2, Weight, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, keyStartsWith } from "@/lib/queryClient";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { Textarea } from "@/components/ui/textarea";
import { PriorityScanLoadingControl } from "./PriorityScanLoadingControl";
import { UNDO_TIMEOUT_MS, fmtKg, type PendingLoad, type Proforma, type UndoItem } from "./FactoryPendingLoadingsTypes";

export function useFactoryPendingLoadingsState() {
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

  const { data: loads = [], isLoading } = useQuery<PendingLoad[]>({
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

  const handleExport = (load: PendingLoad) => {
    window.open(`/api/factory/customer-orders/${load.id}/pending-export`, "_blank");
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

  const renderLoadCard = (load: PendingLoad, nested = false) => (
    <div
      key={load.id}
      className={
        "group relative overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-all hover:border-primary/50 hover:shadow-md " +
        (nested ? "border-l-4 border-l-primary" : "border-l-4 border-l-primary")
      }
      data-testid={"card-load-" + load.id}
    >
      <div className="flex flex-col gap-3 px-4 py-3.5 xl:flex-row xl:items-center xl:justify-between xl:gap-6">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="text-sm font-bold tracking-tight text-slate-900 dark:text-slate-100 sm:text-base"
              data-testid={"text-customer-" + load.id}
            >
              {load.customerName || "Customer #" + load.customerId}
            </span>
            <Badge
              variant="secondary"
              className="rounded-md border border-primary/20 bg-primary/10 px-2 py-0.5 font-semibold text-primary"
              data-testid={"badge-load-id-" + load.id}
            >
              Loading #{load.id}
            </Badge>
            {load.proformaIdUsed ? (
              <Badge
                variant="outline"
                className="max-w-full gap-1 rounded-lg border-slate-200 bg-slate-50/80 text-slate-600 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300"
                data-testid={"badge-proforma-" + load.id}
              >
                <Link className="h-3 w-3 shrink-0" />
                <span className="max-w-56 truncate sm:max-w-72">
                  {load.proformaName || "Proforma #" + load.proformaIdUsed}
                </span>
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground" data-testid={"badge-no-proforma-" + load.id}>
                No proforma linked
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400 sm:text-sm">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" /> Started: {formatDate(load.loadingStartedAt)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Package className="h-3.5 w-3.5" /> {(load.totalQtyBales || 0).toLocaleString()} bales scanned
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Weight className="h-3.5 w-3.5" /> {fmtKg(load.totalWeightKg)}
            </span>
          </div>
          {recordChanges.allowed && editingNoteId === load.id ? (
            <div className="flex max-w-xl items-start gap-2">
              <Textarea
                value={editingNoteText}
                onChange={(e) => setEditingNoteText(e.target.value)}
                rows={2}
                autoFocus
                className="min-w-0 resize-none rounded-xl text-sm"
                data-testid={"input-note-" + load.id}
              />
              <div className="flex shrink-0 gap-1">
                <Button
                  size="icon"
                  variant="outline"
                  className="rounded-lg"
                  onClick={() => saveNoteMutation.mutate({ id: load.id, note: editingNoteText })}
                  disabled={saveNoteMutation.isPending}
                  data-testid={"button-save-note-" + load.id}
                  title="Save note"
                >
                  <Save className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setEditingNoteId(null)}
                  data-testid={"button-cancel-note-" + load.id}
                  title="Cancel"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex max-w-xl items-center gap-2">
              <span
                className="min-w-0 truncate text-xs italic text-muted-foreground sm:text-sm"
                data-testid={"text-note-" + load.id}
              >
                {load.containerNotes || "No note"}
              </span>
              {recordChanges.allowed && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 rounded-md"
                  onClick={() => {
                    setEditingNoteId(load.id);
                    setEditingNoteText(load.containerNotes || "");
                  }}
                  data-testid={"button-edit-note-" + load.id}
                  title="Edit note"
                  aria-label={"Edit note for loading " + load.id}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 xl:justify-end">
          <PriorityScanLoadingControl
            load={{
              id: load.id,
              customerName: load.customerName || "Customer #" + load.customerId,
              proformaIdUsed: load.proformaIdUsed,
            }}
          />
          <Button
            variant="outline"
            size="icon"
            className="rounded-xl border-border bg-card"
            onClick={() => handleExport(load)}
            data-testid={"button-export-" + load.id}
            title="Export to Excel"
            aria-label={"Export loading " + load.id}
          >
            <Download className="h-4 w-4" />
          </Button>
          {recordChanges.allowed && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="rounded-xl border-border bg-card font-medium"
                onClick={() => handleOpenLink(load)}
                data-testid={"button-link-proforma-" + load.id}
                title="Link proforma"
              >
                <Link className="mr-1.5 h-4 w-4" />
                {load.proformaIdUsed ? "Change Proforma" : "Link Proforma"}
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="rounded-xl border-red-200 text-destructive hover:bg-red-50 dark:border-red-500/30 dark:hover:bg-red-950/30"
                onClick={() => handleDelete(load)}
                disabled={cancelMutation.isPending}
                data-testid={"button-delete-" + load.id}
                title="Delete loading (returns bales to stock)"
                aria-label={"Delete loading " + load.id}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
              <Button
                className="rounded-xl bg-primary px-4 font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
                onClick={() => navigate("/factory/sales/loading/new?orderId=" + load.id)}
                data-testid={"button-resume-" + load.id}
              >
                <Play className="mr-1.5 h-4 w-4" />
                Resume
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
  return {
    canStartLoading,
    closeLinkDialog,
    collapsedCustomers,
    customerCount,
    customerFilter,
    customerNames,
    deleteTarget,
    dismissUndo,
    formatDisplayDate,
    groups,
    handleConfirmDelete,
    handleConfirmLink,
    handleUndo,
    isLoading,
    linkProformaMutation,
    linkTarget,
    loads,
    navigate,
    proformas,
    proformasLoading,
    queryClient,
    renderLoadCard,
    restoreMutation,
    searchTerm,
    selectedProformaId,
    setCustomerFilter,
    setDeleteTarget,
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
