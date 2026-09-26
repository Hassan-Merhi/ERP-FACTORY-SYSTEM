import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useCompany } from "@/contexts/CompanyContext";
import { Badge } from "@/components/ui/badge";
import { useLocation, useRoute } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { queryClient, keyStartsWith, invalidateCustomerBalances } from "@/lib/queryClient";
import { useState, useRef } from "react";
import type { OrderDetail } from "./types";

export function useFactoryInvoiceDetailModel() {
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const { selectedCompany: _selectedCompany } = useCompany();
  const [, navigate] = useLocation();
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
  const analyticsNoChargesView =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("view") === "no-charges";
  useEscapeToParent(analyticsNoChargesView ? "/factory/analytics" : "/factory/invoicing?tab=invoices");
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [, params] = useRoute("/factory/sales/invoices/:id");

  const orderId = params?.id ? parseInt(params.id) : null;

  const { data: order, isLoading } = useQuery<OrderDetail>({
    queryKey: ["/api/factory/customer-orders", orderId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/customer-orders/${orderId}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    enabled: !!orderId,
  });

  const { data: ledgerAccounts = [] } = useQuery<{ id: number; name: string; code: string }[]>({
    queryKey: ["/api/ledger-accounts?includeHidden=true"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const updateChargeLedgerMutation = useMutation({
    mutationFn: async ({ chargeId, ledgerAccountId }: { chargeId: number; ledgerAccountId: number | null }) => {
      const res = await modeApiRequest("PATCH", `/api/factory/customer-orders/${orderId}/charges/${chargeId}`, {
        ledgerAccountId,
      });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to update charge");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      setEditingChargeLedger(null);
      toast({ title: "Ledger account updated" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
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
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
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
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const relinkVouchersMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/charges/relink-vouchers`, {});
      if (!res.ok) throw new Error((await res.json()).message || "Failed to relink");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      toast({ title: data.linked > 0 ? "Ledger entries created" : "Nothing to relink", description: data.message });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const updateChargeAmountMutation = useMutation({
    mutationFn: async ({ chargeId, amount }: { chargeId: number; amount: number }) => {
      const res = await modeApiRequest("PATCH", `/api/factory/customer-orders/${orderId}/charges/${chargeId}`, {
        amount,
      });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to update charge amount");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      setEditingChargeAmount(null);
      setChargeAmountInput("");
      toast({ title: "Charge amount updated" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const { data: myAccess } = useQuery<{ hiddenCostFields: string[]; fullAccess?: boolean }>({
    queryKey: ["/api/factory/my-access"],
  });
  const { data: me } = useQuery<{ role: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = me?.role === "Developer";

  type ProformaPriceLine = { articleCode: string; pricePerBale: string };
  type ProformaSummary = { id: number; name: string; lineCount: number; lines?: ProformaPriceLine[] };

  const { data: proformas = [] } = useQuery<ProformaSummary[]>({
    queryKey: ["/api/factory/customer-proformas", order?.customerId, "summary"],
    queryFn: async () => {
      if (!order?.customerId) return [];
      const res = await fetch(`/api/factory/customer-proformas?customerId=${order.customerId}&profile=summary`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch proformas");
      return res.json();
    },
    enabled: !!order?.customerId && showProformaDialog,
    staleTime: 5 * 60_000,
  });

  const { data: selectedProforma } = useQuery<ProformaSummary>({
    queryKey: ["/api/factory/customer-proformas", selectedProformaId, "detail"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/customer-proformas/${selectedProformaId}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(res.statusText || String(res.status));
      return res.json();
    },
    enabled: showProformaDialog && !!selectedProformaId,
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
    queryKey: ["/api/factory/dispatch-batches", order?.dispatchBatchId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/dispatch-batches/${order!.dispatchBatchId}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!order?.dispatchBatchId,
  });

  const hideExportSelling = (myAccess?.hiddenCostFields ?? []).includes("hide_export_selling_price");
  const isAdmin = myAccess?.fullAccess === true;

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "DRAFT":
        return (
          <Badge variant="secondary" data-testid="badge-status-draft">
            Draft
          </Badge>
        );
      case "LOADING":
        return (
          <Badge
            variant="outline"
            className="bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800"
            data-testid="badge-status-loading"
          >
            Loading
          </Badge>
        );
      case "PENDING_VERIFICATION":
      case "VERIFIED":
        return (
          <Badge
            variant="outline"
            className="bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800"
            data-testid="badge-status-verified"
          >
            Verified
          </Badge>
        );
      case "FINALIZED":
        return (
          <Badge variant="default" data-testid="badge-status-finalized">
            Finalized
          </Badge>
        );
      case "CANCELLED":
        return (
          <Badge variant="destructive" data-testid="badge-status-cancelled">
            Cancelled
          </Badge>
        );
      default:
        return (
          <Badge variant="secondary" data-testid="badge-status-unknown">
            {status}
          </Badge>
        );
    }
  };

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await modeApiRequest("DELETE", `/api/factory/customer-orders/${id}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to delete");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Deleted", description: "Invoice deleted successfully." });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      invalidateCustomerBalances(order?.customerId ?? undefined);
      navigate("/factory/invoicing?tab=invoices");
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const repriceMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/reprice`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to reprice");
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (data.repriced === 0) {
        toast({
          title: "Prices already current",
          description: "All bale prices already match the current catalogue — no changes needed.",
        });
      } else {
        toast({
          title: "Prices updated",
          description: `Updated ${data.repriced} bale(s) to current catalogue prices.`,
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const repriceArticleMutation = useMutation({
    mutationFn: async ({ articleCode, pricePerBale }: { articleCode: string; pricePerBale: number }) => {
      const res = await modeApiRequest("PATCH", `/api/factory/customer-orders/${orderId}/bales/reprice-article`, {
        articleCode,
        pricePerBale,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to update price");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Price updated",
        description: "All bales for this article have been repriced and totals recalculated.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      setEditingArticleCode(null);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
      setEditingArticleCode(null);
    },
  });

  const unfinalizeMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/unfinalize`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to revert invoice");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Invoice reverted successfully", description: "The original workflow stage has been restored." });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      invalidateCustomerBalances(order?.customerId ?? undefined);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Cannot revert", description: error.message, variant: "destructive" });
    },
  });

  const repriceProductionMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/reprice-production`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to apply production prices");
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (data.repriced === 0) {
        toast({
          title: "Already at production prices",
          description: "All bale prices already match the current production prices — no changes needed.",
        });
      } else {
        toast({
          title: "Production prices applied",
          description: `Updated ${data.repriced} bale(s) to production prices.`,
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const applyProformaMutation = useMutation({
    mutationFn: async (proformaId: number) => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/apply-proforma-prices`, {
        proformaId,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to apply proforma prices");
      }
      return res.json();
    },
    onSuccess: (data) => {
      const repriced = data?.repriced ?? 0;
      if (repriced === 0) {
        toast({
          title: "No changes",
          description: "All bale prices already match the selected proforma — no updates needed.",
        });
      } else {
        toast({ title: "Proforma prices applied", description: `Updated ${repriced} bale(s).` });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      setShowProformaDialog(false);
      setSelectedProformaId("");
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const exchangeMutation = useMutation({
    mutationFn: async ({ orderBaleId, newBaleReference }: { orderBaleId: number; newBaleReference: string }) => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/bales/exchange`, {
        orderBaleId,
        newBaleReference,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to exchange bale");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Bale exchanged", description: `Replaced successfully.` });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      setExchangeBale(null);
      setNewRefInput("");
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const removeBaleMutation = useMutation({
    mutationFn: async (orderBaleId: number) => {
      const res = await modeApiRequest("DELETE", `/api/factory/customer-orders/${orderId}/bales/${orderBaleId}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to remove bale");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Bale removed", description: "Bale returned to stock." });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      setRemoveBaleState(null);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const startEdit = (articleCode: string, currentPrice: number) => {
    setEditingArticleCode(articleCode);
    setEditValue(String(currentPrice));
    setTimeout(() => inputRef.current?.select(), 30);
  };

  const commitEdit = (articleCode: string) => {
    const price = parseFloat(editValue);
    if (isNaN(price) || price < 0) {
      toast({ title: "Invalid price", description: "Please enter a valid number.", variant: "destructive" });
      setEditingArticleCode(null);
      return;
    }
    repriceArticleMutation.mutate({ articleCode, pricePerBale: price });
  };

  const cancelEdit = () => {
    setEditingArticleCode(null);
    setEditValue("");
  };

  // Shared helper: fetch a binary file from the server and trigger a browser download.
  // Using fetch+blob instead of window.open() ensures auth cookies are always sent,
  // errors surface as toast messages, and stalled 0-byte downloads are avoided.
  const downloadFromUrl = async (url: string, fallbackName: string) => {
    try {
      const res = await fetch(url, { credentials: "include", cache: "no-store" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Server error ${res.status}`);
      }
      const blob = await res.blob();
      if (blob.size === 0) {
        throw new Error("Server returned an empty file.");
      }
      const cd = res.headers.get("content-disposition") || "";
      // Handle both  filename*=UTF-8''encoded-name  and  filename="plain-name"
      const starMatch = cd.match(/filename\*=UTF-8''([^;\s]+)/i);
      const plainMatch = cd.match(/filename="([^"]+)"/i);
      const rawName = starMatch ? starMatch[1] : plainMatch ? plainMatch[1] : null;
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = rawName ? decodeURIComponent(rawName) : fallbackName;
      document.body.appendChild(a);
      a.click();
      // Delay cleanup so Chrome has time to consume the blob URL before it is revoked.
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);
      }, 10000);
    } catch (err) {
      toast({ title: "Export failed", description: getErrorDetails(err).message, variant: "destructive" });
    }
  };

  const handleExportExcel = () => {
    if (!orderId) return;
    downloadFromUrl(`/api/factory/customer-orders/${orderId}/export-excel`, "invoice.xlsx");
  };

  const handleExportExcelNoCharges = () => {
    if (!orderId) return;
    downloadFromUrl(`/api/factory/customer-orders/${orderId}/export-excel?noCharges=1`, "invoice-no-charges.xlsx");
  };

  const handleExportPdf = () => {
    if (!orderId) return;
    downloadFromUrl(`/api/factory/customer-orders/${orderId}/export-pdf`, "invoice.pdf");
  };

  const handleExportPdfNoCharges = () => {
    if (!orderId) return;
    downloadFromUrl(`/api/factory/customer-orders/${orderId}/export-pdf?noCharges=1`, "invoice-no-charges.pdf");
  };

  const handleExportLoadingStatus = () => {
    if (!orderId) return;
    downloadFromUrl(`/api/factory/customer-orders/${orderId}/loading-status-export`, "loading-status.xlsx");
  };

  return {
    formatDisplayDate,
    navigate,
    editingArticleCode,
    editingChargeLedger,
    setEditingChargeLedger,
    editingChargeAmount,
    setEditingChargeAmount,
    chargeAmountInput,
    setChargeAmountInput,
    showAddCharge,
    setShowAddCharge,
    newChargeName,
    setNewChargeName,
    newChargeAmount,
    setNewChargeAmount,
    newChargeType,
    setNewChargeType,
    newChargeLedgerId,
    setNewChargeLedgerId,
    editValue,
    setEditValue,
    revertDialogOpen,
    setRevertDialogOpen,
    deleteDialogOpen,
    setDeleteDialogOpen,
    baleRefArticle,
    setBaleRefArticle,
    exchangeBale,
    setExchangeBale,
    newRefInput,
    setNewRefInput,
    removeBaleState,
    setRemoveBaleState,
    showProformaDialog,
    setShowProformaDialog,
    selectedProformaId,
    setSelectedProformaId,
    inputRef,
    orderId,
    order,
    isLoading,
    ledgerAccounts,
    updateChargeLedgerMutation,
    addChargeMutation,
    relinkVouchersMutation,
    updateChargeAmountMutation,
    isDeveloper,
    proformas,
    selectedProforma,
    dispatchBatch,
    hideExportSelling,
    isAdmin,
    getStatusBadge,
    deleteMutation,
    repriceMutation,
    repriceArticleMutation,
    unfinalizeMutation,
    repriceProductionMutation,
    applyProformaMutation,
    exchangeMutation,
    removeBaleMutation,
    startEdit,
    commitEdit,
    cancelEdit,
    handleExportExcel,
    handleExportExcelNoCharges,
    handleExportPdf,
    handleExportPdfNoCharges,
    handleExportLoadingStatus,
  } as const;
}
