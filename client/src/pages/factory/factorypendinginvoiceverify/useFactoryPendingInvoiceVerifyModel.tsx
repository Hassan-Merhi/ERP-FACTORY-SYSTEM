import { getErrorDetails } from "@shared/errorUtils";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient, keyStartsWith } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useCompany } from "@/contexts/CompanyContext";
import { useLocation, useParams } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { CheckCircle } from "lucide-react";
import { useState, useEffect } from "react";
import type { ComparisonItem, FinalizePreview, OrderDetail, VerificationSummary } from "./types";

export function useFactoryPendingInvoiceVerifyModel() {
  const { toast } = useToast();
  const { selectedCompany: _selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  useEscapeToParent("/factory/invoicing?tab=invoices");
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const params = useParams<{ id: string }>();
  const orderId = params.id;

  const [containerNumber, setContainerNumber] = useState("");
  const [shippingCompany, setShippingCompany] = useState("");
  const [containerNotes, setContainerNotes] = useState("");
  const [destination, setDestination] = useState("");
  const [containerInitialized, setContainerInitialized] = useState(false);

  const [chargeName, setChargeName] = useState("");
  const [chargeAmount, setChargeAmount] = useState("");
  const [chargeType, setChargeType] = useState("FREIGHT");
  const [chargeLedgerAccountId, setChargeLedgerAccountId] = useState<string>("");
  const [chargeAccountOpen, setChargeAccountOpen] = useState(false);

  const [showApproveDialog, setShowApproveDialog] = useState(false);
  const [showReturnDialog, setShowReturnDialog] = useState(false);
  const [approveNotes, setApproveNotes] = useState("");
  const [showFinalizePreview, setShowFinalizePreview] = useState(false);
  const [finalizePreview, setFinalizePreview] = useState<FinalizePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showPriceWarning, setShowPriceWarning] = useState(false);
  const [unpricedItems, setUnpricedItems] = useState<string[]>([]);
  const [pendingFinalizeData, setPendingFinalizeData] = useState<FinalizePreview | null>(null);
  const [showFixBalesDialog, setShowFixBalesDialog] = useState(false);
  const [invoiceDate, setInvoiceDate] = useState(new Date().toLocaleDateString("en-CA"));

  const [showProformaDialog, setShowProformaDialog] = useState(false);
  const [showViewProformaDialog, setShowViewProformaDialog] = useState(false);
  const [selectedProformaId, setSelectedProformaId] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [showRecoverDialog, setShowRecoverDialog] = useState(false);
  const [recoverInput, setRecoverInput] = useState("");
  const [recoverTab, setRecoverTab] = useState<"auto" | "manual">("auto");

  const { data: verification, isLoading: verificationLoading } = useQuery<VerificationSummary>({
    queryKey: ["/api/factory/customer-orders", orderId, "verification"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/customer-orders/${orderId}/verification-summary`, {
        credentials: "include",
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.message || `Server error ${res.status} on verification-summary`);
      }
      return res.json();
    },
    enabled: !!orderId,
  });

  const { data: orderDetail, isLoading: orderLoading } = useQuery<OrderDetail>({
    queryKey: ["/api/factory/customer-orders", orderId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/customer-orders/${orderId}`, { credentials: "include" });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.message || `Server error ${res.status} on order detail`);
      }
      return res.json();
    },
    enabled: !!orderId,
  });

  const { data: currentUser } = useQuery<{ role?: string }>({
    queryKey: ["/api/auth/me"],
    retry: false,
  });
  const isAdminOrOwner =
    currentUser?.role === "Admin" || currentUser?.role === "Owner" || currentUser?.role === "Developer";
  const isDeveloper = currentUser?.role === "Developer";

  const { data: ledgerAccounts = [] } = useQuery<{ id: number; name: string; code: string; accountType: string }[]>({
    queryKey: ["/api/ledger-accounts?profile=picker"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  type ProformaPriceLine = {
    articleCode: string;
    pricePerBale: string;
    pricingMode?: string | null;
    pricePerKg?: string | null;
    weightPerBaleKg?: string | null;
  };
  type ProformaSummary = { id: number; name: string; lineCount: number; lines?: ProformaPriceLine[] };

  const { data: proformas = [] } = useQuery<ProformaSummary[]>({
    queryKey: ["/api/factory/customer-proformas", orderDetail?.customerId, "summary"],
    queryFn: async () => {
      if (!orderDetail?.customerId) return [];
      const res = await fetch(
        `/api/factory/customer-proformas?customerId=${orderDetail.customerId}&profile=summary`,
        {
          credentials: "include",
        }
      );
      if (!res.ok) throw new Error("Failed to fetch proformas");
      return res.json();
    },
    enabled: !!orderDetail?.customerId && (showProformaDialog || showViewProformaDialog),
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

  useEffect(() => {
    if (orderDetail && !containerInitialized) {
      setContainerNumber(orderDetail.containerNumber || "");
      setShippingCompany(orderDetail.shippingCompany || "");
      setContainerNotes(orderDetail.containerNotes || "");
      setDestination(orderDetail.destination || "");
      setContainerInitialized(true);
    }
  }, [orderDetail, containerInitialized]);

  const verifyMutation = useMutation({
    mutationFn: async (data: { approved: boolean; notes?: string }) => {
      await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/verify`, data);
    },
    onSuccess: () => {
      toast({ title: "Order verified", description: "Now add charges and finalize the invoice" });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const returnToLoadingMutation = useMutation({
    mutationFn: async () => {
      await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/return-to-loading`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      toast({ title: "Returned to loading", description: "The order has been returned for further loading" });
      navigate("/factory/invoicing?tab=invoices");
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const assignContainerMutation = useMutation({
    mutationFn: async (data: {
      containerNumber: string;
      shippingCompany: string;
      containerNotes: string;
      destination: string;
    }) => {
      await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/assign-container`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      toast({ title: "Container info saved" });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const addChargeMutation = useMutation({
    mutationFn: async (data: { name: string; amount: number; chargeType: string; ledgerAccountId?: number }) => {
      await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/charges`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      setChargeName("");
      setChargeLedgerAccountId("");
      setChargeAmount("");
      toast({ title: "Charge added" });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const removeChargeMutation = useMutation({
    mutationFn: async (chargeId: number) => {
      await modeApiRequest("DELETE", `/api/factory/customer-orders/${orderId}/charges/${chargeId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      toast({ title: "Charge removed" });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async (txDate?: string) => {
      await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/finalize`, { txDate });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
      toast({ title: "Invoice finalized", description: "Invoice has been created successfully" });
      navigate(`/factory/sales/invoices/${orderId}`);
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const forceSyncMutation = useMutation({
    mutationFn: async () => {
      await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/force-sync-bale-status`);
    },
    onSuccess: () => {
      toast({ title: "Bales fixed", description: "Bale statuses have been set to SOLD" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId, "verification"] });
      setShowFixBalesDialog(false);
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const recoverBalesMutation = useMutation({
    mutationFn: async (baleReferences: string[]) => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/recover-bales`, {
        baleReferences,
      });
      return res.json();
    },
    onSuccess: (data: { message: string; linked: number; notFound: string[] }) => {
      toast({
        title: `${data.linked} bale(s) recovered`,
        description:
          data.notFound.length > 0
            ? `Not found: ${data.notFound.slice(0, 5).join(", ")}${data.notFound.length > 5 ? ` (+${data.notFound.length - 5} more)` : ""}`
            : data.message,
      });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      setShowRecoverDialog(false);
      setRecoverInput("");
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Recovery failed", description: error.message, variant: "destructive" });
    },
  });

  const autoRecoverMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/auto-recover-bales`, {});
      return res.json();
    },
    onSuccess: (data: {
      message: string;
      linked: number;
      summary: { articleCode: string; linked: number; needed: number }[];
    }) => {
      toast({
        title: `${data.linked} bale(s) auto-linked`,
        description: data.summary.map((s) => `${s.articleCode}: ${s.linked}/${s.needed}`).join(", "),
      });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      setShowRecoverDialog(false);
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Auto-recover failed", description: error.message, variant: "destructive" });
    },
  });

  const applyProformaMutation = useMutation({
    mutationFn: async (proformaId: number) => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/apply-proforma-prices`, {
        proformaId,
      });
      return res.json();
    },
    onSuccess: (data) => {
      const repriced = data?.repriced ?? 0;
      toast({ title: "Proforma prices applied", description: `${repriced} bale${repriced !== 1 ? "s" : ""} updated` });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      setShowProformaDialog(false);
      setSelectedProformaId("");
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const applyProductionPricesMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/reprice-production`, {});
      return res.json();
    },
    onSuccess: (data) => {
      const updated = data?.updated ?? data?.repriced ?? 0;
      toast({ title: "Production Prices Applied", description: `${updated} bale(s) updated` });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const applySellingPricesMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/reprice`, {});
      return res.json();
    },
    onSuccess: (data) => {
      const updated = data?.updated ?? data?.repriced ?? 0;
      toast({ title: "Selling Prices Applied", description: `${updated} bale(s) updated` });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const repairPerKgMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", "/api/factory/repair-perkg-prices", {});
      return res.json();
    },
    onSuccess: (data: {
      ordersScanned: number;
      balesRepaired: number;
      changedOrderIds: number[];
      errors: string[];
    }) => {
      toast({
        title: `Repair complete: ${data.balesRepaired} bale(s) fixed`,
        description:
          data.changedOrderIds.length > 0
            ? `Orders updated: ${data.changedOrderIds.join(", ")}`
            : "No bales needed repair.",
      });
      if (data.errors.length > 0) {
        toast({ title: "Repair errors", description: data.errors.join("; "), variant: "destructive" });
      }
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Repair failed", description: error.message, variant: "destructive" });
    },
  });

  const fetchFinalizePreview = async () => {
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/factory/customer-orders/${orderId}/finalize-preview`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch preview");
      const data = await res.json();

      // Check for items with no price set — use totalPrice as the source of truth
      // (pricePerBale can be "0" for per-kg items even when they DO have a price)
      const zeroPrice = (verification?.loadedItems ?? []).filter((item) => {
        const totalPrice = item.totalPrice ?? 0;
        const priceKg = item.pricePerKg ?? 0;
        // Also estimate per-kg total in case bales were loaded before repricing
        const estimatedTotal =
          item.pricingMode === "per_kg" && priceKg > 0 && item.totalWeight > 0 ? priceKg * item.totalWeight : 0;
        return totalPrice === 0 && estimatedTotal === 0;
      });

      if (zeroPrice.length > 0) {
        setUnpricedItems(zeroPrice.map((item) => item.productName));
        setPendingFinalizeData(data);
        setShowPriceWarning(true);
      } else {
        setFinalizePreview(data);
        setShowFinalizePreview(true);
      }
    } catch (error) {
      toast({ title: "Error", description: getErrorDetails(error).message, variant: "destructive" });
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleAddCharge = () => {
    if (!chargeAmount || !orderId) return;
    const name = chargeType === "FREIGHT" ? "Freight" : chargeName.trim();
    if (!name) return;
    addChargeMutation.mutate({
      name,
      amount: parseFloat(chargeAmount),
      chargeType,
      ledgerAccountId: chargeLedgerAccountId ? parseInt(chargeLedgerAccountId) : undefined,
    });
  };

  // Keep the verified-order Actions menu in parity with finalized invoices.
  // Fetching as a blob preserves auth cookies and lets us surface export errors
  // instead of opening a new tab that can fail silently.
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
      const starMatch = cd.match(/filename\*=UTF-8''([^;\s]+)/i);
      const plainMatch = cd.match(/filename="([^"]+)"/i);
      const rawName = starMatch ? starMatch[1] : plainMatch ? plainMatch[1] : null;
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = rawName ? decodeURIComponent(rawName) : fallbackName;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);
      }, 10000);
    } catch (error) {
      toast({ title: "Export failed", description: getErrorDetails(error).message, variant: "destructive" });
    }
  };

  const handleExportExcel = () => {
    if (!orderId) return;
    void downloadFromUrl(`/api/factory/customer-orders/${orderId}/export-excel`, "invoice.xlsx");
  };

  const handleExportExcelNoCharges = () => {
    if (!orderId) return;
    void downloadFromUrl(`/api/factory/customer-orders/${orderId}/export-excel?noCharges=1`, "invoice-no-charges.xlsx");
  };

  const handleExportPdf = () => {
    if (!orderId) return;
    void downloadFromUrl(`/api/factory/customer-orders/${orderId}/export-pdf`, "invoice.pdf");
  };

  const handleExportPdfNoCharges = () => {
    if (!orderId) return;
    void downloadFromUrl(`/api/factory/customer-orders/${orderId}/export-pdf?noCharges=1`, "invoice-no-charges.pdf");
  };

  const handleExportLoadingStatus = () => {
    if (!orderId) return;
    void downloadFromUrl(`/api/factory/customer-orders/${orderId}/loading-status-export`, "loading-status.xlsx");
  };

  const _getComparisonRowClass = (status: ComparisonItem["status"]) => {
    switch (status) {
      case "LOADED_NOT_IN_PROFORMA":
      case "MISSING_FROM_LOADED":
        return "bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800";
      case "UNDER_LOADED":
        return "bg-yellow-50 dark:bg-yellow-950 border-yellow-200 dark:border-yellow-800";
      case "OVER_LOADED":
        return "bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800";
      case "MATCH":
      default:
        return "";
    }
  };

  const getStatusBadge = (status: ComparisonItem["status"]) => {
    switch (status) {
      case "LOADED_NOT_IN_PROFORMA":
        return (
          <Badge variant="destructive" data-testid="badge-loaded-not-in-proforma">
            Not in Proforma
          </Badge>
        );
      case "MISSING_FROM_LOADED":
        return (
          <Badge variant="destructive" data-testid="badge-missing-from-loaded">
            Missing
          </Badge>
        );
      case "UNDER_LOADED":
        return (
          <Badge
            variant="outline"
            className="bg-yellow-50 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800"
            data-testid="badge-under-loaded"
          >
            Under Loaded
          </Badge>
        );
      case "OVER_LOADED":
        return (
          <Badge
            variant="outline"
            className="bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800"
            data-testid="badge-over-loaded"
          >
            Over Loaded
          </Badge>
        );
      case "MATCH":
        return (
          <Badge
            variant="outline"
            className="text-green-700 dark:text-green-300 border-green-200 dark:border-green-800"
            data-testid="badge-match"
          >
            <CheckCircle className="h-3 w-3 mr-1" />
            Match
          </Badge>
        );
      default:
        return null;
    }
  };

  const isLoading = verificationLoading || orderLoading;
  const charges = orderDetail?.charges || [];
  const orderStatus = verification?.order?.status || orderDetail?.status || "";
  const isPending = false; // PENDING_VERIFICATION is now treated as VERIFIED directly
  const isVerified = orderStatus === "VERIFIED" || orderStatus === "PENDING_VERIFICATION";
  const isLoadingStatus = orderStatus === "LOADING";

  const totalNotLoadedBales = (verification?.comparison ?? []).reduce((sum, item) => {
    const remaining = item.expectedQty - item.loadedQty;
    return sum + (remaining > 0 ? remaining : 0);
  }, 0);

  // Compute the not-loaded weight using actual IN-STOCK bale weights where
  // available (stockTotalWeight / stockQty), so the number reflects reality
  // rather than an average of already-loaded bales (which can introduce
  // fractions even when every physical bale has a whole-number weight).
  const globalAvgWeightPerBale =
    (verification?.totalLoadedBales ?? 0) > 0
      ? (verification?.totalLoadedWeight ?? 0) / (verification?.totalLoadedBales ?? 1)
      : 0;
  const totalNotLoadedWeight = (verification?.comparison ?? []).reduce((sum, item) => {
    const remaining = item.expectedQty - item.loadedQty;
    if (remaining <= 0) return sum;
    // Priority 1: actual average weight of IN-STOCK bales for this article
    const stockQty: number = item.stockQty ?? 0;
    const stockTotalWeight: number = item.stockTotalWeight ?? 0;
    if (stockQty > 0 && stockTotalWeight > 0) {
      const stockAvg = stockTotalWeight / stockQty;
      return sum + stockAvg * remaining;
    }
    // Priority 2: average of already-loaded bales of this article
    if (item.loadedQty > 0) {
      return sum + (item.totalWeight / item.loadedQty) * remaining;
    }
    // Priority 3: global average across all loaded bales
    return sum + globalAvgWeightPerBale * remaining;
  }, 0);

  return {
    navigate,
    orderId,
    containerNumber,
    setContainerNumber,
    shippingCompany,
    setShippingCompany,
    containerNotes,
    setContainerNotes,
    destination,
    setDestination,
    chargeName,
    setChargeName,
    chargeAmount,
    setChargeAmount,
    chargeType,
    setChargeType,
    chargeLedgerAccountId,
    setChargeLedgerAccountId,
    chargeAccountOpen,
    setChargeAccountOpen,
    showApproveDialog,
    setShowApproveDialog,
    showReturnDialog,
    setShowReturnDialog,
    approveNotes,
    setApproveNotes,
    showFinalizePreview,
    setShowFinalizePreview,
    finalizePreview,
    setFinalizePreview,
    previewLoading,
    showPriceWarning,
    setShowPriceWarning,
    unpricedItems,
    pendingFinalizeData,
    showFixBalesDialog,
    setShowFixBalesDialog,
    invoiceDate,
    setInvoiceDate,
    showProformaDialog,
    setShowProformaDialog,
    showViewProformaDialog,
    setShowViewProformaDialog,
    selectedProformaId,
    setSelectedProformaId,
    statusFilter,
    setStatusFilter,
    showRecoverDialog,
    setShowRecoverDialog,
    recoverInput,
    setRecoverInput,
    recoverTab,
    setRecoverTab,
    verification,
    verificationLoading,
    orderDetail,
    currentUser,
    isAdminOrOwner,
    isDeveloper,
    ledgerAccounts,
    proformas,
    selectedProforma,
    verifyMutation,
    returnToLoadingMutation,
    assignContainerMutation,
    addChargeMutation,
    removeChargeMutation,
    finalizeMutation,
    forceSyncMutation,
    recoverBalesMutation,
    autoRecoverMutation,
    applyProformaMutation,
    applyProductionPricesMutation,
    applySellingPricesMutation,
    repairPerKgMutation,
    fetchFinalizePreview,
    handleAddCharge,
    getStatusBadge,
    isLoading,
    charges,
    isPending,
    isVerified,
    isLoadingStatus,
    totalNotLoadedBales,
    totalNotLoadedWeight,
    handleExportExcel,
    handleExportExcelNoCharges,
    handleExportPdf,
    handleExportPdfNoCharges,
    handleExportLoadingStatus,
  } as const;
}
