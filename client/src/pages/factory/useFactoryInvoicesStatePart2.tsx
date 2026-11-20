// Extracted from ./FactoryInvoices.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { invalidateCustomerBalances, keyStartsWith, queryClient } from "@/lib/queryClient";
import type { CustomerOrder, StatusFilter } from "./factoryinvoices/types";
import {
  applyCustomGroupOrder,
  filterOrdersByStatus,
  getFactoryInvoiceDate,
  groupOrdersByCustomer,
  statusFilterCounts,
} from "./factoryinvoices/invoiceCalculations";
import type { EditableShippingField } from "./factoryinvoices/InvoiceOrderRow";
import { useFactoryInvoicesStatePart1 } from "./useFactoryInvoicesStatePart1";

export function useFactoryInvoicesStatePart2({
  allOrders,
  customGroupOrders,
  customerFilter,
  downloadExport,
  dragIdxRef,
  formatDisplayDate,
  fromDate,
  hideMutation,
  isAdmin,
  isColumnVisible,
  modeApiRequest,
  navigate,
  recordChanges,
  searchTerm,
  setChangingCustomerOrderId,
  setCustomGroupOrders,
  setDropIdx,
  setNewCustomerId,
  shippingFieldMutation,
  showHidden,
  statusFilter,
  toDate,
  toast,
  visibleOptionalColumns,
}: Pick<
  Awaited<ReturnType<typeof useFactoryInvoicesStatePart1>>,
  | "allOrders"
  | "customGroupOrders"
  | "customerFilter"
  | "downloadExport"
  | "dragIdxRef"
  | "formatDisplayDate"
  | "fromDate"
  | "hideMutation"
  | "isAdmin"
  | "isColumnVisible"
  | "modeApiRequest"
  | "navigate"
  | "recordChanges"
  | "searchTerm"
  | "setChangingCustomerOrderId"
  | "setCustomGroupOrders"
  | "setDropIdx"
  | "setNewCustomerId"
  | "shippingFieldMutation"
  | "showHidden"
  | "statusFilter"
  | "toDate"
  | "toast"
  | "visibleOptionalColumns"
>) {
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
      toast({
        title: "Loading deleted",
        description: "Eligible bales returned to available stock. The loading can be found in Deleted Items.",
      });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/stock") });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/bales") });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/locations") });
      invalidateCustomerBalances();
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
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
    if (
      needle &&
      ![
        order.customerName,
        order.invoiceNumber,
        String(order.id),
        order.proformaName,
        order.containerNumber,
        order.bookingInfo,
        order.agentName,
        order.destination,
      ].some((value) => (value || "").toLowerCase().includes(needle))
    )
      return false;
    const day = (getFactoryInvoiceDate(order) || "").slice(0, 10);
    if (fromDate && (!day || day < fromDate)) return false;
    if (toDate && (!day || day > toDate)) return false;
    return true;
  });
  const {
    loading: loadingCount,
    verified: verifiedCount,
    finalized: finalizedCount,
  } = statusFilterCounts(scopedOrders);
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

  // Customer, Actions and drag handle are always present.
  const colCount = 3 + visibleOptionalColumns;

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
    isColumnVisible,
    formatDisplayDate,
    getStatusBadge,
    onRowClick: handleRowClick,
    onToggleHideOrder: (order: CustomerOrder) => hideMutation.mutate({ orderId: order.id, isHidden: !order.isHidden }),
    onDownload: downloadExport,
    onSaveShippingField: async (orderId: number, field: EditableShippingField, value: string) => {
      await shippingFieldMutation.mutateAsync({ orderId, field, value });
    },
    isAdmin,
    canChangeExistingRecords: recordChanges.allowed,
    unfinalizePending: unfinalizeMutation.isPending,
    onRevertOrder: (orderId: number) => unfinalizeMutation.mutate(orderId),
    onDeleteOrder: (orderId: number) => deleteMutation.mutate(orderId),
    onChangeCustomer: (orderId: number) => {
      setChangingCustomerOrderId(orderId);
      setNewCustomerId("");
    },
  };
  return {
    colCount,
    customerGroups,
    filteredOrders,
    handleDragEnd,
    handleDragOver,
    handleDragStart,
    handleDrop,
    orderRowContext,
    orderedCustomerGroups,
    scopedOrders,
    statusFilters,
  };
}
