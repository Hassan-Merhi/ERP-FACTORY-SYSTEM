// Extracted from ./FactoryInvoices.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTablePrefs } from "@/hooks/use-table-prefs";
import { useToast } from "@/hooks/use-toast";
import { useCallback, useRef, useState } from "react";
import { useAppMode } from "@/contexts/AppModeContext";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { getApiRequest } from "@/lib/factoryApi";
import { Badge } from "@/components/ui/badge";
import { useLocation } from "wouter";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { invalidateCustomerBalances, keyStartsWith, queryClient } from "@/lib/queryClient";
import type { Customer, CustomerOrder, StatusFilter } from "./factoryinvoices/types";
import type { AuthMe, FactoryMyAccess } from "@shared/apiTypes";
import {
  applyCustomGroupOrder,
  filterOrdersByStatus,
  getFactoryInvoiceDate,
  groupOrdersByCustomer,
  statusFilterCounts,
} from "./factoryinvoices/invoiceCalculations";
import type { EditableShippingField, InvoiceColumnKey } from "./factoryinvoices/InvoiceOrderRow";
import { INVOICE_OPTIONAL_COLUMNS } from "./INVOICE_OPTIONAL_COLUMNS";

export function useFactoryInvoicesState() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { formatDisplayDate } = useDateFormat();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("LOADING");
  const [customerFilter, setCustomerFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
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

  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });
  const accessReady = Boolean(myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess);
  const isAdmin = accessReady && myAccess?.fullAccess === true;
  const recordChanges = useExistingRecordChangeAccess();
  const { data: authUser } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"], staleTime: 5 * 60000 });
  const showBookingInfo =
    accessReady &&
    ["admin", "owner", "developer"].includes(String(authUser?.currentRole || authUser?.role || "").toLowerCase());
  const hidden: string[] = accessReady
    ? myAccess!.hiddenCostFields
    : ["hide_invoicing_proforma_col", "hide_invoicing_totals_usd"];
  const hideProformaCol = !isAdmin || hidden.includes("hide_invoicing_proforma_col");
  const hideTotalsUsd = hidden.includes("hide_invoicing_totals_usd");

  // Use the existing durable table-preferences storage, scoped to the signed-in
  // user and company so shared devices do not share presentation settings.
  const { prefs: tablePrefs, setPrefs: setTablePrefs } = useTablePrefs(
    `factory-invoices:user:${authUser?.id ?? "pending"}`,
    { companyId: authUser?.currentCompanyId ?? null }
  );
  const allowedInvoiceColumns = INVOICE_OPTIONAL_COLUMNS.filter(
    ({ key }) =>
      (key !== "proforma" || !hideProformaCol) &&
      (key !== "bookingInfo" || showBookingInfo) &&
      (key !== "total" || !hideTotalsUsd)
  );
  const isColumnVisible = (key: InvoiceColumnKey): boolean =>
    allowedInvoiceColumns.some((column) => column.key === key) && tablePrefs.columns?.[key] !== false;
  const visibleOptionalColumns = allowedInvoiceColumns.filter(({ key }) => isColumnVisible(key)).length;
  const setColumnVisible = (key: InvoiceColumnKey, visible: boolean) => {
    if (!allowedInvoiceColumns.some((column) => column.key === key)) return;
    setTablePrefs((previous) => ({
      ...previous,
      columns: { ...previous.columns, [key]: visible },
    }));
  };

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: companyQueryKey("/api/factory/customers", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
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
    queryKey: companyQueryKey(
      `/api/factory/customer-orders${queryString ? `?${queryString}` : ""}`,
      selectedCompany?.id,
      customerFilter,
      showHidden
    ),
    enabled: Boolean(selectedCompany?.id),
  });

  const changeCustomerMutation = useMutation({
    mutationFn: async ({ orderId, customerId }: { orderId: number; customerId: number }) => {
      const response = await modeApiRequest("PATCH", `/api/factory/customer-orders/${orderId}/change-customer`, {
        customerId,
      });
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
    onError: (error: Error) =>
      toast({ title: "Cannot change customer", description: error.message, variant: "destructive" }),
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
    if (
      needle &&
      ![
        order.customerName,
        order.invoiceNumber,
        String(order.id),
        order.proformaName,
        order.containerNumber,
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
    onDownload: downloadFromUrl,
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
    allowedInvoiceColumns,
    changeCustomerMutation,
    changingCustomerOrderId,
    colCount,
    customerFilter,
    customerGroups,
    customers,
    dragIdxRef,
    dropIdx,
    expandedCustomers,
    filteredOrders,
    fromDate,
    handleDragEnd,
    handleDragOver,
    handleDragStart,
    handleDrop,
    hideTotalsUsd,
    isColumnVisible,
    isError,
    isLoading,
    newCustomerId,
    orderRowContext,
    orderedCustomerGroups,
    scopedOrders,
    searchTerm,
    setChangingCustomerOrderId,
    setColumnVisible,
    setCustomerFilter,
    setFromDate,
    setNewCustomerId,
    setSearchTerm,
    setShowHidden,
    setShowMoreFilters,
    setStatusFilter,
    setTablePrefs,
    setToDate,
    showHidden,
    showMoreFilters,
    statusFilter,
    statusFilters,
    toDate,
    toggleCustomer,
    visibleOptionalColumns,
  };
}
