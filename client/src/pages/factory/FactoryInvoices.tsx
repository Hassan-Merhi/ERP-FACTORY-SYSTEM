import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
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
import { Eye, EyeOff, Package, Search, SlidersHorizontal, ChevronDown, CalendarDays, Filter } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { InvoiceDashboardMetrics } from "./factoryinvoices/InvoiceDashboardMetrics";
import { queryClient, keyStartsWith, invalidateCustomerBalances } from "@/lib/queryClient";
import { InvoiceSummaryBar } from "@/components/InvoiceSummaryBar";

import type { Customer, CustomerOrder, StatusFilter } from "./factoryinvoices/types";
import type { FactoryMyAccess, AuthMe } from "@shared/apiTypes";
import {
  applyCustomGroupOrder,
  filterOrdersByStatus,
  getEstimatedKg,
  getEstimatedPrice,
  getRemainingBales,
  getFactoryInvoiceDate,
  groupOrdersByCustomer,
  statusFilterCounts,
} from "./factoryinvoices/invoiceCalculations";
import { InvoiceGroupRow } from "./factoryinvoices/InvoiceGroupRow";
import { InvoiceOrderRow, type EditableShippingField } from "./factoryinvoices/InvoiceOrderRow";
import { ShippingAvailabilityTable } from "./factoryshippingcontainers/components/ShippingAvailabilityTable";
import { ScheduledContainersTable } from "./factoryshippingcontainers/components/ScheduledContainersTable";

