import { visibleTabInterval } from "@/lib/queryPolicies";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useLocation } from "wouter";
import {
  Clock,
  Package,
  Play,
  Trash2,
  Download,
  Link,
  X,
  Undo2,
  Pencil,
  Save,
  ChevronDown,
  ChevronRight,
  Users,
  Truck,
  Weight,
  Search,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { apiRequest, keyStartsWith } from "@/lib/queryClient";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PriorityScanLoadingControl } from "./PriorityScanLoadingControl";

const UNDO_TIMEOUT_MS = 8000;

interface PendingLoad {
  id: number;
  customerId: number;
  customerName: string;
  orderDate: string;
  totalQtyBales: number;
  totalWeightKg: string | null;
  proformaIdUsed: number | null;
  proformaName: string | null;
  locationId: number | null;
  loadingStartedAt: string | null;
  status: string;
  containerNotes: string | null;
}

function fmtKg(val: string | number | null | undefined): string {
  const n = parseFloat(String(val ?? "0"));
  if (!n) return "0 kg";
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
}

interface UndoItem {
  load: PendingLoad;
  cancelledAt: number;
  timerId: ReturnType<typeof setTimeout>;
  elapsed: number;
}

interface Proforma {
  id: number;
  name: string;
  status: string;
  customerId: number;
  createdAt: string;
  lines: Array<{ id: number; articleCode: string; productName: string; qty: number }>;
}

