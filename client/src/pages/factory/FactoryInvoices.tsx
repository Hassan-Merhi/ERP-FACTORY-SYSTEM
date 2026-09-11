import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useState, useCallback, useRef } from "react";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLocation } from "wouter";
import { useDateFormat } from "@/contexts/DateFormatContext";
import {
  Eye,
  EyeOff,
  Trash2,
  RotateCcw,
  Download,
  FileSpreadsheet,
  FileText,
  Package,
  Container,
  ChevronRight,
  ChevronDown,
  GripVertical,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { queryClient, keyStartsWith, invalidateCustomerBalances } from "@/lib/queryClient";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { InvoiceSummaryBar } from "@/components/InvoiceSummaryBar";

import type { Customer, CustomerOrder, StatusFilter } from "./factoryinvoices/types";
import type { FactoryMyAccess } from "@shared/apiTypes";
export default function FactoryInvoices() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { formatDisplayDate } = useDateFormat();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("LOADING");
  const [customerFilter, setCustomerFilter] = useState<string>("all");
  const [expandedCustomers, setExpandedCustomers] = useState<Set<number>>(new Set());
  const [showHidden, setShowHidden] = useState(false);

  // ── Drag-to-reorder state ──────────────────────────────────────────────────
  // Keyed by statusFilter+customerFilter+showHidden so each tab view keeps its
  // own independent order.  We store an array of customerId values in the
  // desired display order.
  const [customGroupOrders, setCustomGroupOrders] = useState<Map<string, number[]>>(new Map());
  const dragIdxRef = useRef<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  const toggleCustomer = (customerId: number) => {
    setExpandedCustomers((prev) => {
      const next = new Set(prev);
      if (next.has(customerId)) next.delete(customerId);
      else next.add(customerId);
      return next;
    });
  };

  // Using fetch+blob instead of window.open() ensures auth cookies are always sent,
  // and surfaces server errors as a toast instead of leaving the browser with a 0-byte file.
  const downloadFromUrl = useCallback(
    async (url: string, fallbackName: string) => {
      try {
        const res = await fetch(url, { credentials: "include", cache: "no-store" });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ message: res.statusText }));
          toast({ title: "Download failed", description: err.message || res.statusText, variant: "destructive" });
          return;
        }
        const blob = await res.blob();
        if (blob.size === 0) {
          toast({ title: "Download failed", description: "Server returned an empty file.", variant: "destructive" });
          return;
        }
        const disposition = res.headers.get("Content-Disposition") || "";
        // Handle both  filename*=UTF-8''encoded-name  and  filename="plain-name"
        const starMatch = disposition.match(/filename\*=UTF-8''([^;\s]+)/i);
        const plainMatch = disposition.match(/filename="([^"]+)"/i);
        const rawName = starMatch ? starMatch[1] : plainMatch ? plainMatch[1] : null;
        const fileName = rawName ? decodeURIComponent(rawName) : fallbackName;
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        // Delay cleanup so Chrome has time to consume the blob URL before it is revoked.
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(blobUrl);
        }, 10000);
      } catch (e) {
        toast({
          title: "Download failed",
          description: getErrorDetails(e).message || "Network error",
          variant: "destructive",
        });
      }
    },
    [toast]
  );

  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: ["/api/factory/my-access"], staleTime: 5 * 60000 });
  const isAdmin = myAccess?.fullAccess === true;
  const hidden: string[] = myAccess?.hiddenCostFields ?? [];
  const hideProformaCol = !isAdmin || hidden.includes("hide_invoicing_proforma_col");
  const hideTotalsUsd = hidden.includes("hide_invoicing_totals_usd");

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["/api/factory/customers"],
  });

  const queryParams = new URLSearchParams();
  if (customerFilter !== "all") queryParams.set("customerId", customerFilter);
  if (showHidden) queryParams.set("showHidden", "1");
  const queryString = queryParams.toString();

  const {
    data: allOrders = [],
    isLoading,
    isError,
  } = useQuery<CustomerOrder[]>({
    queryKey: [`/api/factory/customer-orders${queryString ? `?${queryString}` : ""}`, customerFilter, showHidden],
  });

  const hideMutation = useMutation({
    mutationFn: async ({ orderId, isHidden }: { orderId: number; isHidden: boolean }) => {
      const res = await modeApiRequest("PATCH", `/api/factory/customer-orders/${orderId}/hidden`, { isHidden });
      if (!res.ok) throw new Error("Failed to update");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (orderId: number) => {
      const res = await modeApiRequest("DELETE", `/api/factory/customer-orders/${orderId}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to delete");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Deleted", description: "Invoice deleted successfully." });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      invalidateCustomerBalances();
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const unfinalizeMutation = useMutation({
    mutationFn: async (orderId: number) => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/unfinalize`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to revert invoice");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Reverted to Verified",
        description: "Invoice has been reverted. You can now edit and re-finalize it.",
      });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      invalidateCustomerBalances();
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Cannot Revert", description: error.message, variant: "destructive" });
    },
  });

  const loadingCount = allOrders.filter((o) => o.status === "LOADING").length;
  const verifiedCount = allOrders.filter((o) => o.status === "VERIFIED" || o.status === "PENDING_VERIFICATION").length;
  const finalizedCount = allOrders.filter((o) => o.status === "FINALIZED").length;

  const filteredOrders =
    statusFilter === "LOADING"
      ? allOrders.filter((o) => o.status === "LOADING")
      : statusFilter === "VERIFIED"
        ? allOrders.filter((o) => o.status === "VERIFIED" || o.status === "PENDING_VERIFICATION")
        : statusFilter === "FINALIZED"
          ? allOrders.filter((o) => o.status === "FINALIZED")
          : allOrders;

  const statusFilters: { key: StatusFilter; label: string; count: number }[] = [
    { key: "LOADING", label: "Loading", count: loadingCount },
    { key: "VERIFIED", label: "Verified", count: verifiedCount },
    { key: "FINALIZED", label: "Finalized", count: finalizedCount },
  ];

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "DRAFT":
        return <Badge variant="secondary">Draft</Badge>;
      case "LOADING":
        return (
          <Badge variant="outline" className="border-blue-300 text-blue-700 dark:border-blue-600 dark:text-blue-400">
            Loading
          </Badge>
        );
      case "PENDING_VERIFICATION":
      case "VERIFIED":
        return (
          <Badge
            variant="outline"
            className="border-green-300 text-green-700 dark:border-green-600 dark:text-green-400"
          >
            Verified
          </Badge>
        );
      case "FINALIZED":
        return <Badge variant="default">Finalized</Badge>;
      case "CANCELLED":
        return <Badge variant="destructive">Cancelled</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const handleRowClick = (order: CustomerOrder) => {
    if (order.status === "FINALIZED") {
      navigate(`/factory/sales/invoices/${order.id}`);
    } else {
      navigate(`/factory/sales/pending-invoices/${order.id}/verify`);
    }
  };

  // Per-order remaining: how many bales still needed to meet proforma target
  const getRemainingBales = (order: { proformaExpectedBales?: string; totalQtyBales: number }): number => {
    const expected = parseFloat(order.proformaExpectedBales || "0");
    if (expected <= 0) return 0;
    return Math.max(0, expected - (order.totalQtyBales || 0));
  };

  // Estimate kg and price for remaining bales using the order's average
  const getEstimatedKg = (order: { totalQtyBales: number; totalWeightKg: string }, bales: number): number => {
    const loaded = order.totalQtyBales || 0;
    if (loaded <= 0) return 0;
    const avgWeight = parseFloat(order.totalWeightKg || "0") / loaded;
    return bales * avgWeight;
  };

  const getEstimatedPrice = (order: { totalQtyBales: number; grandTotal: string }, bales: number): number => {
    const loaded = order.totalQtyBales || 0;
    if (loaded <= 0) return 0;
    const avgPrice = parseFloat(order.grandTotal || "0") / loaded;
    return bales * avgPrice;
  };

  // Column count for colspan calculations
  // +1 for the drag-handle column
  const colCount = 12 - (hideProformaCol ? 1 : 0) - (hideTotalsUsd ? 1 : 0);

  const fmtKg = (val: string | number | null | undefined) => {
    const n = parseFloat(String(val ?? "0"));
    if (!n) return <span className="text-muted-foreground/40">—</span>;
    return <>{n.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg</>;
  };

  // Group orders by customer, preserving first-appearance order
  const customerGroups = (() => {
    const seen = new Map<number, { customerId: number; customerName: string; orders: CustomerOrder[] }>();
    for (const order of filteredOrders) {
      if (!seen.has(order.customerId)) {
        seen.set(order.customerId, { customerId: order.customerId, customerName: order.customerName, orders: [] });
      }
      seen.get(order.customerId)!.orders.push(order);
    }
    return Array.from(seen.values());
  })();

  // Apply any custom drag-to-reorder order for the current tab/filter combo
  const groupOrderKey = `${statusFilter}__${customerFilter}__${showHidden}`;
  const orderedCustomerGroups = (() => {
    const customOrder = customGroupOrders.get(groupOrderKey);
    if (!customOrder || customOrder.length === 0) return customerGroups;
    const groupMap = new Map(customerGroups.map((g) => [g.customerId, g]));
    const reordered = customOrder.flatMap((id) => {
      const g = groupMap.get(id);
      return g ? [g] : [];
    });
    const inOrder = new Set(customOrder);
    const extras = customerGroups.filter((g) => !inOrder.has(g.customerId));
    return [...reordered, ...extras];
  })();

  // Drag handlers (group-level reordering)
  const handleDragStart = (idx: number) => {
    dragIdxRef.current = idx;
  };
  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setDropIdx(idx);
  };
  const handleDrop = (toIdx: number) => {
    const fromIdx = dragIdxRef.current;
    if (fromIdx === null || fromIdx === toIdx) {
      dragIdxRef.current = null;
      setDropIdx(null);
      return;
    }
    const ids = orderedCustomerGroups.map((g) => g.customerId);
    const [moved] = ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, moved);
    setCustomGroupOrders((prev) => new Map(prev).set(groupOrderKey, ids));
    dragIdxRef.current = null;
    setDropIdx(null);
  };
  const handleDragEnd = () => {
    dragIdxRef.current = null;
    setDropIdx(null);
  };

  return (
    <div className="flex flex-col h-full p-5 gap-4">
      {isError && (
        <div
          className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          data-testid="error-invoices-load"
        >
          Failed to load data. Please check your connection or try refreshing the page.
        </div>
      )}

      <div className="rounded-xl border overflow-hidden flex flex-col">
        {/* Toolbar strip */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b bg-muted/20">
          <div className="flex flex-wrap items-center gap-1.5" data-testid="filter-tabs">
            {statusFilters.map((f) => (
              <Button
                key={f.key}
                variant={statusFilter === f.key ? "default" : "outline"}
                size="sm"
                onClick={() => setStatusFilter(f.key)}
                data-testid={`button-filter-${f.key.toLowerCase()}`}
                className="text-xs px-3"
              >
                {f.label} <span className="ml-1 opacity-70">({f.count})</span>
              </Button>
            ))}
            <Button
              variant={statusFilter === "ALL" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setStatusFilter("ALL")}
              data-testid="button-filter-all"
              className="text-xs px-3 text-muted-foreground"
            >
              All ({allOrders.length})
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant={showHidden ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setShowHidden((v) => !v)}
              data-testid="button-toggle-show-hidden"
              className="text-xs px-3 gap-1.5"
              title={showHidden ? "Hide hidden loadings" : "Show hidden loadings"}
            >
              {showHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              {showHidden ? "Showing hidden" : "Show hidden"}
            </Button>
            <div className="w-52">
              <Select value={customerFilter} onValueChange={setCustomerFilter}>
                <SelectTrigger data-testid="select-customer-filter">
                  <SelectValue placeholder="All customers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Customers</SelectItem>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id.toString()} data-testid={`select-customer-option-${c.id}`}>
                      {c.legalName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Summary bar */}
        {!isLoading && filteredOrders.length > 0 && (
          <div className="px-4 pt-3 pb-0">
            <InvoiceSummaryBar
              orders={filteredOrders}
              hideTotalsUsd={hideTotalsUsd}
              getRemainingBales={getRemainingBales}
              getEstimatedKg={getEstimatedKg}
              getEstimatedPrice={getEstimatedPrice}
            />
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3 p-4">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted hover:bg-muted border-b-2 border-border/60">
                  {/* Drag handle column */}
                  <TableHead className="w-7 px-1" />
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Customer
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Loading #
                  </TableHead>
                  {!hideProformaCol && (
                    <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Proforma
                    </TableHead>
                  )}
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Container
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Destination
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Notes
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Date
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Status
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Bales
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Weight
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Remaining
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Extras
                  </TableHead>
                  {!hideTotalsUsd && (
                    <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Total
                    </TableHead>
                  )}
                  <TableHead className="w-[120px] text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customerGroups.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={colCount}
                      className="text-center text-muted-foreground py-8"
                      data-testid="text-no-orders"
                    >
                      <div className="flex flex-col items-center gap-2">
                        <Package className="h-10 w-10 opacity-40" />
                        <p>No invoices found</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  orderedCustomerGroups.map((group, groupIdx) => {
                    const isSingle = group.orders.length === 1;
                    const isExpanded = expandedCustomers.has(group.customerId);
                    const isDragging = dragIdxRef.current === groupIdx;
                    const isDropTarget =
                      dropIdx === groupIdx && dragIdxRef.current !== null && dragIdxRef.current !== groupIdx;

                    const renderOrderRow = (order: CustomerOrder, indented = false) => {
                      const remaining = getRemainingBales(order);
                      const expected = parseFloat(order.proformaExpectedBales || "0");
                      const overloaded = expected > 0 ? Math.max(0, (order.totalQtyBales || 0) - expected) : 0;
                      return (
                        <TableRow
                          key={order.id}
                          className={`cursor-pointer ${order.isHidden ? "opacity-50" : ""} ${
                            !indented && isDropTarget ? "border-t-2 border-primary" : ""
                          } ${!indented && isDragging ? "opacity-40" : ""}`}
                          draggable={!indented}
                          onDragStart={!indented ? () => handleDragStart(groupIdx) : undefined}
                          onDragOver={!indented ? (e) => handleDragOver(e, groupIdx) : undefined}
                          onDrop={!indented ? () => handleDrop(groupIdx) : undefined}
                          onDragEnd={!indented ? handleDragEnd : undefined}
                          onClick={() => handleRowClick(order)}
                          data-testid={`row-order-${order.id}`}
                        >
                          {/* Drag handle — only for top-level (non-indented) rows */}
                          <TableCell className="w-7 px-1" onClick={(e) => e.stopPropagation()}>
                            {!indented && (
                              <GripVertical className="h-4 w-4 text-muted-foreground/30 hover:text-muted-foreground cursor-grab active:cursor-grabbing" />
                            )}
                          </TableCell>
                          <TableCell data-testid={`text-customer-name-${order.id}`}>
                            {indented ? (
                              <span className="pl-5 text-muted-foreground/50 text-xs">↳</span>
                            ) : (
                              order.customerName
                            )}
                          </TableCell>
                          <TableCell
                            className="font-mono text-sm text-muted-foreground"
                            data-testid={`text-loading-number-${order.id}`}
                          >
                            #{order.id}
                          </TableCell>
                          {!hideProformaCol && (
                            <TableCell
                              className="text-sm text-muted-foreground"
                              data-testid={`text-proforma-${order.id}`}
                            >
                              {order.proformaName || <span className="text-muted-foreground/50">—</span>}
                            </TableCell>
                          )}
                          <TableCell className="font-mono text-sm" data-testid={`text-container-${order.id}`}>
                            {order.containerNumber || <span className="text-muted-foreground/50">—</span>}
                          </TableCell>
                          <TableCell className="text-sm" data-testid={`text-destination-${order.id}`}>
                            {order.destination || <span className="text-muted-foreground/50">—</span>}
                          </TableCell>
                          <TableCell
                            className="text-sm max-w-[200px] truncate"
                            data-testid={`text-notes-${order.id}`}
                            title={order.containerNotes ?? undefined}
                          >
                            {order.containerNotes || <span className="text-muted-foreground/50">—</span>}
                          </TableCell>
                          <TableCell className="font-mono text-sm" data-testid={`text-order-date-${order.id}`}>
                            {order.orderDate ? formatDisplayDate(order.orderDate) : "-"}
                          </TableCell>
                          <TableCell>{getStatusBadge(order.status)}</TableCell>
                          <TableCell className="text-right font-mono" data-testid={`text-total-bales-${order.id}`}>
                            {order.totalQtyBales ?? "-"}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm" data-testid={`text-weight-${order.id}`}>
                            {fmtKg(order.totalWeightKg)}
                          </TableCell>
                          <TableCell className="text-right font-mono" data-testid={`text-remaining-${order.id}`}>
                            {expected <= 0 ? (
                              <span className="text-muted-foreground/40">—</span>
                            ) : remaining > 0 ? (
                              <span className="text-red-600 dark:text-red-400 font-medium">{remaining}</span>
                            ) : overloaded > 0 ? (
                              <span className="text-amber-600 dark:text-amber-400 font-medium">+{overloaded}</span>
                            ) : (
                              <span className="text-green-600 dark:text-green-400 font-medium">Done</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm" data-testid={`text-extras-${order.id}`}>
                            {parseFloat(order.freightAmount || "0") <= 0 &&
                            parseFloat(order.otherChargesTotal || "0") <= 0 ? (
                              <span className="text-muted-foreground/40">—</span>
                            ) : (
                              <div className="flex flex-col items-end gap-0.5">
                                {parseFloat(order.freightAmount || "0") > 0 && (
                                  <span className="text-blue-600 dark:text-blue-400">
                                    $
                                    {parseFloat(order.freightAmount).toLocaleString(undefined, {
                                      minimumFractionDigits: 0,
                                      maximumFractionDigits: 2,
                                    })}
                                    <span className="text-muted-foreground/60 text-xs ml-1">freight</span>
                                  </span>
                                )}
                                {parseFloat(order.otherChargesTotal || "0") > 0 && (
                                  <span className="text-purple-600 dark:text-purple-400">
                                    $
                                    {parseFloat(order.otherChargesTotal).toLocaleString(undefined, {
                                      minimumFractionDigits: 0,
                                      maximumFractionDigits: 2,
                                    })}
                                    <span className="text-muted-foreground/60 text-xs ml-1">other</span>
                                  </span>
                                )}
                              </div>
                            )}
                          </TableCell>
                          {!hideTotalsUsd && (
                            <TableCell
                              className="text-right font-mono font-semibold"
                              data-testid={`text-grand-total-${order.id}`}
                            >
                              $
                              {parseFloat(order.grandTotal || "0").toLocaleString(undefined, {
                                minimumFractionDigits: 0,
                                maximumFractionDigits: 2,
                              })}
                            </TableCell>
                          )}
                          <TableCell>
                            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                              <Button
                                variant="ghost"
                                size="icon"
                                title={order.isHidden ? "Unhide loading" : "Hide loading"}
                                data-testid={`button-hide-order-${order.id}`}
                                onClick={() => hideMutation.mutate({ orderId: order.id, isHidden: !order.isHidden })}
                              >
                                {order.isHidden ? (
                                  <Eye className="h-4 w-4 text-muted-foreground" />
                                ) : (
                                  <EyeOff className="h-4 w-4 text-muted-foreground" />
                                )}
                              </Button>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    data-testid={`button-download-${order.id}`}
                                    title="Download Invoice"
                                  >
                                    <Download className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    onClick={() =>
                                      downloadFromUrl(
                                        `/api/factory/customer-orders/${order.id}/export/excel`,
                                        "invoice.xlsx"
                                      )
                                    }
                                    data-testid={`button-download-excel-${order.id}`}
                                  >
                                    <FileSpreadsheet className="h-4 w-4 mr-2" />
                                    Excel
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() =>
                                      downloadFromUrl(
                                        `/api/factory/customer-orders/${order.id}/export-excel?noCharges=1`,
                                        "invoice-no-charges.xlsx"
                                      )
                                    }
                                    data-testid={`button-download-excel-no-charges-${order.id}`}
                                  >
                                    <FileSpreadsheet className="h-4 w-4 mr-2" />
                                    Excel (No Charges)
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() =>
                                      downloadFromUrl(
                                        `/api/factory/customer-orders/${order.id}/export-pdf`,
                                        "invoice.pdf"
                                      )
                                    }
                                    data-testid={`button-download-pdf-${order.id}`}
                                  >
                                    <FileText className="h-4 w-4 mr-2" />
                                    PDF
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() =>
                                      downloadFromUrl(
                                        `/api/factory/customer-orders/${order.id}/export-pdf?noCharges=1`,
                                        "invoice-no-charges.pdf"
                                      )
                                    }
                                    data-testid={`button-download-pdf-no-charges-${order.id}`}
                                  >
                                    <FileText className="h-4 w-4 mr-2" />
                                    PDF (No Charges)
                                  </DropdownMenuItem>
                                  {isAdmin && (
                                    <DropdownMenuItem
                                      onClick={() =>
                                        downloadFromUrl(
                                          `/api/factory/customer-orders/${order.id}/loading-status-export`,
                                          "loading-status.xlsx"
                                        )
                                      }
                                      data-testid={`button-download-loading-status-${order.id}`}
                                    >
                                      <Container className="h-4 w-4 mr-2" />
                                      Loading Status + Bale Refs
                                    </DropdownMenuItem>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleRowClick(order)}
                                data-testid={`button-view-order-${order.id}`}
                              >
                                <Eye className="h-4 w-4" />
                              </Button>
                              {order.status === "FINALIZED" && (
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      disabled={unfinalizeMutation.isPending}
                                      data-testid={`button-revert-order-${order.id}`}
                                    >
                                      <RotateCcw className="h-4 w-4 text-muted-foreground" />
                                    </Button>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>Revert to Verified</AlertDialogTitle>
                                      <AlertDialogDescription>
                                        This will revert invoice {order.invoiceNumber} for {order.customerName} back to
                                        Verified status. The invoice number will be voided, all bales will return to
                                        stock, and the customer balance entry will be removed. This cannot be done if
                                        any payment has been recorded against this invoice.
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel data-testid={`button-cancel-revert-${order.id}`}>
                                        Cancel
                                      </AlertDialogCancel>
                                      <AlertDialogAction
                                        onClick={() => unfinalizeMutation.mutate(order.id)}
                                        data-testid={`button-confirm-revert-${order.id}`}
                                      >
                                        Revert to Verified
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              )}
                              {order.status !== "FINALIZED" && (
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <Button variant="ghost" size="icon" data-testid={`button-delete-order-${order.id}`}>
                                      <Trash2 className="h-4 w-4 text-destructive" />
                                    </Button>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>Delete Invoice</AlertDialogTitle>
                                      <AlertDialogDescription>
                                        This will permanently delete invoice {order.invoiceNumber || `#${order.id}`} for{" "}
                                        {order.customerName}. Any bales assigned to this order will be returned to
                                        stock. This cannot be undone.
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel data-testid={`button-cancel-delete-${order.id}`}>
                                        Cancel
                                      </AlertDialogCancel>
                                      <AlertDialogAction
                                        onClick={() => deleteMutation.mutate(order.id)}
                                        data-testid={`button-confirm-delete-${order.id}`}
                                      >
                                        Delete
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    };

                    if (isSingle) return renderOrderRow(group.orders[0], false);

                    // Multi-loading: summary row + expandable children
                    const totalBales = group.orders.reduce((s, o) => s + (o.totalQtyBales || 0), 0);
                    const totalWeightKg = group.orders.reduce((s, o) => s + parseFloat(o.totalWeightKg || "0"), 0);
                    const totalRemaining = group.orders.reduce((s, o) => s + getRemainingBales(o), 0);
                    const totalOverloaded = group.orders.reduce((s, o) => {
                      const exp = parseFloat(o.proformaExpectedBales || "0");
                      return s + (exp > 0 ? Math.max(0, (o.totalQtyBales || 0) - exp) : 0);
                    }, 0);
                    const totalAmount = group.orders.reduce((s, o) => s + parseFloat(o.grandTotal || "0"), 0);

                    return (
                      <>
                        {/* Group summary row */}
                        <TableRow
                          key={`group-${group.customerId}`}
                          className={`cursor-pointer bg-muted/40 font-medium ${
                            isDropTarget ? "border-t-2 border-primary" : ""
                          } ${isDragging ? "opacity-40" : ""}`}
                          draggable
                          onDragStart={() => handleDragStart(groupIdx)}
                          onDragOver={(e) => handleDragOver(e, groupIdx)}
                          onDrop={() => handleDrop(groupIdx)}
                          onDragEnd={handleDragEnd}
                          onClick={() => toggleCustomer(group.customerId)}
                          data-testid={`row-group-${group.customerId}`}
                        >
                          {/* Drag handle */}
                          <TableCell className="w-7 px-1" onClick={(e) => e.stopPropagation()}>
                            <GripVertical className="h-4 w-4 text-muted-foreground/30 hover:text-muted-foreground cursor-grab active:cursor-grabbing" />
                          </TableCell>
                          <TableCell data-testid={`text-group-customer-${group.customerId}`}>
                            <div className="flex items-center gap-2">
                              {isExpanded ? (
                                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                              )}
                              <span>{group.customerName}</span>
                              <Badge variant="outline" className="text-xs font-normal">
                                {group.orders.length} loadings
                              </Badge>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">—</TableCell>
                          {!hideProformaCol && <TableCell />}
                          <TableCell />
                          <TableCell />
                          <TableCell />
                          <TableCell />
                          <TableCell />
                          <TableCell className="text-right font-mono">{totalBales}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{fmtKg(totalWeightKg)}</TableCell>
                          <TableCell className="text-right font-mono">
                            {totalRemaining > 0 ? (
                              <span className="text-red-600 dark:text-red-400">{totalRemaining}</span>
                            ) : totalOverloaded > 0 ? (
                              <span className="text-amber-600 dark:text-amber-400">+{totalOverloaded}</span>
                            ) : (
                              <span className="text-green-600 dark:text-green-400">Done</span>
                            )}
                          </TableCell>
                          <TableCell />
                          {!hideTotalsUsd && (
                            <TableCell className="text-right font-mono">
                              $
                              {totalAmount.toLocaleString(undefined, {
                                minimumFractionDigits: 0,
                                maximumFractionDigits: 2,
                              })}
                            </TableCell>
                          )}
                          <TableCell />
                        </TableRow>
                        {/* Expanded individual rows */}
                        {isExpanded && group.orders.map((order) => renderOrderRow(order, true))}
                      </>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
