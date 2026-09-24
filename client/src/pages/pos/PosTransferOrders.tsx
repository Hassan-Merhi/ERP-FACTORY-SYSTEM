import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { PageHeader } from "@/components/PageHeader";
import { CheckCircle2, Search, X, ArrowRight, Clock, Package2, Eye, Pencil, CalendarIcon, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import type { PosTransferOrdersProps, TransferSummary } from "./postransferorders/types";
import { formatDate } from "./postransferorders/utils";
import { TransferOrderDetail } from "./postransferorders/components/TransferOrderDetail";
import { CreateTransferDialog } from "./postransferorders/components/CreateTransferDialog";
import { ViewTransferDialog } from "./postransferorders/components/ViewTransferDialog";

export default function PosTransferOrders({ posUser }: PosTransferOrdersProps) {
  const [editVoucherId, setEditVoucherId] = useState<number | null>(null);
  const [viewVoucherId, setViewVoucherId] = useState<number | null>(null);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "applied" | "pending">("all");
  const [dateFilter, setDateFilter] = useState(format(new Date(), "yyyy-MM-dd"));

  const { data: myLocations = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/my-locations"],
  });
  const myLocationIds = useMemo(() => new Set(myLocations.map((location) => location.id)), [myLocations]);

  const { data: allTransfers = [], isLoading } = useQuery<TransferSummary[]>({
    queryKey: ["/api/stock-transfers/list", dateFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFilter) {
        params.set("startDate", dateFilter);
        params.set("endDate", dateFilter);
      }
      const response = await fetch(`/api/stock-transfers/list?${params}`, { credentials: "include" });
      return response.ok ? response.json() : [];
    },
  });

  const transfers = useMemo(() => {
    return allTransfers.filter((transfer) => {
      if (statusFilter === "applied" && !transfer.inventoryApplied) return false;
      if (statusFilter === "pending" && transfer.inventoryApplied) return false;
      if (dateFilter) {
        const transferDate = String(transfer.voucherDate ?? "").slice(0, 10);
        if (transferDate !== dateFilter) return false;
      }
      if (myLocationIds.size > 0) {
        const sourceMatch = transfer.sourceLocationId != null && myLocationIds.has(transfer.sourceLocationId);
        const destinationMatch = myLocationIds.has(transfer.destinationLocationId);
        if (!sourceMatch && !destinationMatch) return false;
      }
      if (!search.trim()) return true;
      return searchAny(search, transfer.voucherNumber, ...(transfer.stockItemNames ?? []));
    });
  }, [allTransfers, search, statusFilter, dateFilter, myLocationIds]);

  const openView = (voucherId: number) => {
    setViewVoucherId(voucherId);
    setViewDialogOpen(true);
  };

  const today = format(new Date(), "yyyy-MM-dd");
  const clearFilters = () => {
    setSearch("");
    setStatusFilter("all");
    setDateFilter(today);
  };
  const hasFilters = Boolean(search) || statusFilter !== "all" || dateFilter !== today;

  if (editVoucherId !== null) {
    return (
      <div className="flex min-h-0 flex-col">
        <TransferOrderDetail voucherId={editVoucherId} posUser={posUser} onBack={() => setEditVoucherId(null)} />
      </div>
    );
  }

  return (
    <section className="min-w-0 max-w-full space-y-4" data-pos-transfer-orders="true">
      <PageHeader title="Orders" subtitle="Review and adjust quantities for your location" showBackButton={false}>
        {myLocations.length > 1 && (
          <Button className="w-full sm:w-auto" onClick={() => setCreateOpen(true)} data-testid="button-new-transfer">
            <Plus className="mr-1.5 h-4 w-4" />
            New Transfer
          </Button>
        )}
      </PageHeader>

      <div
        role="search"
        aria-label="Transfer order filters"
        className="grid min-w-0 grid-cols-1 gap-3 rounded-xl border bg-muted/20 p-3 sm:grid-cols-2 lg:grid-cols-[10rem_9rem_minmax(12rem,1fr)_auto] lg:items-end"
      >
        <div className="min-w-0 space-y-1">
          <label htmlFor="pos-transfer-date-filter" className="text-xs font-medium text-muted-foreground">
            Date
          </label>
          <div className="relative min-w-0">
            <CalendarIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              id="pos-transfer-date-filter"
              type="date"
              value={dateFilter}
              onChange={(event) => setDateFilter(event.target.value)}
              className="min-h-11 w-full min-w-0 rounded-lg border bg-background pl-10 pr-2 text-base outline-none focus:ring-2 focus:ring-ring lg:min-h-9 lg:text-sm"
              data-testid="input-date-filter"
            />
          </div>
        </div>

        <div className="min-w-0 space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Status</label>
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}>
            <SelectTrigger className="min-h-11 w-full lg:min-h-9" data-testid="select-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="applied">Applied</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-0 space-y-1 sm:col-span-2 lg:col-span-1">
          <label htmlFor="pos-transfer-list-search" className="text-xs font-medium text-muted-foreground">
            Search
          </label>
          <div className="relative min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="pos-transfer-list-search"
              placeholder="Voucher number or item"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="min-h-11 pl-10 text-base lg:min-h-9 lg:text-sm"
              data-testid="input-list-search"
            />
          </div>
        </div>

        {hasFilters ? (
          <Button
            variant="outline"
            onClick={clearFilters}
            className="min-h-11 w-full gap-1.5 sm:col-span-2 lg:col-span-1 lg:min-h-9 lg:w-auto"
            data-testid="button-clear-filters"
          >
            <X className="h-4 w-4" />
            Clear
          </Button>
        ) : (
          <div className="hidden lg:block" aria-hidden="true" />
        )}
      </div>

      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {isLoading ? "Loading…" : `${transfers.length} ${transfers.length === 1 ? "order" : "orders"}`}
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((item) => (
            <div
              key={item}
              className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Skeleton className="h-3 w-3 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-36 max-w-full" />
                  <Skeleton className="h-3 w-52 max-w-full" />
                </div>
              </div>
              <Skeleton className="h-11 w-full sm:w-24" />
            </div>
          ))}
        </div>
      ) : transfers.length === 0 ? (
        <div
          className="rounded-xl border border-dashed bg-card py-14 text-center text-muted-foreground"
          data-testid="text-empty"
        >
          <Package2 className="mx-auto mb-3 h-10 w-10 opacity-20" />
          <p className="text-sm font-medium">No transfer orders found</p>
          {hasFilters && <p className="mt-1 text-xs opacity-70">Try clearing your filters.</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {transfers.map((transfer) => (
            <article
              key={transfer.voucherId}
              className="min-w-0 rounded-xl border bg-card p-3 shadow-sm transition-shadow hover:shadow-md sm:p-4"
              data-testid={`row-transfer-${transfer.voucherId}`}
            >
              <div className="flex min-w-0 items-start gap-3">
                <div
                  className={cn(
                    "mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full",
                    transfer.inventoryApplied ? "bg-green-500 dark:bg-green-400" : "bg-amber-400"
                  )}
                  aria-hidden="true"
                />

                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span
                      className="break-all font-mono text-sm font-semibold"
                      data-testid={`text-voucher-${transfer.voucherId}`}
                    >
                      {transfer.voucherNumber}
                    </span>
                    <span className="text-xs text-muted-foreground">{formatDate(transfer.voucherDate)}</span>
                    {transfer.inventoryApplied ? (
                      <Badge
                        variant="secondary"
                        className="gap-1 bg-green-100 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-400"
                        data-testid={`badge-applied-${transfer.voucherId}`}
                      >
                        <CheckCircle2 className="h-3 w-3" />
                        Applied
                      </Badge>
                    ) : (
                      <Badge
                        variant="secondary"
                        className="gap-1 bg-amber-100 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                        data-testid={`badge-pending-${transfer.voucherId}`}
                      >
                        <Clock className="h-3 w-3" />
                        Pending
                      </Badge>
                    )}
                  </div>

                  <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 text-sm">
                    <span className="min-w-0 break-words text-muted-foreground">{transfer.sourceLocationName}</span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 break-words font-medium">{transfer.destinationLocationName}</span>
                  </div>
                </div>

                <div className="shrink-0 rounded-lg bg-muted/50 px-2.5 py-2 text-center">
                  <div className="font-mono text-lg font-bold leading-none tabular-nums">{transfer.itemCount}</div>
                  <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">items</div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 border-t pt-3 sm:flex sm:justify-end">
                <Button
                  className="min-h-11 w-full gap-2 sm:w-auto"
                  variant="outline"
                  onClick={() => openView(transfer.voucherId)}
                  data-testid={`button-view-${transfer.voucherId}`}
                >
                  <Eye className="h-4 w-4" />
                  View
                </Button>
                {!transfer.inventoryApplied && (
                  <Button
                    className="min-h-11 w-full gap-2 sm:w-auto"
                    onClick={() => setEditVoucherId(transfer.voucherId)}
                    data-testid={`button-edit-${transfer.voucherId}`}
                  >
                    <Pencil className="h-4 w-4" />
                    Adjust
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      <ViewTransferDialog
        voucherId={viewVoucherId}
        open={viewDialogOpen}
        onClose={() => {
          setViewDialogOpen(false);
          setViewVoucherId(null);
        }}
      />

      <CreateTransferDialog open={createOpen} onClose={() => setCreateOpen(false)} myLocations={myLocations} />
    </section>
  );
}