export default function FactoryPendingLoadings() {
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
        "group relative overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-sm transition-all hover:border-sky-400/60 hover:shadow-md dark:border-slate-700/70 dark:bg-[#0d1c33] dark:hover:border-sky-500/50 " +
        (nested
          ? "border-l-4 border-l-violet-500 dark:border-l-violet-400"
          : "border-l-4 border-l-sky-500 dark:border-l-sky-400")
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
              className="rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 font-semibold text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/20 dark:text-blue-200"
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
            className="rounded-xl border-slate-200 dark:border-slate-700 dark:bg-[#132540]"
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
                className="rounded-xl border-slate-200 bg-white font-medium dark:border-slate-700 dark:bg-[#132540]"
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
                className="rounded-xl bg-blue-600 px-4 font-semibold text-white shadow-sm shadow-blue-500/20 hover:bg-blue-500 dark:bg-blue-600 dark:hover:bg-blue-500"
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

  return (
    <div className="flex h-full flex-col gap-4 bg-gradient-to-b from-slate-50/80 via-background to-background px-3 py-4 dark:from-[#09172b] dark:via-[#081324] dark:to-background sm:px-5">
      {/* Undo banners */}
      {undoItems.length > 0 && (
        <div className="space-y-2">
          {undoItems.map((item) => {
            const elapsed = Date.now() - item.cancelledAt;
            const remaining = Math.max(0, UNDO_TIMEOUT_MS - elapsed);
            const pct = (remaining / UNDO_TIMEOUT_MS) * 100;
            return (
              <div
                key={item.load.id}
                className="relative flex flex-wrap items-center justify-between gap-3 overflow-hidden rounded-xl border border-amber-400/60 bg-amber-50 px-4 py-3 dark:bg-amber-950/40"
                data-testid={`banner-undo-${item.load.id}`}
              >
                {/* Countdown bar */}
                <div
                  className="absolute bottom-0 left-0 h-0.5 bg-amber-400 transition-none"
                  style={{ width: `${pct}%` }}
                />
                <div className="flex items-center gap-2 min-w-0">
                  <Trash2 className="h-4 w-4 text-amber-600 shrink-0" />
                  <span className="text-sm font-medium text-amber-900 dark:text-amber-100 truncate">
                    Loading #{item.load.id} ({item.load.customerName}) deleted
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-amber-400 text-amber-800 dark:text-amber-200"
                    onClick={() => handleUndo(item)}
                    disabled={restoreMutation.isPending}
                    data-testid={`button-undo-${item.load.id}`}
                  >
                    <Undo2 className="h-3.5 w-3.5 mr-1.5" />
                    Undo
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-amber-700 dark:text-amber-300"
                    onClick={() => dismissUndo(item)}
                    data-testid={`button-dismiss-undo-${item.load.id}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Pending loadings summary">
        {[
          {
            label: "Pending Loadings",
            value: loads.length.toLocaleString(),
            icon: Truck,
            accent: "text-sky-600 dark:text-sky-300",
            surface: "bg-sky-100 dark:bg-sky-500/20",
            border: "border-sky-200/70 dark:border-sky-600/30",
          },
          {
            label: "Total Bales",
            value: totalBales.toLocaleString(),
            icon: Package,
            accent: "text-cyan-600 dark:text-cyan-300",
            surface: "bg-cyan-100 dark:bg-cyan-500/20",
            border: "border-cyan-200/70 dark:border-cyan-600/30",
          },
          {
            label: "Total Weight",
            value: fmtKg(totalKg),
            icon: Weight,
            accent: "text-emerald-600 dark:text-emerald-300",
            surface: "bg-emerald-100 dark:bg-emerald-500/20",
            border: "border-emerald-200/70 dark:border-emerald-600/30",
          },
          {
            label: "Customers",
            value: customerCount.toLocaleString(),
            icon: Users,
            accent: "text-violet-600 dark:text-violet-300",
            surface: "bg-violet-100 dark:bg-violet-500/20",
            border: "border-violet-200/70 dark:border-violet-600/30",
          },
        ].map((metric) => (
          <div
            key={metric.label}
            className={
              "flex min-w-0 items-center gap-3 rounded-2xl border bg-white/90 px-4 py-3 shadow-sm dark:bg-[#10233e] " +
              metric.border
            }
          >
            <div className={"flex h-11 w-11 shrink-0 items-center justify-center rounded-xl " + metric.surface}>
              <metric.icon className={"h-5 w-5 " + metric.accent} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-xl font-bold tabular-nums tracking-tight text-foreground sm:text-2xl">
                {isLoading ? "—" : metric.value}
              </p>
              <p className="text-xs font-medium text-muted-foreground sm:text-sm">{metric.label}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border/60 bg-background/80 p-2 shadow-sm dark:bg-[#0b1b31] sm:gap-3">
        <div className="relative min-w-44 flex-1 sm:max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search customer, loading #, proforma or note..."
            className="h-10 rounded-xl border-border/80 bg-background pl-9 dark:bg-[#152842]"
            aria-label="Search pending loadings"
            data-testid="input-pending-loadings-search"
          />
        </div>
        <Select value={sortOrder} onValueChange={(value) => setSortOrder(value as "newest" | "oldest" | "bales")}>
          <SelectTrigger
            className="h-10 w-full rounded-xl sm:w-52"
            aria-label="Sort pending loadings"
            data-testid="select-pending-loadings-sort"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Started (Newest)</SelectItem>
            <SelectItem value="oldest">Started (Oldest)</SelectItem>
            <SelectItem value="bales">Most Bales</SelectItem>
          </SelectContent>
        </Select>
        <Select value={customerFilter} onValueChange={setCustomerFilter}>
          <SelectTrigger
            className="h-10 w-full rounded-xl sm:w-48"
            aria-label="Filter by customer"
            data-testid="select-pending-loadings-customer"
          >
            <SlidersHorizontal className="mr-2 h-4 w-4 shrink-0" />
            <SelectValue placeholder="All customers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All customers</SelectItem>
            {Array.from(customerNames.entries())
              .sort((a, b) => a[1].localeCompare(b[1]))
              .map(([id, name]) => (
                <SelectItem key={id} value={String(id)}>
                  {name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon"
          className="h-10 w-10 shrink-0 rounded-xl"
          title="Refresh pending loadings"
          aria-label="Refresh pending loadings"
          onClick={() => queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") })}
          data-testid="button-refresh-pending-loadings"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-2xl" />
          ))}
        </div>
      ) : loads.length === 0 && undoItems.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-background/70 py-16 text-center text-muted-foreground"
          data-testid="text-no-loads"
        >
          <Truck className="mb-4 h-14 w-14 opacity-30" />
          <p className="text-lg font-semibold">No pending loads</p>
          <p className="mt-1 max-w-md text-sm">All container loadings are either complete or not yet started.</p>
          {canStartLoading && (
            <Button
              className="mt-5 rounded-xl"
              onClick={() => navigate("/factory/sales/loading/new")}
              data-testid="button-start-new"
            >
              <Play className="mr-2 h-4 w-4" />
              Start New Loading
            </Button>
          )}
        </div>
      ) : visibleLoads.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-background/70 px-6 py-12 text-center">
          <Search className="mx-auto mb-3 h-9 w-9 text-muted-foreground/60" />
          <p className="font-semibold">No matching pending loads</p>
          <p className="mt-1 text-sm text-muted-foreground">Try a different customer or search term.</p>
          <Button
            variant="outline"
            className="mt-4 rounded-xl"
            onClick={() => {
              setCustomerFilter("all");
              setSearchTerm("");
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <div className="space-y-3" data-testid="list-pending-loadings">
          {Array.from(groups.values()).map((group) => {
            if (group.loads.length === 1) return renderLoadCard(group.loads[0]);
            const isExpanded = !collapsedCustomers.has(group.customerId);
            const groupBales = group.loads.reduce((sum, load) => sum + (load.totalQtyBales || 0), 0);
            const groupKg = group.loads.reduce(
              (sum, load) => sum + (Number.parseFloat(load.totalWeightKg || "0") || 0),
              0
            );
            return (
              <div
                key={"group-" + group.customerId}
                className="overflow-hidden rounded-2xl border border-slate-200 bg-white/80 shadow-sm dark:border-slate-700/80 dark:bg-[#10213b]"
              >
                <button
                  type="button"
                  onClick={() => toggleCustomer(group.customerId)}
                  aria-expanded={isExpanded}
                  aria-label={(isExpanded ? "Collapse " : "Expand ") + group.customerName + " loadings"}
                  className="flex w-full flex-wrap items-center justify-between gap-2 bg-gradient-to-r from-slate-100 to-blue-50/70 px-4 py-3 text-left transition-colors hover:from-blue-50 hover:to-sky-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 dark:from-[#182c49] dark:to-[#14243d] dark:hover:from-[#1b3658]"
                  data-testid={"card-group-" + group.customerId}
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-2.5">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <Users className="h-4 w-4 shrink-0 text-blue-600 dark:text-sky-300" />
                    <span className="font-bold tracking-tight" data-testid={"text-group-customer-" + group.customerId}>
                      {group.customerName}
                    </span>
                    <Badge variant="secondary" className="rounded-lg border border-border/70">
                      {group.loads.length} loadings
                    </Badge>
                  </span>
                  <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground sm:text-sm">
                    <span className="inline-flex items-center gap-1">
                      <Package className="h-3.5 w-3.5" /> {groupBales.toLocaleString()} bales total
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Weight className="h-3.5 w-3.5" /> {fmtKg(groupKg)}
                    </span>
                    <span className="hidden text-xs lg:inline">
                      {isExpanded ? "Click to collapse" : "Click to expand"}
                    </span>
                  </span>
                </button>
                {isExpanded && (
                  <div className="space-y-2 border-t border-border/70 p-2.5 sm:p-3">
                    {group.loads.map((load) => renderLoadCard(load, true))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete pending loading?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete Loading #{deleteTarget?.id} for <strong>{deleteTarget?.customerName}</strong> and return
              all {deleteTarget?.totalQtyBales} scanned bales back to stock.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete"
            >
              Delete & Return to Stock
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Link Proforma Dialog */}
      <Dialog
        open={!!linkTarget}
        onOpenChange={(open) => {
          if (!open) closeLinkDialog();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Link Proforma to Loading #{linkTarget?.id}</DialogTitle>
            <DialogDescription>
              Select a proforma for <strong>{linkTarget?.customerName}</strong> to link to this loading. The proforma
              will be used to validate scanned bales.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 max-h-[400px] overflow-y-auto py-2">
            {proformasLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : proformas.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">No proformas found for this customer.</p>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setSelectedProformaId(null)}
                  className={`w-full text-left rounded-md border p-3 transition-colors ${
                    selectedProformaId === null ? "border-primary bg-primary/5" : "border-border hover-elevate"
                  }`}
                  data-testid="option-no-proforma"
                >
                  <div className="flex items-center gap-2">
                    <X className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-muted-foreground">No proforma (unlink)</span>
                  </div>
                </button>

                {proformas.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelectedProformaId(p.id)}
                    className={`w-full text-left rounded-md border p-3 transition-colors ${
                      selectedProformaId === p.id ? "border-primary bg-primary/5" : "border-border hover-elevate"
                    }`}
                    data-testid={`option-proforma-${p.id}`}
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{p.name || `Proforma #${p.id}`}</span>
                        <Badge
                          variant={p.status === "ACTIVE" ? "default" : "secondary"}
                          className="text-xs no-default-active-elevate"
                        >
                          {p.status}
                        </Badge>
                      </div>
                      <span className="text-xs text-muted-foreground">{p.lines?.length ?? 0} lines</span>
                    </div>
                    {p.createdAt && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Created {formatDisplayDate(p.createdAt.split("T")[0])}
                      </p>
                    )}
                  </button>
                ))}
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeLinkDialog} data-testid="button-cancel-link">
              Cancel
            </Button>
            <Button
              onClick={handleConfirmLink}
              disabled={linkProformaMutation.isPending}
              data-testid="button-confirm-link"
            >
              {linkProformaMutation.isPending ? "Linking…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
