// Extracted from ./useFactoryPendingInvoiceVerifyModel.tsx to keep that module under the source-size cap.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { keyStartsWith, queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useLocation, useParams } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useEffect, useRef, useState } from "react";
import type { FinalizePreview, OrderDetail, VerificationSummary } from "./types";

export function useFactoryPendingInvoiceVerifyModelPart1() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  useEscapeToParent("/factory/invoicing?tab=invoices");
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const params = useParams<{ id: string }>();
  const orderId = params.id;

  const [containerNumber, setContainerNumber] = useState("");
  const [shippingCompany, setShippingCompany] = useState("");
  const [containerNotes, setContainerNotes] = useState("");
  const [bookingInfo, setBookingInfo] = useState("");
  const [destination, setDestination] = useState("");
  const initializedOrderId = useRef<number | null>(null);
  const lastFetchedBookingInfo = useRef("");

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
    // Re-check the current proforma when returning from editing its items.
    refetchOnMount: "always",
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
    // Charges must be posted to individual ledgers, not group headers or parent accounts.
    queryKey: ["/api/ledger-accounts?profile=voucher-picker"],
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
      const proformaSummaryUrl = `/api/factory/customer-proformas?customerId=${orderDetail.customerId}&profile=summary`;
      const res = await fetch(proformaSummaryUrl, { credentials: "include" });
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

  // Read the actual reusable master separately: the verification summary
  // intentionally includes container-only supplements, but "View Proforma"
  // must never present those supplements as edits to the master.
  const { data: viewedMasterProforma } = useQuery<{
    name: string;
    lines: Array<{ articleCode: string; productName: string; quantity: number; pricePerBale: string }>;
  }>({
    queryKey: ["/api/factory/customer-proformas", orderDetail?.proformaIdUsed, "master-view"],
    queryFn: async () => {
      const response = await fetch(`/api/factory/customer-proformas/${orderDetail!.proformaIdUsed}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not load the original proforma");
      return response.json();
    },
    enabled: showViewProformaDialog && !!orderDetail?.proformaIdUsed,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!orderDetail) return;

    const savedBookingInfo = orderDetail.bookingInfo ?? "";
    if (initializedOrderId.current !== orderDetail.id) {
      // The router can reuse this component for a different order.
      setContainerNumber(orderDetail.containerNumber || "");
      setShippingCompany(orderDetail.shippingCompany || "");
      setContainerNotes(orderDetail.containerNotes || "");
      setBookingInfo(savedBookingInfo);
      setDestination(orderDetail.destination || "");
      initializedOrderId.current = orderDetail.id;
    } else if (savedBookingInfo !== lastFetchedBookingInfo.current) {
      // Refresh stale detail data without replacing unsaved local edits.
      const previousSaved = lastFetchedBookingInfo.current;
      setBookingInfo((current) => (current === previousSaved ? savedBookingInfo : current));
    }
    lastFetchedBookingInfo.current = savedBookingInfo;
  }, [orderDetail]);

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
      bookingInfo: string;
      destination: string;
    }) => {
      const response = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/assign-container`, data);
      return (await response.json()) as { bookingInfo: string | null };
    },
    onSuccess: (saved) => {
      // Keep this form's query in sync immediately instead of displaying a stale blank value.
      queryClient.setQueryData<OrderDetail>(["/api/factory/customer-orders", orderId], (previous) =>
        previous ? { ...previous, bookingInfo: saved.bookingInfo } : previous
      );
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
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
  return {
    addChargeMutation,
    approveNotes,
    assignContainerMutation,
    bookingInfo,
    chargeAccountOpen,
    chargeAmount,
    chargeLedgerAccountId,
    chargeName,
    chargeType,
    containerNotes,
    containerNumber,
    currentUser,
    destination,
    finalizePreview,
    invoiceDate,
    isAdminOrOwner,
    isDeveloper,
    ledgerAccounts,
    modeApiRequest,
    navigate,
    orderDetail,
    orderId,
    orderLoading,
    pendingFinalizeData,
    previewLoading,
    proformas,
    recoverInput,
    recoverTab,
    returnToLoadingMutation,
    selectedProforma,
    selectedProformaId,
    setApproveNotes,
    setBookingInfo,
    setChargeAccountOpen,
    setChargeAmount,
    setChargeLedgerAccountId,
    setChargeName,
    setChargeType,
    setContainerNotes,
    setContainerNumber,
    setDestination,
    setFinalizePreview,
    setInvoiceDate,
    setPendingFinalizeData,
    setPreviewLoading,
    setRecoverInput,
    setRecoverTab,
    setSelectedProformaId,
    setShippingCompany,
    setShowApproveDialog,
    setShowFinalizePreview,
    setShowFixBalesDialog,
    setShowPriceWarning,
    setShowProformaDialog,
    setShowRecoverDialog,
    setShowReturnDialog,
    setShowViewProformaDialog,
    setStatusFilter,
    setUnpricedItems,
    shippingCompany,
    showApproveDialog,
    showFinalizePreview,
    showFixBalesDialog,
    showPriceWarning,
    showProformaDialog,
    showRecoverDialog,
    showReturnDialog,
    showViewProformaDialog,
    statusFilter,
    toast,
    unpricedItems,
    verification,
    verificationLoading,
    verifyMutation,
    viewedMasterProforma,
  };
}
