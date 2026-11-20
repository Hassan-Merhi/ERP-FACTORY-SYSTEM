// Extracted from ./PosTransferOrders.tsx
import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import type { TransferSummary } from "./postransferorders/types";

export function usePosTransferOrdersState() {
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

  const {
    data: allTransfers = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<TransferSummary[]>({
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

  const appliedCount = transfers.filter((transfer) => transfer.inventoryApplied).length;
  const pendingCount = transfers.length - appliedCount;
  return {
    editVoucherId,
    setEditVoucherId,
    viewVoucherId,
    setViewVoucherId,
    viewDialogOpen,
    setViewDialogOpen,
    setCreateOpen,
    createOpen,
    search,
    setSearch,
    statusFilter,
    setStatusFilter,
    dateFilter,
    setDateFilter,
    myLocations,
    isLoading,
    isError,
    allTransfers,
    refetch,
    transfers,
    openView,
    clearFilters,
    hasFilters,
    appliedCount,
    pendingCount,
  };
}
