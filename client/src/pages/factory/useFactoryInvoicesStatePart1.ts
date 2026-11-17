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
import { useLocation } from "wouter";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { invalidateCustomerBalances, keyStartsWith, queryClient } from "@/lib/queryClient";
import type { Customer, CustomerOrder, StatusFilter } from "./factoryinvoices/types";
import type { AuthMe, FactoryMyAccess } from "@shared/apiTypes";
import type { EditableShippingField, InvoiceColumnKey } from "./factoryinvoices/InvoiceOrderRow";
import { downloadFromUrl } from "@/lib/exportFile";

// All permitted invoice columns are visible unless the user chooses to hide them.
const INVOICE_OPTIONAL_COLUMNS: { key: InvoiceColumnKey; label: string }[] = [
  { key: "loading", label: "Loading #" },
  { key: "proforma", label: "Proforma" },
  { key: "container", label: "Container" },
  { key: "bookingInfo", label: "Booking Info" },
  { key: "destination", label: "Destination" },
  { key: "notes", label: "Notes" },
  { key: "date", label: "Date" },
  { key: "status", label: "Status" },
  { key: "bales", label: "Bales" },
  { key: "weight", label: "Weight" },
  { key: "remaining", label: "Remaining" },
  { key: "extras", label: "Extras" },
  { key: "total", label: "Total" },
];

export function useFactoryInvoicesStatePart1() {
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

  // Server-named downloads through the shared helper: auth cookies are sent and
  // server errors surface as a toast instead of a blank tab.
  const downloadExport = useCallback(
    async (url: string, fallbackName: string) => {
      try {
        await downloadFromUrl(url, { fileName: fallbackName });
      } catch (e) {
        toast({
          title: "Export failed",
          description: getErrorDetails(e).message || "Please try again.",
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
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    },
  });
  return {
    allOrders,
    allowedInvoiceColumns,
    changeCustomerMutation,
    changingCustomerOrderId,
    customGroupOrders,
    customerFilter,
    customers,
    downloadExport,
    dragIdxRef,
    dropIdx,
    expandedCustomers,
    formatDisplayDate,
    fromDate,
    hideMutation,
    hideTotalsUsd,
    isAdmin,
    isColumnVisible,
    isError,
    isLoading,
    modeApiRequest,
    navigate,
    newCustomerId,
    recordChanges,
    searchTerm,
    setChangingCustomerOrderId,
    setColumnVisible,
    setCustomGroupOrders,
    setCustomerFilter,
    setDropIdx,
    setFromDate,
    setNewCustomerId,
    setSearchTerm,
    setShowHidden,
    setShowMoreFilters,
    setStatusFilter,
    setTablePrefs,
    setToDate,
    shippingFieldMutation,
    showHidden,
    showMoreFilters,
    statusFilter,
    toDate,
    toast,
    toggleCustomer,
    visibleOptionalColumns,
  };
}
