// Extracted from ./useFactoryInvoiceDetailModel.tsx to keep that module under the source-size cap.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useAppMode } from "@/contexts/AppModeContext";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { getApiRequest } from "@/lib/factoryApi";
import { useLocation, useRoute } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { queryClient } from "@/lib/queryClient";
import { useRef, useState } from "react";
import type { OrderDetail } from "./types";

export function useFactoryInvoiceDetailModelPart1() {
  const { selectedCompany } = useCompany();
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  // Every mutation below changes this existing invoice/loading.
  const recordChanges = useExistingRecordChangeAccess();
  const assertCanChange = () => {
    if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
  };
  const [editingArticleCode, setEditingArticleCode] = useState<string | null>(null);
  const [editingChargeLedger, setEditingChargeLedger] = useState<number | null>(null);
  const [editingChargeAmount, setEditingChargeAmount] = useState<number | null>(null);
  const [chargeAmountInput, setChargeAmountInput] = useState("");
  const [showAddCharge, setShowAddCharge] = useState(false);
  const [newChargeName, setNewChargeName] = useState("");
  const [newChargeAmount, setNewChargeAmount] = useState("");
  const [newChargeType, setNewChargeType] = useState("FREIGHT");
  const [newChargeLedgerId, setNewChargeLedgerId] = useState<string>("");
  const [editValue, setEditValue] = useState("");
  const [revertDialogOpen, setRevertDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [baleRefArticle, setBaleRefArticle] = useState<{ code: string; name: string } | null>(null);
  const [exchangeBale, setExchangeBale] = useState<{ orderBaleId: number; reference: string } | null>(null);
  const [newRefInput, setNewRefInput] = useState("");
  const [removeBaleState, setRemoveBaleState] = useState<{ orderBaleId: number; reference: string } | null>(null);
  const [showProformaDialog, setShowProformaDialog] = useState(false);
  const [selectedProformaId, setSelectedProformaId] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);
  const fromAnalytics =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("from") === "analytics";
  useEscapeToParent(fromAnalytics ? "/factory/analytics" : "/factory/invoicing?tab=invoices");
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [, params] = useRoute("/factory/sales/invoices/:id");

  const orderId = params?.id ? parseInt(params.id) : null;

  const { data: order, isLoading } = useQuery<OrderDetail>({
    queryKey: companyQueryKey("/api/factory/customer-orders", selectedCompany?.id, orderId),
    queryFn: async () => {
      const res = await fetch(`/api/factory/customer-orders/${orderId}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    enabled: !!orderId && Boolean(selectedCompany?.id),
  });

  const { data: ledgerAccounts = [] } = useQuery<{ id: number; name: string; code: string }[]>({
    queryKey: companyQueryKey("/api/ledger-accounts?includeHidden=true", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const updateChargeLedgerMutation = useMutation({
    mutationFn: async ({ chargeId, ledgerAccountId }: { chargeId: number; ledgerAccountId: number | null }) => {
      assertCanChange();
      const res = await modeApiRequest("PATCH", `/api/factory/customer-orders/${orderId}/charges/${chargeId}`, {
        ledgerAccountId,
      });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to update charge");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders"] });
      setEditingChargeLedger(null);
      toast({ title: "Ledger account updated" });
    },
    onError: (e: Error) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const addChargeMutation = useMutation({
    mutationFn: async ({
      name,
      amount,
      chargeType,
      ledgerAccountId,
    }: {
      name: string;
      amount: number;
      chargeType: string;
      ledgerAccountId: number | null;
    }) => {
      assertCanChange();
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/charges`, {
        name,
        amount,
        chargeType,
        ledgerAccountId,
      });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to add charge");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders"] });
      setShowAddCharge(false);
      setNewChargeName("");
      setNewChargeAmount("");
      setNewChargeType("FREIGHT");
      setNewChargeLedgerId("");
      if (data?.warning) {
        toast({ title: "Charge added — ledger entry skipped", description: data.warning, variant: "destructive" });
      } else {
        toast({ title: "Charge added", description: "Accounting voucher posted." });
      }
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const relinkVouchersMutation = useMutation({
    mutationFn: async () => {
      assertCanChange();
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/charges/relink-vouchers`, {});
      if (!res.ok) throw new Error((await res.json()).message || "Failed to relink");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders"] });
      toast({ title: data.linked > 0 ? "Ledger entries created" : "Nothing to relink", description: data.message });
    },
    onError: (e: Error) => toast({ title: "Linking failed", description: e.message, variant: "destructive" }),
  });

  const updateChargeAmountMutation = useMutation({
    mutationFn: async ({ chargeId, amount }: { chargeId: number; amount: number }) => {
      assertCanChange();
      const res = await modeApiRequest("PATCH", `/api/factory/customer-orders/${orderId}/charges/${chargeId}`, {
        amount,
      });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to update charge amount");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders"] });
      setEditingChargeAmount(null);
      setChargeAmountInput("");
      toast({ title: "Charge amount updated" });
    },
    onError: (e: Error) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });
  const { data: me } = useQuery<{ role: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = me?.role === "Developer";

  type ProformaPriceLine = { articleCode: string; pricePerBale: string };
  type ProformaSummary = { id: number; name: string; lineCount: number; lines?: ProformaPriceLine[] };

  const { data: proformas = [] } = useQuery<ProformaSummary[]>({
    queryKey: companyQueryKey("/api/factory/customer-proformas", selectedCompany?.id, order?.customerId, "summary"),
    queryFn: async () => {
      if (!order?.customerId) return [];
      const res = await fetch(`/api/factory/customer-proformas?customerId=${order.customerId}&profile=summary`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch proformas");
      return res.json();
    },
    enabled: !!order?.customerId && showProformaDialog && Boolean(selectedCompany?.id),
    staleTime: 5 * 60_000,
  });

  const { data: selectedProforma } = useQuery<ProformaSummary>({
    queryKey: companyQueryKey("/api/factory/customer-proformas", selectedCompany?.id, selectedProformaId, "detail"),
    queryFn: async () => {
      const res = await fetch(`/api/factory/customer-proformas/${selectedProformaId}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(res.statusText || String(res.status));
      return res.json();
    },
    enabled: showProformaDialog && !!selectedProformaId && Boolean(selectedCompany?.id),
    staleTime: 60_000,
  });

  interface DispatchBatchSummary {
    batch: { id: number; batchNumber: string; batchDate: string; status: string; currency: string };
    customerName: string | null;
    proforma: { id: number; name: string } | null;
    rides: { id: number; rideNumber: number; status: string; baleCount: number | string; totalWeightKg: string }[];
    totals: { totalBales: number; totalWeightKg: string; grandTotal: string };
  }
  const { data: dispatchBatch } = useQuery<DispatchBatchSummary>({
    queryKey: companyQueryKey("/api/factory/dispatch-batches", selectedCompany?.id, order?.dispatchBatchId),
    queryFn: async () => {
      const res = await fetch(`/api/factory/dispatch-batches/${order!.dispatchBatchId}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!order?.dispatchBatchId && Boolean(selectedCompany?.id),
  });

  const accessReady = myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true;
  const hideExportSelling =
    !accessReady ||
    myAccess?.hideAllCosts === true ||
    myAccess?.hiddenCostFields.includes("hide_export_selling_price") === true;
  const isAdmin = accessReady && myAccess?.fullAccess === true;
  return {
    addChargeMutation,
    assertCanChange,
    baleRefArticle,
    chargeAmountInput,
    deleteDialogOpen,
    dispatchBatch,
    editValue,
    editingArticleCode,
    editingChargeAmount,
    editingChargeLedger,
    exchangeBale,
    formatDisplayDate,
    hideExportSelling,
    inputRef,
    isAdmin,
    isDeveloper,
    isLoading,
    ledgerAccounts,
    modeApiRequest,
    navigate,
    newChargeAmount,
    newChargeLedgerId,
    newChargeName,
    newChargeType,
    newRefInput,
    order,
    orderId,
    proformas,
    recordChanges,
    relinkVouchersMutation,
    removeBaleState,
    revertDialogOpen,
    selectedProforma,
    selectedProformaId,
    setBaleRefArticle,
    setChargeAmountInput,
    setDeleteDialogOpen,
    setEditValue,
    setEditingArticleCode,
    setEditingChargeAmount,
    setEditingChargeLedger,
    setExchangeBale,
    setNewChargeAmount,
    setNewChargeLedgerId,
    setNewChargeName,
    setNewChargeType,
    setNewRefInput,
    setRemoveBaleState,
    setRevertDialogOpen,
    setSelectedProformaId,
    setShowAddCharge,
    setShowProformaDialog,
    showAddCharge,
    showProformaDialog,
    toast,
    updateChargeAmountMutation,
    updateChargeLedgerMutation,
  };
}
