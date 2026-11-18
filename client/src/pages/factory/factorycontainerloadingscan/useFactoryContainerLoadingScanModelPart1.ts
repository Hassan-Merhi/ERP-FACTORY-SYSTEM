// Extracted from ./useFactoryContainerLoadingScanModel.ts to keep that module under the source-size cap.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { CameraScanFeedback } from "@/components/MobileBarcodeScanner";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import {
  type FactoryContainerLoadingTranslationKey,
  translateFactoryContainerLoadingText,
} from "@/i18n/factoryContainerLoadingTranslations";
import { getApiRequest } from "@/lib/factoryApi";
import type { ProformaCapacitySnapshot } from "@/lib/proformaCapacity";
import type { BaleRemoval, Customer, Location, OrderDetail, Proforma } from "./types";
import { useScanFlashReset } from "./scanFeedback";

const PENDING_LOADINGS_SUMMARY_QUERY = "/api/factory/customer-orders?status=LOADING&profile=summary&pageSize=250";

const PRIORITY_SCAN_CONFIGS_QUERY = "/api/factory/customer-orders/loading-list/priority-scan-configs";

export function useFactoryContainerLoadingScanModelPart1() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const search = useSearch();
  const appMode = useAppMode();
  const { language } = useApplicationLanguage();
  const tr = useCallback(
    (key: FactoryContainerLoadingTranslationKey, params?: Record<string, string | number>) =>
      translateFactoryContainerLoadingText(key, language, params),
    [language]
  );
  const modeApiRequest = getApiRequest(appMode);
  // Scanning bales, notes, import, removal and finalize all change an existing
  // loading; starting a loading creates one via POST /api/factory/customer-orders-loading.
  const recordChanges = useExistingRecordChangeAccess();
  const canCreateLoading = recordChanges.canCreate("POST", "/api/factory/customer-orders-loading");
  const continuationFromOrderId = new URLSearchParams(search).get("continuationFromOrderId");

  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("");
  const [selectedLocationId, setSelectedLocationId] = useState<string>("");
  const [orderDate] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [orderId, setOrderId] = useState<number | null>(null);
  const [isResuming, setIsResuming] = useState(false);
  const [loadingNote, setLoadingNote] = useState<string>("");
  const [scanCode, setScanCode] = useState("");
  const [scanFlash, setScanFlash] = useState<"success" | "error" | null>(null);
  const [cameraScanFeedback, setCameraScanFeedback] = useState<CameraScanFeedback | null>(null);
  const [showScanSuccessPopup, setShowScanSuccessPopup] = useState(false);
  const [showScanErrorPopup, setShowScanErrorPopup] = useState(false);
  const [pendingBypassBaleRef, setPendingBypassBaleRef] = useState<string | null>(null);
  const [pendingBypassOverloadRef, setPendingBypassOverloadRef] = useState<string | null>(null);
  const [ignoreProforma, setIgnoreProforma] = useState(false);
  const [showFinalizeDialog, setShowFinalizeDialog] = useState(false);
  const [finalizeDate, setFinalizeDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"detailed" | "condensed">("detailed");
  const [lastScannedRef, setLastScannedRef] = useState<{
    baleReference: string;
    baleName: string;
    articleCode: string;
  } | null>(null);
  const [showLastScannedPopup, setShowLastScannedPopup] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importMode, setImportMode] = useState<"articleCode" | "refNumber">("articleCode");
  const [importPreview, setImportPreview] = useState<Array<{ articleCode: string; qty: number }>>([]);
  const [importRefNumbers, setImportRefNumbers] = useState<string[]>([]);
  const [showPendingWarning, setShowPendingWarning] = useState(false);
  const [pendingOrders, setPendingOrders] = useState<
    Array<{ id: number; invoiceNumber: string | null; status: string; totalQtyBales: number }>
  >([]);
  const [baleToDelete, setBaleToDelete] = useState<{ id: number; baleReference: string } | null>(null);
  const [showEmptyContainerConfirm, setShowEmptyContainerConfirm] = useState(false);
  const [showRemovalLog, setShowRemovalLog] = useState(false);
  const [selectedProformaId, setSelectedProformaId] = useState<string>("");
  const scannerRef = useRef<HTMLInputElement>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const ignoreProformaRef = useRef(false);
  const scanSubmissionInFlightRef = useRef(false);
  const scheduleFlashReset = useScanFlashReset();

  const toggleIgnoreProforma = useCallback(() => {
    const enabled = !ignoreProformaRef.current;
    // Update the ref synchronously so a hardware scanner that fires immediately
    // after the click cannot submit with the previous render's toggle value.
    ignoreProformaRef.current = enabled;
    setIgnoreProforma(enabled);
    setPendingBypassBaleRef(null);
    setTimeout(() => scannerRef.current?.focus(), 0);
  }, []);

  const customerId = selectedCustomerId ? parseInt(selectedCustomerId) : null;

  // Keep the active order synchronized with the URL. Navigating from
  // ?orderId=<old> back to the plain /new route must clear the old loading;
  // otherwise the same mounted page silently keeps scanning into the old order.
  useEffect(() => {
    const params = new URLSearchParams(search);
    const resumeOrderId = params.get("orderId");
    if (!resumeOrderId) {
      setOrderId(null);
      setIsResuming(false);
      setSelectedCustomerId("");
      setSelectedLocationId("");
      setSelectedProformaId("");
      setLoadingNote("");
      setLastScannedRef(null);
      setPendingBypassBaleRef(null);
      setPendingBypassOverloadRef(null);
      scanSubmissionInFlightRef.current = false;
      return;
    }

    const id = parseInt(resumeOrderId);
    if (!isNaN(id)) {
      setOrderId(id);
      setIsResuming(true);
    }
  }, [search]);

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["/api/factory/customers"],
  });

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  // Auto-select when there's exactly one location
  useEffect(() => {
    if (orderId) return; // don't override when resuming an existing order
    if (locations.length === 1) {
      setSelectedLocationId(String(locations[0].id));
    }
  }, [locations, orderId]);

  const { data: proformas = [] } = useQuery<Proforma[]>({
    queryKey: [`/api/factory/customer-proformas?customerId=${customerId}&profile=summary`],
    queryFn: async () => {
      const res = await fetch(`/api/factory/customer-proformas?customerId=${customerId}&profile=summary`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch proformas");
      return res.json();
    },
    enabled: !!customerId,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });

  // All starred (active) proformas for this customer
  const activeProformas = useMemo(() => proformas.filter((p) => p.isActive), [proformas]);

  // Auto-select when there's exactly one starred proforma; clear when customer changes
  useEffect(() => {
    if (orderId) return;
    if (activeProformas.length === 1) {
      setSelectedProformaId(String(activeProformas[0].id));
    } else {
      setSelectedProformaId("");
    }
  }, [activeProformas, orderId]);

  const { data: orderDetail } = useQuery<OrderDetail>({
    queryKey: ["/api/factory/customer-orders", orderId],
    queryFn: async () => {
      const effectiveContinuationFromOrderId = continuationFromOrderId || String(orderId);
      const continuationQuery = `?continuationFromOrderId=${effectiveContinuationFromOrderId}`;
      const res = await fetch(`/api/factory/customer-orders/${orderId}${continuationQuery}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch order");
      return res.json();
    },
    enabled: !!orderId,
    staleTime: 15_000,
  });

  // Reopened orders retain the original confirmed loading date. Show that
  // same date when re-opening Validate Loading instead of displaying today.
  useEffect(() => {
    if (!showFinalizeDialog) return;
    setFinalizeDate(orderDetail?.loadingFinalizedAt?.slice(0, 10) ?? new Date().toLocaleDateString("en-CA"));
  }, [showFinalizeDialog, orderDetail?.loadingFinalizedAt]);

  const selectedCapacityProformaId =
    selectedProformaId && selectedProformaId !== "none" ? Number(selectedProformaId) : null;
  const capacityProformaId = orderDetail?.proformaIdUsed ?? selectedCapacityProformaId;
  const capacityQuery = useQuery<ProformaCapacitySnapshot>({
    queryKey: ["/api/factory/customer-proformas/capacity", capacityProformaId, orderId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (orderId) params.set("currentOrderId", String(orderId));
      const suffix = params.size ? `?${params.toString()}` : "";
      const res = await fetch(`/api/factory/customer-proformas/${capacityProformaId}/capacity${suffix}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch proforma capacity");
      const snapshot = (await res.json()) as ProformaCapacitySnapshot;
      if (orderId && snapshot.currentOrderId !== orderId) {
        throw new Error("Proforma capacity returned for the wrong loading order");
      }
      return snapshot;
    },
    enabled: !!capacityProformaId,
    staleTime: 0,
  });
  const proformaCapacity = capacityQuery.data ?? null;
  const selectedProformaExhausted =
    !!selectedCapacityProformaId &&
    proformaCapacity?.proformaId === selectedCapacityProformaId &&
    proformaCapacity.remainingTotalQty <= 0;

  const refreshSharedLoadingQueues = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: [PENDING_LOADINGS_SUMMARY_QUERY],
      refetchType: "active",
    });
    void queryClient.invalidateQueries({
      queryKey: [PRIORITY_SCAN_CONFIGS_QUERY],
      refetchType: "active",
    });
  }, []);

  const { data: baleRemovals = [] } = useQuery<BaleRemoval[]>({
    queryKey: ["/api/factory/customer-orders", orderId, "bale-removals"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/customer-orders/${orderId}/bale-removals`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch removal log");
      return res.json();
    },
    // Load the log while the order is active so the collapsed section can
    // discover that it has entries and render itself.
    enabled: !!orderId,
    staleTime: 30_000,
  });

  // When resuming: restore customer/location and show last scanned popup
  useEffect(() => {
    if (isResuming && orderDetail && !selectedCustomerId) {
      setSelectedCustomerId(String(orderDetail.customerId));
      setSelectedLocationId(String(orderDetail.locationId || ""));
      setLoadingNote(orderDetail.containerNotes || "");
      setTimeout(() => scannerRef.current?.focus(), 200);
    }
  }, [isResuming, orderDetail, selectedCustomerId]);
  return {
    activeProformas,
    baleRemovals,
    baleToDelete,
    cameraScanFeedback,
    canCreateLoading,
    capacityProformaId,
    capacityQuery,
    customerId,
    customers,
    expandedGroups,
    finalizeDate,
    ignoreProforma,
    ignoreProformaRef,
    importFileRef,
    importMode,
    importPreview,
    importRefNumbers,
    isResuming,
    language,
    lastScannedRef,
    loadingNote,
    locations,
    modeApiRequest,
    navigate,
    orderDate,
    orderDetail,
    orderId,
    pendingBypassBaleRef,
    pendingBypassOverloadRef,
    pendingOrders,
    proformaCapacity,
    proformas,
    recordChanges,
    refreshSharedLoadingQueues,
    scanCode,
    scanFlash,
    scanSubmissionInFlightRef,
    scannerRef,
    scheduleFlashReset,
    selectedCustomerId,
    selectedLocationId,
    selectedProformaExhausted,
    selectedProformaId,
    setBaleToDelete,
    setCameraScanFeedback,
    setExpandedGroups,
    setFinalizeDate,
    setImportMode,
    setImportPreview,
    setImportRefNumbers,
    setIsResuming,
    setLastScannedRef,
    setLoadingNote,
    setOrderId,
    setPendingBypassBaleRef,
    setPendingBypassOverloadRef,
    setPendingOrders,
    setScanCode,
    setScanFlash,
    setSelectedCustomerId,
    setSelectedLocationId,
    setSelectedProformaId,
    setShowEmptyContainerConfirm,
    setShowFinalizeDialog,
    setShowImportDialog,
    setShowLastScannedPopup,
    setShowPendingWarning,
    setShowRemovalLog,
    setShowScanErrorPopup,
    setShowScanSuccessPopup,
    setViewMode,
    showEmptyContainerConfirm,
    showFinalizeDialog,
    showImportDialog,
    showLastScannedPopup,
    showPendingWarning,
    showRemovalLog,
    showScanErrorPopup,
    showScanSuccessPopup,
    toast,
    toggleIgnoreProforma,
    tr,
    viewMode,
  };
}
