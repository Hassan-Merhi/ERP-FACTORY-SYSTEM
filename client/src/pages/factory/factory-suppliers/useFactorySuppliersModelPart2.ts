// Extracted from ./useFactorySuppliersModel.tsx to keep that module under the source-size cap.
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import type { SupplierWithBalance } from "./factorySupplierTypes";
import {
  responseMessage,
  type FxConversionForm,
  type MoveResult,
  type OpeningCommissionUpdatePayload,
  type PaymentForm,
  type SupplierFormData,
  type SupplierPatch,
} from "./useFactorySuppliersModelTypes";
import { useFactorySuppliersModelPart1 } from "./useFactorySuppliersModelPart1";

export function useFactorySuppliersModelPart2({
  activeFilter,
  createSubAccountParentId,
  directContainersData,
  parentViewSupplierId,
  recordChanges,
  setAssignTarget,
  setCreateOpen,
  setEditObComm,
  setEditingSupplier,
  setFormData,
  setFormRole,
  setFxConversionOpen,
  setMoveContainerDialog,
  setMoveTargetSupplierId,
  setObEditSupplier,
  setPaymentDialogSupplier,
  showInactive,
  statementData,
  statementSupplierId,
  suppliers,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useFactorySuppliersModelPart1>>,
  | "activeFilter"
  | "createSubAccountParentId"
  | "directContainersData"
  | "parentViewSupplierId"
  | "recordChanges"
  | "setAssignTarget"
  | "setCreateOpen"
  | "setEditObComm"
  | "setEditingSupplier"
  | "setFormData"
  | "setFormRole"
  | "setFxConversionOpen"
  | "setMoveContainerDialog"
  | "setMoveTargetSupplierId"
  | "setObEditSupplier"
  | "setPaymentDialogSupplier"
  | "showInactive"
  | "statementData"
  | "statementSupplierId"
  | "suppliers"
  | "toast"
>) {
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
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return factoryApiRequest("DELETE", `/api/factory/supplier-payments/${id}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] }),
  });
  const deleteFxTransferMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return factoryApiRequest("DELETE", `/api/factory/supplier-fx-transfers/${id}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] }),
  });
  const deleteObCommissionMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return factoryApiRequest("DELETE", `/api/factory/raw-stock/opening-balance/${id}`);
    },
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
    mutationFn: async (data: SupplierPatch) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return factoryApiRequest("PATCH", `/api/factory/suppliers/${data.id}`, data);
    },
    onSuccess: () => {
      setEditingSupplier(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
    },
  });
  const obEditMutation = useMutation({
    mutationFn: async (data: { id: number; openingBalance: string }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return factoryApiRequest("PATCH", `/api/factory/suppliers/${data.id}/opening-balance`, {
        openingBalance: data.openingBalance,
      });
    },
    onSuccess: () => {
      setObEditSupplier(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
    },
  });
  const deactivateMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return factoryApiRequest("POST", `/api/factory/suppliers/${id}/deactivate`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] }),
  });
  const reactivateMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return factoryApiRequest("POST", `/api/factory/suppliers/${id}/reactivate`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] }),
  });
  const permanentDeleteMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return factoryApiRequest("DELETE", `/api/factory/suppliers/${id}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] }),
  });
  const renameSupplierMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return factoryApiRequest("PATCH", `/api/factory/suppliers/${id}`, { name });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers", statementSupplierId, "statement"] });
    },
  });
  const makeBrokerMutation = useMutation({
    mutationFn: async ({ id, isBroker }: { id: number; isBroker: boolean }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
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
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
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
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
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
    mutationFn: async (data: OpeningCommissionUpdatePayload) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return factoryApiRequest("PATCH", `/api/factory/raw-stock/opening-balance/${data.rawStockId}`, data);
    },
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
  // UI-only: company 12's BANIN is supplier #34. Keep its records and ledger
  // intact, but never include it in this directory (even with Show Inactive).
  // Directory KPIs also use this visible set; other financial reports do not.
  const hiddenDirectorySupplierIds = new Set([34]);
  const displayedTopLevel = (showInactive ? allSuppliers : activeSuppliers).filter(
    (supplier) => !supplier.parentId && !hiddenDirectorySupplierIds.has(supplier.id)
  );
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
  return {
    activeSuppliers,
    allSuppliers,
    assignContainersMutation,
    brokerCount,
    createMutation,
    deactivateMutation,
    deleteFxTransferMutation,
    deleteObCommissionMutation,
    deletePaymentMutation,
    directContainers,
    filteredTopLevel,
    fxConversionMutation,
    isBrokerStatement,
    makeBrokerMutation,
    moveContainerMutation,
    obEditMutation,
    paymentMutation,
    permanentDeleteMutation,
    reactivateMutation,
    renameSupplierMutation,
    resetForm,
    standaloneCount,
    subAccountsByParent,
    totalContainers,
    totalUsdOverpaid,
    totalUsdOwed,
    unpricedSupplierCount,
    updateMutation,
    updateObCommissionMutation,
  };
}
