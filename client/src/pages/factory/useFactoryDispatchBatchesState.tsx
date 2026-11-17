// Extracted from ./FactoryDispatchBatches.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { visibleTabInterval } from "@/lib/queryPolicies";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
interface Customer {
  id: number;
  legalName: string;
}

interface ProformaLine {
  articleCode: string;
  productName: string;
  quantity: number;
  pricePerBale: string;
}

interface Proforma {
  id: number;
  name: string;
  customerId: number;
  isActive: boolean;
  lines?: ProformaLine[];
}

interface BatchRow {
  id: number;
  batchNumber: string;
  batchDate: string;
  status: string;
  currency: string;
  priceMode: string;
  destination: string | null;
  customerId: number;
  proformaId: number | null;
  customerName: string | null;
  proformaName: string | null;
  rideCount: number | string;
  baleCount: number | string;
  totalWeightKg: string;
  totalAmount: string;
  invoiceNumber: string | null;
}

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  DRAFT: { label: "Draft", className: "bg-muted text-muted-foreground" },
  LOADING: { label: "Loading", className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" },
  DISPATCHED: { label: "Dispatched", className: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200" },
  INVOICED: { label: "Invoiced", className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" },
  CANCELLED: { label: "Cancelled", className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" },
};

export function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] || { label: status, className: "" };
  return <Badge className={cfg.className}>{cfg.label}</Badge>;
}

export function fmt(n: number | string) {
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(v)) return "0";
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function useFactoryDispatchBatchesState() {
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const canCreateBatch = recordChanges.canCreate("POST", "/api/factory/dispatch-batches");
  const { formatDisplayDate } = useDateFormat();

  const [filterCustomer, setFilterCustomer] = useState("_all");
  const [filterStatus, setFilterStatus] = useState("_all");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"list" | "reports">("list");
  const searchStr = useSearch();
  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });
  const hiddenTabs =
    myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
      ? myAccess.hiddenCostFields
      : ["hide_tab_dispatch_batches", "hide_tab_dispatch_reports"];
  const showBatches = !hiddenTabs.includes("hide_tab_dispatch_batches");
  const showReports = !hiddenTabs.includes("hide_tab_dispatch_reports");
  const effectiveActiveTab =
    activeTab === "list" && showBatches
      ? "list"
      : activeTab === "reports" && showReports
        ? "reports"
        : showBatches
          ? "list"
          : showReports
            ? "reports"
            : null;

  useEffect(() => {
    if (effectiveActiveTab && activeTab !== effectiveActiveTab) {
      setActiveTab(effectiveActiveTab);
    }
  }, [activeTab, effectiveActiveTab]);

  const [form, setForm] = useState({
    customerId: "",
    proformaId: "_none",
    batchDate: new Date().toISOString().split("T")[0],
    currency: "USD",
    priceMode: "PER_BALE",
    destination: "",
    notes: "",
  });

  useEffect(() => {
    const params = new URLSearchParams(searchStr);
    if (params.get("openCreate") !== "1") return;

    if (!showBatches) {
      params.delete("openCreate");
      params.delete("customerId");
      params.delete("proformaId");
      const next = params.toString();
      window.history.replaceState(
        window.history.state,
        "",
        next ? `${window.location.pathname}?${next}` : window.location.pathname
      );
      setCreateOpen(false);
      return;
    }

    const cid = params.get("customerId") || "";
    const pid = params.get("proformaId") || "_none";
    setForm((f) => ({ ...f, customerId: cid, proformaId: pid }));
    setCreateOpen(true);
  }, [searchStr, showBatches]);

  const qParams = new URLSearchParams();
  if (filterCustomer && filterCustomer !== "_all") qParams.set("customerId", filterCustomer);
  if (filterStatus && filterStatus !== "_all") qParams.set("status", filterStatus);
  const {
    data: batchesData,
    isLoading,
    isError,
    refetch,
  } = useQuery<BatchRow[]>({
    queryKey: companyQueryKey("/api/factory/dispatch-batches", selectedCompany?.id, filterCustomer, filterStatus),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch(`/api/factory/dispatch-batches?${qParams}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    staleTime: 30_000,
    refetchInterval: visibleTabInterval(60_000),
    refetchIntervalInBackground: false,
  });
  const batches = batchesData ?? [];
  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: companyQueryKey("/api/factory/customers", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  const { data: proformas = [] } = useQuery<Proforma[]>({
    queryKey: companyQueryKey(
      `/api/factory/customer-proformas?customerId=${form.customerId}&profile=summary&pageSize=250`,
      selectedCompany?.id
    ),
    queryFn: async () => {
      if (!form.customerId) return [];
      const res = await fetch(
        `/api/factory/customer-proformas?customerId=${form.customerId}&profile=summary&pageSize=250`,
        {
          credentials: "include",
        }
      );
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!form.customerId && createOpen && Boolean(selectedCompany?.id),
    staleTime: 5 * 60_000,
  });

  interface ReportsSummary {
    uninvoicedCount: number;
    dispatchedCount: number;
    invoicedCount: number;
    loadingCount: number;
    reservedBalesCount: number;
    dispatchedRidesNotInvoiced: number;
  }
  const { data: reportsSummary, isLoading: reportsLoading } = useQuery<ReportsSummary>({
    queryKey: companyQueryKey("/api/factory/dispatch-reports/summary", selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/dispatch-reports/summary", { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    enabled: effectiveActiveTab === "reports" && Boolean(selectedCompany?.id),
    staleTime: 30_000,
    refetchInterval: effectiveActiveTab === "reports" ? visibleTabInterval(60_000) : false,
    refetchIntervalInBackground: false,
  });

  const activeProformas = proformas.filter((p) => p.isActive);

  const selectedProforma = proformas.find((p) => p.id === parseInt(form.proformaId));

  const createMutation = useMutation({
    mutationFn: async () => {
      const payload: {
        customerId: number;
        batchDate: string;
        currency: string;
        priceMode: string;
        destination: string | undefined;
        notes: string | undefined;
        proformaId?: number;
      } = {
        customerId: parseInt(form.customerId),
        batchDate: form.batchDate,
        currency: form.currency,
        priceMode: form.priceMode,
        destination: form.destination || undefined,
        notes: form.notes || undefined,
      } as {
        customerId: number;
        batchDate: string;
        currency: string;
        priceMode: string;
        destination: string | undefined;
        notes: string | undefined;
        proformaId?: number;
      };
      if (form.proformaId && form.proformaId !== "_none") payload.proformaId = parseInt(form.proformaId);
      const res = await apiRequest("POST", "/api/factory/dispatch-batches", payload);
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries(
        { queryKey: ["/api/factory/dispatch-batches"], refetchType: "active" },
        { cancelRefetch: false }
      );
      toast({ title: "Batch created", description: `Dispatch batch ${data.batch?.batchNumber} created.` });
      setCreateOpen(false);
      resetForm();
      if (data.batch?.id) navigate(`/factory/dispatch-batches/${data.batch.id}`);
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  function resetForm() {
    setForm({
      customerId: "",
      proformaId: "_none",
      batchDate: new Date().toISOString().split("T")[0],
      currency: "USD",
      priceMode: "PER_BALE",
      destination: "",
      notes: "",
    });
  }

  const filtered = batches.filter((b) => {
    if (!search) return true;
    return searchAny(search, b.batchNumber, b.customerName, b.invoiceNumber);
  });
  return {
    refetch,
    isError,
    batchesData,
    activeProformas,
    canCreateBatch,
    createMutation,
    createOpen,
    customers,
    effectiveActiveTab,
    filterCustomer,
    filterStatus,
    filtered,
    form,
    formatDisplayDate,
    isLoading,
    navigate,
    reportsLoading,
    reportsSummary,
    resetForm,
    search,
    selectedProforma,
    setActiveTab,
    setCreateOpen,
    setFilterCustomer,
    setFilterStatus,
    setForm,
    setSearch,
    showBatches,
    showReports,
  };
}
