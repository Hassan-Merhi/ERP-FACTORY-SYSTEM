import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import type { FactorySupplier } from "@shared/schema";
import type { DirectContainer } from "./AssignContainersDialog";
import type { BulkFxPreview, StatementResponse, SupplierWithBalance } from "./factorySupplierTypes";

export type SupplierFilter =
  "all" | "brokers" | "standalone" | "with-balance" | "zero-balance" | "has-foreign" | "has-recent";
export type FxSourceType = "supplier" | "commission" | "both";

export interface SupplierFormData {
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  parentId: number | null;
}

interface PaymentForm {
  supplierId: number;
  date: string;
  amount: string;
  currencyCode: string;
  fxRateToUsd: string;
  paidFromAccountId: string;
  notes: string;
  effectiveDate: string;
}

interface FxConversionForm {
  fromSupplierId: number;
  toSupplierId: number;
  selectedCurrency: string;
  amount: string;
  availableBalance: string;
  supplierBalance: string;
  commissionBalance: string;
  fxRateToUsd: string;
  date: string;
  notes: string;
  effectiveDate: string;
  sourceType?: string;
}

interface BulkFxForm {
  fromCurrencyCode: string;
  totalAmount: string;
  fxRateToUsd: string;
  date: string;
  notes: string;
  order: "oldest" | "newest";
}

interface OpeningBalanceEdit {
  id: number;
  name: string;
  currentBalance: string;
}

interface OpeningCommissionEdit {
  rawStockId: number;
  amount: string;
  currencyCode: string;
  personName: string;
  notes: string;
}

interface OpeningCommissionUpdatePayload {
  rawStockId: number;
  commissionAmount: string;
  commissionCurrencyCode: string;
  commissionPersonName: string;
  commissionNotes: string;
}

interface DueContainer {
  id: number;
  containerNumber: string;
  offloadDate: string;
  currencyCode: string;
  value: string;
  daysPastDue: number;
}

interface MoveContainerState {
  open: boolean;
  containerId: number | null;
  containerRef: string;
}

interface MoveResult {
  toSupplierName: string;
  fromSupplierName: string;
}

interface SupplierPatch extends Partial<SupplierFormData> {
  id: number;
  isBroker?: boolean;
}

function responseMessage(body: unknown, fallback: string): string {
  return typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
    ? body.message
    : fallback;
}

