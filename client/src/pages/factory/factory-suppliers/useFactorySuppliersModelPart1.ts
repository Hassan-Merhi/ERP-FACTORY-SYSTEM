// Extracted from ./useFactorySuppliersModel.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import type { FactorySupplier } from "@shared/schema";
import type { DirectContainer } from "./AssignContainersDialog";
import type { BulkFxPreview, StatementResponse, SupplierWithBalance } from "./factorySupplierTypes";
import {
  responseMessage,
  type BulkFxForm,
  type DueContainer,
  type FxConversionForm,
  type FxSourceType,
  type MoveContainerState,
  type OpeningBalanceEdit,
  type OpeningCommissionEdit,
  type PaymentForm,
  type SupplierFilter,
  type SupplierFormData,
} from "./useFactorySuppliersModelTypes";

export function useFactorySuppliersModelPart1() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const today = new Date().toLocaleDateString("en-CA");
  const recordChanges = useExistingRecordChangeAccess();
  const canCreateSupplier = recordChanges.canCreate("POST", "/api/factory/suppliers");
  const canRecordSupplierPayment = recordChanges.canCreate("POST", "/api/factory/supplier-payments");
  const canRecordFxTransfer = recordChanges.canCreate("POST", "/api/factory/supplier-fx-transfers");

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
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
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
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
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
  return {
    AdminDialog,
    activeFilter,
    assignTarget,
    brokerIncludeOtw,
    brokerOverviewLoading,
    brokerOverviewStatement,
    bulkFxBrokerId,
    bulkFxBrokerName,
    bulkFxForm,
    bulkFxMutation,
    bulkFxOpen,
    bulkFxPreview,
    bulkFxPreviewMutation,
    canCreateSupplier,
    canRecordFxTransfer,
    canRecordSupplierPayment,
    collapsedStmtSections,
    createOpen,
    createSubAccountParentId,
    directContainersData,
    directContainersLoading,
    dueDialogSupplier,
    editObComm,
    editingSupplier,
    expandedSupplierIds,
    formData,
    formRole,
    formatDisplayDate,
    fxConversionForm,
    fxConversionOpen,
    fxSourceType,
    isLoading,
    ledgerAccounts,
    listIncludeOtw,
    moveContainerDialog,
    moveTargetSupplierId,
    obEditSupplier,
    obEditValue,
    parentViewSupplierId,
    paymentDialogSupplier,
    paymentForm,
    pendingDelete,
    recordChanges,
    setActiveFilter,
    setAssignTarget,
    setBrokerIncludeOtw,
    setBulkFxBrokerId,
    setBulkFxBrokerName,
    setBulkFxForm,
    setBulkFxOpen,
    setBulkFxPreview,
    setCollapsedStmtSections,
    setCreateOpen,
    setCreateSubAccountParentId,
    setDueDialogSupplier,
    setEditObComm,
    setEditingSupplier,
    setExpandedSupplierIds,
    setFormData,
    setFormRole,
    setFxConversionForm,
    setFxConversionOpen,
    setFxSourceType,
    setListIncludeOtw,
    setMoveContainerDialog,
    setMoveTargetSupplierId,
    setObEditSupplier,
    setObEditValue,
    setParentViewSupplierId,
    setPaymentDialogSupplier,
    setPaymentForm,
    setPendingDelete,
    setShowInactive,
    setStatDateFilter,
    setStatementReturnToParent,
    setStatementSupplierId,
    setSupplierIncludeOtw,
    showInactive,
    statDateFilter,
    statementData,
    statementError,
    statementLoading,
    statementReturnToParent,
    statementSupplierId,
    supplierIncludeOtw,
    suppliers,
    toast,
    today,
    wrapAdminAction,
  };
}