export default function FactoryInvoices() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { formatDisplayDate } = useDateFormat();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("LOADING");
  const [customerFilter, setCustomerFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [compactView, setCompactView] = useState(true);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [changingCustomerOrderId, setChangingCustomerOrderId] = useState<number | null>(null);
  const [newCustomerId, setNewCustomerId] = useState<string>("");
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
  const { data: authUser } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"], staleTime: 5 * 60000 });
  const showBookingInfo = ["admin", "owner", "developer"].includes(
    String(authUser?.currentRole || authUser?.role || "").toLowerCase()
  );
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

  const changeCustomerMutation = useMutation({
    mutationFn: async ({ orderId, customerId }: { orderId: number; customerId: number }) => {
      const response = await modeApiRequest("PATCH", `/api/factory/customer-orders/${orderId}/change-customer`, { customerId });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || "Could not change loading customer");
      }
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Customer changed", description: "Loading and bales preserved. Old customer proforma unlinked." });
      setChangingCustomerOrderId(null);
      setNewCustomerId("");
      setCustomerFilter("all");
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      invalidateCustomerBalances();
    },
    onError: (error: Error) => toast({ title: "Cannot change customer", description: error.message, variant: "destructive" }),
  });

  // Update the canonical order record, not a display-only copy. All linked
  // factory pages get invalidated so they read the latest shipping metadata.
  const shippingFieldMutation = useMutation({
    mutationFn: async ({ orderId, field, value }: { orderId: number; field: EditableShippingField; value: string }) => {
      const response = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/assign-container`, {
        [field]: value,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || "Could not update container details");
      }
      return response.json();
    },
    onSuccess: (_saved, { orderId, field, value }) => {
      // Update cached list/detail rows immediately, even if the browser still
      // has the GET response in its short HTTP cache.
      queryClient.setQueriesData({ predicate: keyStartsWith("/api/factory/customer-orders") }, (cached: unknown) => {
        const applyEdit = (order: CustomerOrder) =>
          order.id === orderId ? { ...order, [field]: value || null } : order;
        if (Array.isArray(cached)) return cached.map((item) => applyEdit(item as CustomerOrder));
        if (cached && typeof cached === "object" && "id" in cached) return applyEdit(cached as CustomerOrder);
        return cached;
      });
      for (const prefix of [
        "/api/factory/customer-orders",
        "/api/factory/shipping-container",
        "/api/factory/invoice-container-tracking",
        "/api/factory/invoices",
      ]) {
        queryClient.invalidateQueries({ predicate: keyStartsWith(prefix) });
      }
      toast({ title: "Container details updated", description: "Changes saved to the linked loading." });
    },
    onError: (error: Error) => {
      toast({ title: "Could not save container details", description: error.message, variant: "destructive" });
    },
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
      toast({ title: "Loading deleted", description: "Eligible bales returned to available stock. The loading can be found in Deleted Items." });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/stock") });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/bales") });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/locations") });
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
        title: "Invoice reverted successfully",
        description: "The original workflow stage has been restored.",
      });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      invalidateCustomerBalances();
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Cannot Revert", description: error.message, variant: "destructive" });
    },
  });

  // KPIs, tabs and table use the same search and business-date scope.
  const scopedOrders = allOrders.filter((order) => {
    const needle = searchTerm.trim().toLowerCase();
    if (needle && ![
      order.customerName, order.invoiceNumber, String(order.id),
      order.proformaName, order.containerNumber, order.destination,
    ].some((value) => (value || "").toLowerCase().includes(needle))) return false;
    const day = (getFactoryInvoiceDate(order) || "").slice(0, 10);
    if (fromDate && (!day || day < fromDate)) return false;
    if (toDate && (!day || day > toDate)) return false;
    return true;
  });
  const { loading: loadingCount, verified: verifiedCount, finalized: finalizedCount } = statusFilterCounts(scopedOrders);
  const filteredOrders = filterOrdersByStatus(scopedOrders, statusFilter);

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

  // Column count for colspan calculations
  // +1 for the drag-handle column
  const colCount = 16 - (hideProformaCol ? 1 : 0) - (hideTotalsUsd ? 1 : 0) - (showBookingInfo ? 0 : 1)
    - (compactView ? 2 + (showBookingInfo ? 1 : 0) + (hideTotalsUsd ? 0 : 1) : 0);

  // Group orders by customer, preserving first-appearance order
  const customerGroups = groupOrdersByCustomer(filteredOrders);

  // Apply any custom drag-to-reorder order for the current tab/filter combo
  const groupOrderKey = `${statusFilter}__${customerFilter}__${showHidden}`;
  const orderedCustomerGroups = applyCustomGroupOrder(customerGroups, customGroupOrders.get(groupOrderKey) ?? []);

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

  const orderRowContext = {
    compactView,
    hideProformaCol,
    showBookingInfo,
    hideTotalsUsd,
    formatDisplayDate,
    getStatusBadge,
    onRowClick: handleRowClick,
    onToggleHideOrder: (order: CustomerOrder) => hideMutation.mutate({ orderId: order.id, isHidden: !order.isHidden }),
    onDownload: downloadFromUrl,
    onSaveShippingField: async (orderId: number, field: EditableShippingField, value: string) => {
      await shippingFieldMutation.mutateAsync({ orderId, field, value });
    },
    isAdmin,
    unfinalizePending: unfinalizeMutation.isPending,
    onRevertOrder: (orderId: number) => unfinalizeMutation.mutate(orderId),
    onDeleteOrder: (orderId: number) => deleteMutation.mutate(orderId),
    onChangeCustomer: (orderId: number) => { setChangingCustomerOrderId(orderId); setNewCustomerId(""); },
  };

  return (
    <div className="flex min-w-0 flex-col gap-3 p-3 sm:p-4" data-testid="invoicing-modern-dashboard">
      <Dialog open={changingCustomerOrderId !== null} onOpenChange={(open) => { if (!open) setChangingCustomerOrderId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change loading customer</DialogTitle>
            <DialogDescription>
              Keep all existing loaded bales and container information. The current customer's proforma will be unlinked; select a new proforma afterward if needed.
            </DialogDescription>
          </DialogHeader>
          <Select value={newCustomerId} onValueChange={setNewCustomerId}>
            <SelectTrigger data-testid="select-new-loading-customer"><SelectValue placeholder="Choose new customer" /></SelectTrigger>
            <SelectContent>
              {customers.map((customer) => (
                <SelectItem key={customer.id} value={String(customer.id)}>{customer.legalName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setChangingCustomerOrderId(null)}>Cancel</Button>
            <Button disabled={!newCustomerId || changeCustomerMutation.isPending} onClick={() => {
              if (changingCustomerOrderId !== null && newCustomerId) {
                changeCustomerMutation.mutate({ orderId: changingCustomerOrderId, customerId: Number(newCustomerId) });
              }
            }}>Save customer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {isError && (
        <div
          className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          data-testid="error-invoices-load"
        >
          Failed to load data. Please check your connection or try refreshing the page.
        </div>
      )}

      {!isLoading && <InvoiceDashboardMetrics orders={scopedOrders} hideTotalsUsd={hideTotalsUsd} />}
      <div className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm dark:bg-[#0e1a2b]">
        {/* Toolbar strip */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-border/60 bg-blue-500/[0.025] px-3 py-3">
          <div className="flex flex-wrap items-center gap-1.5" data-testid="filter-tabs">
            {statusFilters.map((f) => (
              <Button
                key={f.key}
                variant={statusFilter === f.key ? "default" : "outline"}
                size="sm"
                onClick={() => setStatusFilter(f.key)}
                data-testid={`button-filter-${f.key.toLowerCase()}`}
                className={cn("h-9 rounded-lg border px-3 text-xs font-semibold", statusFilter === f.key && (
                  f.key === "LOADING" ? "border-blue-500 bg-blue-600 text-white hover:bg-blue-500"
                    : f.key === "VERIFIED" ? "border-emerald-500 bg-emerald-600 text-white hover:bg-emerald-500"
                      : "border-violet-500 bg-violet-600 text-white hover:bg-violet-500"
                ))}
              >
                {f.label} <span className="ml-1 opacity-70">({f.count})</span>
              </Button>
            ))}
            <Button
              variant={statusFilter === "ALL" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setStatusFilter("ALL")}
              data-testid="button-filter-all"
              className="h-9 rounded-lg border px-3 text-xs font-semibold"
            >
              All ({scopedOrders.length})
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant={showHidden ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setShowHidden((v) => !v)}
              data-testid="button-toggle-show-hidden"
              className="h-9 rounded-lg px-3 text-xs gap-1.5"
              title={showHidden ? "Hide hidden loadings" : "Show hidden loadings"}
            >
              {showHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              {showHidden ? "Showing hidden" : "Show hidden"}
            </Button>
            <div className="w-44 sm:w-48">
              <Select value={customerFilter} onValueChange={setCustomerFilter}>
                <SelectTrigger className="h-9 rounded-lg text-xs" data-testid="select-customer-filter">
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

        {/* Search and column controls retain all existing invoice actions. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2.5">
          <div className="relative min-w-[210px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search customer, loading, container, destination..."
              className="h-9 rounded-lg border-border/70 bg-background/80 pl-9 text-xs"
              data-testid="input-invoice-search"
            />
          </div>
          <Button
            size="sm"
            variant={showMoreFilters || fromDate || toDate ? "secondary" : "outline"}
            className="h-9 rounded-lg text-xs"
            onClick={() => setShowMoreFilters((value) => !value)}
            aria-expanded={showMoreFilters}
            data-testid="button-invoice-more-filters"
          >
            <Filter className="mr-1.5 h-3.5 w-3.5" /> More Filters
            <ChevronDown className={cn("ml-1.5 h-3.5 w-3.5 transition-transform", showMoreFilters && "rotate-180")} />
          </Button>
          <Button
            size="sm"
            variant={compactView ? "outline" : "secondary"}
            className="h-9 rounded-lg text-xs"
            onClick={() => setCompactView((value) => !value)}
            aria-pressed={!compactView}
            title={compactView ? "Show all invoice columns" : "Use compact invoice columns"}
            data-testid="button-invoice-columns"
          >
            <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" /> {compactView ? "All Columns" : "Compact"}
          </Button>
        </div>
        {showMoreFilters && (
          <div className="flex flex-wrap items-end gap-3 border-b border-border/60 bg-muted/20 px-3 py-3">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" /> From date</span>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
                className="h-9 w-40 rounded-lg bg-background text-xs" data-testid="input-invoice-from-date" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>To date</span>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
                className="h-9 w-40 rounded-lg bg-background text-xs" data-testid="input-invoice-to-date" />
            </label>
            <Button variant="ghost" size="sm" className="h-9 rounded-lg text-xs"
              onClick={() => { setFromDate(""); setToDate(""); setSearchTerm(""); }} data-testid="button-reset-invoice-filters">
              Clear dates / search
            </Button>
          </div>
        )}

        {/* Summary bar */}
        {!isLoading && filteredOrders.length > 0 && (
          <details className="group border-b border-border/60 bg-muted/[0.06]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/20">
              <span className="inline-flex items-center gap-2">
                <ChevronDown className="h-3.5 w-3.5 -rotate-90 transition-transform group-open:rotate-0" />
                Loading analysis · {filteredOrders.length} orders
              </span>
              <span className="text-[11px] font-normal">Bales, weight and remaining</span>
            </summary>
            <div className="px-3 pt-2">
              <InvoiceSummaryBar
              orders={filteredOrders}
              hideTotalsUsd={hideTotalsUsd}
              getRemainingBales={getRemainingBales}
              getEstimatedKg={getEstimatedKg}
              getEstimatedPrice={getEstimatedPrice}
              />
            </div>
          </details>
        )}

        {isLoading ? (
          <div className="space-y-3 p-4">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="text-xs [&_td]:px-2.5 [&_td]:py-2 [&_th]:h-10 [&_th]:px-2.5 [&_th]:py-2">
              <TableHeader>
                <TableRow className="border-b-2 border-border/60 bg-slate-100/80 hover:bg-slate-100/80 dark:bg-[#172940] dark:hover:bg-[#172940]">
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
                  {showBookingInfo && !compactView && (
                    <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Booking Info
                    </TableHead>
                  )}
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Destination
                  </TableHead>
                  {!compactView && <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Notes
                  </TableHead>}
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
                  {!compactView && <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Extras
                  </TableHead>}
                  {!hideTotalsUsd && !compactView && (
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

                    if (isSingle) {
                      return (
                        <InvoiceOrderRow
                          key={group.orders[0].id}
                          order={group.orders[0]}
                          indented={false}
                          isDropTarget={isDropTarget}
                          isDragging={isDragging}
                          onDragStart={() => handleDragStart(groupIdx)}
                          onDragOver={(e) => handleDragOver(e, groupIdx)}
                          onDrop={() => handleDrop(groupIdx)}
                          onDragEnd={handleDragEnd}
                          {...orderRowContext}
                        />
                      );
                    }

                    return (
                      <InvoiceGroupRow
                        key={`group-${group.customerId}`}
                        group={group}
                        isExpanded={isExpanded}
                        isDropTarget={isDropTarget}
                        isDragging={isDragging}
                        onToggleExpand={toggleCustomer}
                        onDragStart={() => handleDragStart(groupIdx)}
                        onDragOver={(e) => handleDragOver(e, groupIdx)}
                        onDrop={() => handleDrop(groupIdx)}
                        onDragEnd={handleDragEnd}
                        {...orderRowContext}
                      />
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Scheduled containers above existing container availability */}
        <div className="space-y-3 border-t border-border/60 bg-muted/[0.04] px-3 py-3">
          <ScheduledContainersTable />
          <ShippingAvailabilityTable />
        </div>
      </div>
    </div>
  );
}