export function useFactorySuppliersModel() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const today = new Date().toLocaleDateString("en-CA");

  const [createOpen, setCreateOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<FactorySupplier | null>(null);
  const [pendingDelete, setPendingDelete] = useState<(() => void) | null>(null);
  const [statementSupplierId, setStatementSupplierId] = useState<number | null>(() => {
    const id = new URLSearchParams(window.location.search).get("supplierId");
    return id ? Number(id) : null;
  });
  const [statementReturnToParent, setStatementReturnToParent] = useState(false);
  const [statDateFilter, setStatDateFilter] = useState<"all" | "today" | "yesterday" | "this_month" | "this_year">(
    "all"
  );
  const [parentViewSupplierId, setParentViewSupplierId] = useState<number | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [expandedSupplierIds, setExpandedSupplierIds] = useState<Set<number>>(new Set());
  const [createSubAccountParentId, setCreateSubAccountParentId] = useState<number | null>(null);
  const [activeFilter, setActiveFilter] = useState<SupplierFilter>("all");
  const [formData, setFormData] = useState<SupplierFormData>({
    name: "",
    contactPerson: "",
    phone: "",
    email: "",
    address: "",
    notes: "",
    parentId: null,
  });
  const [formRole, setFormRole] = useState<"broker" | "standalone" | "linked">("standalone");
  const [listIncludeOtw, setListIncludeOtw] = useState(false);
  const [moveContainerDialog, setMoveContainerDialog] = useState<MoveContainerState>({
    open: false,
    containerId: null,
    containerRef: "",
  });
  const [moveTargetSupplierId, setMoveTargetSupplierId] = useState("");
  // All directory and detail views share one OTW inclusion setting so the
  // visible amounts never differ solely because each view held a stale toggle.
  const supplierIncludeOtw = listIncludeOtw;
  const setSupplierIncludeOtw = setListIncludeOtw;
  const [collapsedStmtSections, setCollapsedStmtSections] = useState<Set<string>>(new Set(["currencyPools"]));
  const brokerIncludeOtw = listIncludeOtw;
  const setBrokerIncludeOtw = setListIncludeOtw;
  const [assignTarget, setAssignTarget] = useState<{ id: number; name: string } | null>(null);
  const [paymentDialogSupplier, setPaymentDialogSupplier] = useState<SupplierWithBalance | null>(null);
  const [paymentForm, setPaymentForm] = useState<PaymentForm>({
    supplierId: 0,
    date: today,
    amount: "",
    currencyCode: "USD",
    fxRateToUsd: "1",
    paidFromAccountId: "",
    notes: "",
    effectiveDate: "",
  });
  const [fxConversionOpen, setFxConversionOpen] = useState(false);
  const [fxSourceType, setFxSourceType] = useState<FxSourceType>("supplier");
  const [obEditSupplier, setObEditSupplier] = useState<OpeningBalanceEdit | null>(null);
  const [obEditValue, setObEditValue] = useState("");
  const [fxConversionForm, setFxConversionForm] = useState<FxConversionForm>({
    fromSupplierId: 0,
    toSupplierId: 0,
    selectedCurrency: "",
    amount: "",
    availableBalance: "",
    supplierBalance: "",
    commissionBalance: "",
    fxRateToUsd: "",
    date: today,
    notes: "",
    effectiveDate: "",
  });
  const [bulkFxOpen, setBulkFxOpen] = useState(false);
  const [bulkFxBrokerId, setBulkFxBrokerId] = useState<number | null>(null);
  const [bulkFxBrokerName, setBulkFxBrokerName] = useState("");
  const [bulkFxForm, setBulkFxForm] = useState<BulkFxForm>({
    fromCurrencyCode: "EUR",
    totalAmount: "",
    fxRateToUsd: "",
    date: today,
    notes: "",
    order: "oldest",
  });
  const [bulkFxPreview, setBulkFxPreview] = useState<BulkFxPreview | null>(null);
  const [editObComm, setEditObComm] = useState<OpeningCommissionEdit | null>(null);
  const [dueDialogSupplier, setDueDialogSupplier] = useState<{ name: string; containers: DueContainer[] } | null>(null);

  useEscapeBack(
    statementSupplierId
      ? () => {
          setStatementSupplierId(null);
          setStatementReturnToParent(false);
        }
      : parentViewSupplierId
        ? () => setParentViewSupplierId(null)
        : null
  );

  const { data: suppliers, isLoading } = useQuery<SupplierWithBalance[]>({
    queryKey: ["/api/factory/suppliers/with-balances", listIncludeOtw],
    queryFn: async () => {
      const response = await factoryApiRequest(
        "GET",
        `/api/factory/suppliers/with-balances?includeOtw=${listIncludeOtw}`
      );
      if (!response.ok) throw new Error("Failed to fetch suppliers");
      return response.json() as Promise<SupplierWithBalance[]>;
    },
  });

  const {
    data: statementData,
    isLoading: statementLoading,
    isError: statementError,
  } = useQuery<StatementResponse>({
    queryKey: ["/api/factory/suppliers", statementSupplierId, "statement", supplierIncludeOtw],
    queryFn: async () => {
      const response = await factoryApiRequest(
        "GET",
        `/api/factory/suppliers/${statementSupplierId}/statement?includeOtw=${supplierIncludeOtw}`
      );
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(responseMessage(error, "Failed to load statement"));
      }
      return response.json() as Promise<StatementResponse>;
    },
    enabled: !!statementSupplierId,
    retry: 1,
  });

  const { data: brokerOverviewStatement, isLoading: brokerOverviewLoading } = useQuery<unknown>({
    queryKey: ["/api/factory/suppliers", parentViewSupplierId, "broker-statement", brokerIncludeOtw],
    queryFn: async () => {
      const response = await factoryApiRequest(
        "GET",
        `/api/factory/suppliers/${parentViewSupplierId}/broker-statement?includeOtw=${brokerIncludeOtw}`
      );
      if (!response.ok) throw new Error("Failed to load broker overview");
      return response.json();
    },
    enabled: !!parentViewSupplierId && !statementSupplierId,
  });

  const { data: directContainersData, isLoading: directContainersLoading } = useQuery<DirectContainer[]>({
    queryKey: ["/api/factory/suppliers", parentViewSupplierId, "direct-containers"],
    queryFn: async () => {
      const response = await factoryApiRequest(
        "GET",
        `/api/factory/suppliers/${parentViewSupplierId}/direct-containers`
      );
      if (!response.ok) throw new Error("Failed to load direct containers");
      return response.json() as Promise<DirectContainer[]>;
    },
    enabled: !!parentViewSupplierId && !statementSupplierId,
  });

  const { data: ledgerAccounts } = useQuery<{ id: number; name: string; code: string }[]>({
    queryKey: ["/api/ledger-accounts?includeHidden=true"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const bulkFxPreviewMutation = useMutation({
    mutationFn: async () => {
      if (!bulkFxBrokerId) throw new Error("No broker selected");
      const response = await factoryApiRequest("POST", `/api/factory/suppliers/${bulkFxBrokerId}/bulk-fx-settlement`, {
        ...bulkFxForm,
        dryRun: true,
      });
      if (!response.ok) throw new Error(responseMessage(await response.json().catch(() => ({})), "Preview failed"));
      return response.json() as Promise<BulkFxPreview>;
    },
    onSuccess: setBulkFxPreview,
    onError: (error: Error) => toast({ title: "Preview failed", description: error.message, variant: "destructive" }),
  });

  const bulkFxMutation = useMutation({
    mutationFn: async () => {
      if (!bulkFxBrokerId) throw new Error("No broker selected");
      const response = await factoryApiRequest(
        "POST",
        `/api/factory/suppliers/${bulkFxBrokerId}/bulk-fx-settlement`,
        bulkFxForm
      );
      if (!response.ok)
        throw new Error(responseMessage(await response.json().catch(() => ({})), "Failed to record bulk settlement"));
      return response.json();
    },
    onSuccess: () => {
      setBulkFxOpen(false);
      setBulkFxPreview(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      toast({ title: "Bulk FX Settlement recorded" });
    },
    onError: (error: Error) =>
      toast({ title: "Settlement failed", description: error.message, variant: "destructive" }),
  });

  const fxConversionMutation = useMutation({
    mutationFn: async (data: FxConversionForm) => {
      const displayRate = parseFloat(data.fxRateToUsd) || 0;
      const amount = parseFloat(data.amount) || 0;
      const payload = {
        fromSupplierId: data.fromSupplierId,
        toSupplierId: data.toSupplierId,
        fromCurrencyCode: data.selectedCurrency,
        fromAmount: data.amount,
        fxRateToUsd: (1 / displayRate).toFixed(6),
        toAmountUsd: (amount * displayRate).toFixed(4),
        date: data.date,
        notes: data.notes || null,
        sourceType: data.sourceType || "supplier",
        effectiveDate: data.effectiveDate || null,
      };
      const response = await factoryApiRequest("POST", "/api/factory/supplier-fx-transfers", payload);
      if (!response.ok) throw new Error("Failed to record FX transfer");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      setFxConversionOpen(false);
      toast({ title: "FX Transfer recorded" });
    },
  });

  const paymentMutation = useMutation({
    mutationFn: async (data: PaymentForm) => {
      const rate = parseFloat(data.fxRateToUsd) || 1;
      const amount = parseFloat(data.amount) || 0;
      const response = await factoryApiRequest("POST", "/api/factory/supplier-payments", {
        supplierId: data.supplierId,
        date: data.date,
        amount: data.amount,
        currencyCode: data.currencyCode,
        fxRateToUsd: data.fxRateToUsd,
        amountUsd: (data.currencyCode === "USD" ? amount : amount / rate).toFixed(4),
        paidFromAccountId: data.paidFromAccountId ? parseInt(data.paidFromAccountId) : null,
        notes: data.notes || null,
        effectiveDate: data.effectiveDate || null,
      });
      if (!response.ok) throw new Error("Failed to record payment");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      setPaymentDialogSupplier(null);
      toast({ title: "Payment recorded" });
    },
  });

  const deletePaymentMutation = useMutation({
    mutationFn: async (id: number) => factoryApiRequest("DELETE", `/api/factory/supplier-payments/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] }),
  });
  const deleteFxTransferMutation = useMutation({
    mutationFn: async (id: number) => factoryApiRequest("DELETE", `/api/factory/supplier-fx-transfers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] }),
  });
  const deleteObCommissionMutation = useMutation({
    mutationFn: async (id: number) => factoryApiRequest("DELETE", `/api/factory/raw-stock/opening-balance/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] }),
  });
  const createMutation = useMutation({
    mutationFn: async (data: SupplierFormData) => factoryApiRequest("POST", "/api/factory/suppliers", data),
    onSuccess: () => {
      setCreateOpen(false);
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      toast({ title: "Supplier created" });
    },
    onError: (error: Error) =>
      toast({ title: "Failed to create supplier", description: error.message, variant: "destructive" }),
  });
  const updateMutation = useMutation({
    mutationFn: async (data: SupplierPatch) => factoryApiRequest("PATCH", `/api/factory/suppliers/${data.id}`, data),
    onSuccess: () => {
      setEditingSupplier(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
    },
  });
  const obEditMutation = useMutation({
    mutationFn: async (data: { id: number; openingBalance: string }) =>
      factoryApiRequest("PATCH", `/api/factory/suppliers/${data.id}/opening-balance`, {
        openingBalance: data.openingBalance,
      }),
    onSuccess: () => {
      setObEditSupplier(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
    },
  });
  const deactivateMutation = useMutation({
    mutationFn: async (id: number) => factoryApiRequest("POST", `/api/factory/suppliers/${id}/deactivate`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] }),
  });
  const reactivateMutation = useMutation({
    mutationFn: async (id: number) => factoryApiRequest("POST", `/api/factory/suppliers/${id}/reactivate`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] }),
  });
  const permanentDeleteMutation = useMutation({
    mutationFn: async (id: number) => factoryApiRequest("DELETE", `/api/factory/suppliers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] }),
  });
  const renameSupplierMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) =>
      factoryApiRequest("PATCH", `/api/factory/suppliers/${id}`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers", statementSupplierId, "statement"] });
    },
  });
  const makeBrokerMutation = useMutation({
    mutationFn: async ({ id, isBroker }: { id: number; isBroker: boolean }) => {
      const response = await factoryApiRequest("PATCH", `/api/factory/suppliers/${id}/set-broker`, { isBroker });
      if (!response.ok) throw new Error(responseMessage(await response.json().catch(() => ({})), "Failed"));
      return response.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      toast({ title: variables.isBroker ? "Supplier marked as Broker" : "Broker flag removed" });
    },
    onError: (error: Error) => toast({ title: "Failed", description: error.message, variant: "destructive" }),
  });

  const moveContainerMutation = useMutation({
    mutationFn: async ({ containerId, targetSupplierId }: { containerId: number; targetSupplierId: number }) => {
      const response = await factoryApiRequest("POST", `/api/factory/containers/${containerId}/move-supplier`, {
        targetSupplierId,
      });
      if (!response.ok)
        throw new Error(responseMessage(await response.json().catch(() => ({})), "Failed to move container"));
      return response.json() as Promise<MoveResult>;
    },
    onSuccess: (data) => {
      setMoveContainerDialog({ open: false, containerId: null, containerRef: "" });
      setMoveTargetSupplierId("");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      toast({ title: `Moved to ${data.toSupplierName}`, description: `Was under ${data.fromSupplierName}` });
    },
    onError: (error: Error) => toast({ title: "Move failed", description: error.message, variant: "destructive" }),
  });

  const assignContainersMutation = useMutation({
    mutationFn: async ({ containerIds, targetSupplierId }: { containerIds: number[]; targetSupplierId: number }) => {
      const results: MoveResult[] = [];
      for (const containerId of containerIds) {
        const response = await factoryApiRequest("POST", `/api/factory/containers/${containerId}/move-supplier`, {
          targetSupplierId,
        });
        if (!response.ok)
          throw new Error(
            `Container ${containerId}: ${responseMessage(await response.json().catch(() => ({})), "Failed")}`
          );
        results.push((await response.json()) as MoveResult);
      }
      return results;
    },
    onSuccess: (results) => {
      setAssignTarget(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      queryClient.invalidateQueries({
        queryKey: ["/api/factory/suppliers", parentViewSupplierId, "direct-containers"],
      });
      toast({
        title: `${results.length} container${results.length !== 1 ? "s" : ""} assigned to ${results[0]?.toSupplierName}`,
      });
    },
    onError: (error: Error) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      queryClient.invalidateQueries({
        queryKey: ["/api/factory/suppliers", parentViewSupplierId, "direct-containers"],
      });
      toast({ title: "Assignment failed", description: error.message, variant: "destructive" });
    },
  });

  const updateObCommissionMutation = useMutation({
    mutationFn: async (data: OpeningCommissionUpdatePayload) =>
      factoryApiRequest("PATCH", `/api/factory/raw-stock/opening-balance/${data.rawStockId}`, data),
    onSuccess: () => {
      setEditObComm(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
    },
  });

  const allSuppliers = suppliers || [];
  const activeSuppliers = allSuppliers.filter((supplier) => supplier.isActive);
  const subAccountsByParent = allSuppliers.reduce<Record<number, SupplierWithBalance[]>>((accumulator, supplier) => {
    if (supplier.parentId) (accumulator[supplier.parentId] ||= []).push(supplier);
    return accumulator;
  }, {});
  const displayedTopLevel = (showInactive ? allSuppliers : activeSuppliers).filter((supplier) => !supplier.parentId);
  const isDirectoryBroker = (supplier: SupplierWithBalance) =>
    !!supplier.isBroker || !!subAccountsByParent[supplier.id]?.length;
  const brokerCount = displayedTopLevel.filter(isDirectoryBroker).length;
  const standaloneCount = displayedTopLevel.length - brokerCount;
  // Broker rows already roll up linked-supplier containers and exposure into their top-level totals.
  // Summing all suppliers would count linked suppliers twice in the summary cards.
  const summarySuppliers = displayedTopLevel;
  const totalContainers = summarySuppliers.reduce((sum, supplier) => sum + (supplier.totalContainers || 0), 0);
  // Directory KPI aggregates the same current-rate equivalent displayed on each
  // card. Missing FX rates make those suppliers unpriced, never zero or partial.
  // Broker-pool signs are not equivalent to ordinary payable account signs.
  const pricedSuppliers = summarySuppliers.filter((s) => s.usdEquivalentBalance != null);
  const unpricedSupplierCount = summarySuppliers.length - pricedSuppliers.length;
  const totalUsdOwed = pricedSuppliers.reduce((sum, supplier) => {
    const value = Number(supplier.usdEquivalentBalance);
    return value > 0 ? sum + value : sum;
  }, 0);
  const totalUsdOverpaid = pricedSuppliers.reduce((sum, supplier) => {
    const value = Number(supplier.usdEquivalentBalance);
    return value < 0 ? sum + Math.abs(value) : sum;
  }, 0);
  const filteredTopLevel = displayedTopLevel.filter((supplier) => {
    if (activeFilter === "brokers") return isDirectoryBroker(supplier);
    if (activeFilter === "standalone") return !isDirectoryBroker(supplier);
    if (activeFilter === "with-balance")
      return isDirectoryBroker(supplier)
        ? (supplier.brokerStatementBalances || []).some((pool) => Math.abs(Number(pool.balance)) > 0.005)
        : supplier.usdEquivalentBalance === null
          ? (supplier.currencyBalances || []).some((b) => Math.abs(b.balance) > 0.005)
          : Math.abs(Number(supplier.usdEquivalentBalance ?? supplier.totalValue ?? "0")) > 0.005;
    if (activeFilter === "zero-balance")
      return isDirectoryBroker(supplier)
        ? supplier.brokerStatementBalances != null &&
            supplier.brokerStatementBalances.every((pool) => Math.abs(Number(pool.balance)) <= 0.005)
        : supplier.usdEquivalentBalance !== null &&
            Math.abs(Number(supplier.usdEquivalentBalance ?? supplier.totalValue ?? "0")) <= 0.005;
    if (activeFilter === "has-foreign")
      return (supplier.currencyBalances || []).some((balance) => balance.currencyCode !== "USD");
    return true;
  });
  const directContainers = directContainersData || [];
  const isBrokerStatement = !!statementData?.linkedSupplierGroups?.length;

  const resetForm = (overrideParentId?: number | null) => {
    const parentId = overrideParentId !== undefined ? overrideParentId : createSubAccountParentId;
    setFormData({ name: "", contactPerson: "", phone: "", email: "", address: "", notes: "", parentId });
    setFormRole(parentId ? "linked" : "standalone");
  };
  const toggleStmtSection = (key: string) =>
    setCollapsedStmtSections((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const formatNum = (value: string) =>
    parseFloat(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const formatDate = (date: string) => formatDisplayDate(date);
  const formatKg = (value: string) =>
    `${parseFloat(value).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} kg`;
  const statusColor = (status: string) =>
    status === "OFFLOADED" ? "secondary" : status === "OTW" ? "outline" : "default";
  const statusDisplayLabel = (status: string) =>
    status === "OTW" ? "On the Way" : status.charAt(0) + status.slice(1).toLowerCase();

  return {
    wrapAdminAction,
    AdminDialog,
    today,
    createOpen,
    setCreateOpen,
    editingSupplier,
    setEditingSupplier,
    pendingDelete,
    setPendingDelete,
    statementSupplierId,
    setStatementSupplierId,
    statementReturnToParent,
    setStatementReturnToParent,
    statDateFilter,
    setStatDateFilter,
    parentViewSupplierId,
    setParentViewSupplierId,
    showInactive,
    setShowInactive,
    expandedSupplierIds,
    setExpandedSupplierIds,
    createSubAccountParentId,
    setCreateSubAccountParentId,
    activeFilter,
    setActiveFilter,
    formData,
    setFormData,
    formRole,
    setFormRole,
    listIncludeOtw,
    setListIncludeOtw,
    moveContainerDialog,
    setMoveContainerDialog,
    moveTargetSupplierId,
    setMoveTargetSupplierId,
    supplierIncludeOtw,
    setSupplierIncludeOtw,
    collapsedStmtSections,
    toggleStmtSection,
    brokerIncludeOtw,
    setBrokerIncludeOtw,
    assignTarget,
    setAssignTarget,
    paymentDialogSupplier,
    setPaymentDialogSupplier,
    paymentForm,
    setPaymentForm,
    ledgerAccounts,
    fxConversionOpen,
    setFxConversionOpen,
    fxSourceType,
    setFxSourceType,
    obEditSupplier,
    setObEditSupplier,
    obEditValue,
    setObEditValue,
    fxConversionForm,
    setFxConversionForm,
    bulkFxOpen,
    setBulkFxOpen,
    bulkFxBrokerId,
    setBulkFxBrokerId,
    bulkFxBrokerName,
    setBulkFxBrokerName,
    bulkFxForm,
    setBulkFxForm,
    bulkFxPreview,
    setBulkFxPreview,
    editObComm,
    setEditObComm,
    dueDialogSupplier,
    setDueDialogSupplier,
    statementData,
    statementLoading,
    statementError,
    brokerOverviewStatement,
    brokerOverviewLoading,
    directContainersLoading,
    directContainers,
    isLoading,
    allSuppliers,
    activeSuppliers,
    subAccountsByParent,
    brokerCount,
    standaloneCount,
    totalContainers,
    totalUsdOwed,
    totalUsdOverpaid,
    unpricedSupplierCount,
    filteredTopLevel,
    isBrokerStatement,
    bulkFxPreviewMutation,
    bulkFxMutation,
    fxConversionMutation,
    paymentMutation,
    deletePaymentMutation,
    deleteFxTransferMutation,
    deleteObCommissionMutation,
    createMutation,
    updateMutation,
    obEditMutation,
    deactivateMutation,
    reactivateMutation,
    permanentDeleteMutation,
    renameSupplierMutation,
    makeBrokerMutation,
    moveContainerMutation,
    assignContainersMutation,
    updateObCommissionMutation,
    resetForm,
    formatNum,
    formatDate,
    formatKg,
    statusColor,
    statusDisplayLabel,
  };
}
