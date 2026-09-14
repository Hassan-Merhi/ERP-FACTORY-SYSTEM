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
import { Eye, EyeOff, Package } from "lucide-react";
import { queryClient, keyStartsWith, invalidateCustomerBalances } from "@/lib/queryClient";
import { InvoiceSummaryBar } from "@/components/InvoiceSummaryBar";

import type { Customer, CustomerOrder, StatusFilter } from "./factoryinvoices/types";
import type { FactoryMyAccess } from "@shared/apiTypes";
import {
  applyCustomGroupOrder,
  filterOrdersByStatus,
  getEstimatedKg,
  getEstimatedPrice,
  getRemainingBales,
  groupOrdersByCustomer,
  statusFilterCounts,
} from "./factoryinvoices/invoiceCalculations";
import { InvoiceGroupRow } from "./factoryinvoices/InvoiceGroupRow";
import { InvoiceOrderRow } from "./factoryinvoices/InvoiceOrderRow";

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

  const { loading: loadingCount, verified: verifiedCount, finalized: finalizedCount } = statusFilterCounts(allOrders);

  const filteredOrders = filterOrdersByStatus(allOrders, statusFilter);

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
  const colCount = 12 - (hideProformaCol ? 1 : 0) - (hideTotalsUsd ? 1 : 0);

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
    hideProformaCol,
    hideTotalsUsd,
    formatDisplayDate,
    getStatusBadge,
    onRowClick: handleRowClick,
    onToggleHideOrder: (order: CustomerOrder) => hideMutation.mutate({ orderId: order.id, isHidden: !order.isHidden }),
    onDownload: downloadFromUrl,
    isAdmin,
    unfinalizePending: unfinalizeMutation.isPending,
    onRevertOrder: (orderId: number) => unfinalizeMutation.mutate(orderId),
    onDeleteOrder: (orderId: number) => deleteMutation.mutate(orderId),
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
      </div>
    </div>
  );
}
