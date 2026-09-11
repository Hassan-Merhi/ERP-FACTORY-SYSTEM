/**
 * Controller hook for the ERP container loading scan page.
 *
 * Owns the loading order lifecycle, the bale scanner with its two-scan bypass
 * rules for overloaded / not-on-proforma items, the container note, and the
 * proforma-vs-loaded comparison.
 */
import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { queryClient, keyStartsWith } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import {
  SCAN_NOT_IN_PROFORMA_TONE,
  SCAN_OVERLOAD_TONE,
  SCAN_SUCCESS_TONE,
  playScanBeep,
  playScanErrorSweep,
} from "../factory/factorycontainerloadingscan/scanFeedback";
import type { Customer, Location, OrderBale, OrderDetail, Proforma } from "./types";
import {
  buildProformaProgress,
  normalizeProformaArticleCode,
  proformaCapacityArticles,
  type ProformaCapacitySnapshot,
} from "@/lib/proformaCapacity";

export interface BaleGroup {
  articleCode: string;
  baleName: string;
  bales: OrderBale[];
  totalWeight: number;
}

export type ProformaLineStatus = "fulfilled" | "overloaded" | "short" | "none";

export function useContainerLoadingScanModel() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);

  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("");
  const [selectedLocationId, setSelectedLocationId] = useState<string>("");
  const [orderDate] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [orderId, setOrderId] = useState<number | null>(null);
  const [isResuming, setIsResuming] = useState(false);
  const [loadingNote, setLoadingNote] = useState<string>("");
  const [scanCode, setScanCode] = useState("");
  const [scanFlash, setScanFlash] = useState<"success" | "error" | null>(null);
  const [showFinalizeDialog, setShowFinalizeDialog] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"detailed" | "condensed">("detailed");
  const [lastScannedRef, setLastScannedRef] = useState<{
    baleReference: string;
    baleName: string;
    articleCode: string;
  } | null>(null);
  const [showScanSuccessPopup, setShowScanSuccessPopup] = useState(false);
  const [showScanErrorPopup, setShowScanErrorPopup] = useState(false);
  const [pendingBypassBaleRef, setPendingBypassBaleRef] = useState<string | null>(null);
  const [pendingBypassOverloadRef, setPendingBypassOverloadRef] = useState<string | null>(null);
  const [showLastScannedPopup, setShowLastScannedPopup] = useState(false);
  const scannerRef = useRef<HTMLInputElement>(null);

  const customerId = selectedCustomerId ? parseInt(selectedCustomerId) : null;

  // On mount: check for ?orderId= resume param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const resumeOrderId = params.get("orderId");
    if (resumeOrderId) {
      const id = parseInt(resumeOrderId);
      if (!isNaN(id)) {
        setOrderId(id);
        setIsResuming(true);
      }
    }
  }, []);

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["/api/factory/customers"],
  });

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

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

  const activeProforma = proformas.find((p) => p.isActive) || null;

  const { data: orderDetail } = useQuery<OrderDetail>({
    queryKey: ["/api/factory/customer-orders", orderId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/customer-orders/${orderId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch order");
      return res.json();
    },
    enabled: !!orderId,
    staleTime: 15_000,
  });

  const capacityProformaId = orderDetail?.proformaIdUsed ?? activeProforma?.id ?? null;
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
      return res.json();
    },
    enabled: !!capacityProformaId,
    staleTime: 0,
  });
  const proformaCapacity = capacityQuery.data ?? null;
  const activeProformaExhausted =
    !!activeProforma && proformaCapacity?.proformaId === activeProforma.id && proformaCapacity.remainingTotalQty <= 0;

  // Auto-select location when there is only one option
  useEffect(() => {
    if (!orderId && locations.length === 1 && !selectedLocationId) {
      setSelectedLocationId(String(locations[0].id));
    }
  }, [locations, orderId, selectedLocationId]);

  // When resuming: restore customer/location/note and show last scanned popup
  useEffect(() => {
    if (isResuming && orderDetail && !selectedCustomerId) {
      setSelectedCustomerId(String(orderDetail.customerId));
      setSelectedLocationId(String(orderDetail.locationId || ""));
      setLoadingNote(orderDetail.containerNotes || "");
      setTimeout(() => scannerRef.current?.focus(), 200);
    }
  }, [isResuming, orderDetail, selectedCustomerId]);

  const createOrderMutation = useMutation({
    mutationFn: async (data: {
      customerId: number;
      proformaIdUsed: number | null;
      locationId: number;
      orderDate: string;
      containerNotes?: string;
    }) => {
      const res = await modeApiRequest("POST", "/api/factory/customer-orders-loading", data);
      return await res.json();
    },
    onSuccess: (data) => {
      setOrderId(data.id);
      toast({ title: "Loading order created", description: "You can now start scanning bales" });
      setTimeout(() => scannerRef.current?.focus(), 100);
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const addBaleMutation = useMutation({
    mutationFn: async (data: {
      scanCode: string;
      locationId: number;
      allowBypassProforma?: boolean;
      allowBypassOverload?: boolean;
    }) => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/bales`, data);
      return await res.json();
    },
    onSuccess: (data, variables: { scanCode: string }) => {
      setPendingBypassBaleRef(null);
      setPendingBypassOverloadRef(null);
      setScanFlash("success");
      setShowScanSuccessPopup(true);
      playScanBeep(SCAN_SUCCESS_TONE.frequency, SCAN_SUCCESS_TONE.durationMs);
      setTimeout(() => {
        setScanFlash(null);
        setShowScanSuccessPopup(false);
      }, 500);
      if (orderId) {
        const scanned = variables.scanCode;
        const newestForRef = [...(data?.bales || [])].sort((a, b) => b.id - a.id)[0];
        const lastScanned = {
          baleReference: newestForRef?.baleReference || scanned,
          baleName: newestForRef?.baleName || "",
          articleCode: newestForRef?.articleCode || "",
        };
        setLastScannedRef(lastScanned);
      }
      const newest = [...(data?.bales || [])].sort((a, b) => b.id - a.id)[0];
      if (newest?.articleCode) {
        setExpandedGroups((prev) => {
          const next = new Set(prev);
          next.add(newest.articleCode);
          return next;
        });
      }
      queryClient.setQueryData<OrderDetail>(["/api/factory/customer-orders", orderId], data);
      if (capacityProformaId) {
        void queryClient.invalidateQueries({
          queryKey: ["/api/factory/customer-proformas/capacity", capacityProformaId],
          refetchType: "active",
        });
      }
      setScanCode("");
      scannerRef.current?.focus();
    },
    onError: (error: Error, variables: any) => {
      // Overload and not-on-proforma are soft rejections: arm a bypass so the
      // same code scanned a second time goes through.
      if ((error as any).overloaded) {
        setPendingBypassOverloadRef(variables.scanCode);
        setPendingBypassBaleRef(null);
        setScanFlash("error");
        playScanBeep(SCAN_OVERLOAD_TONE.frequency, SCAN_OVERLOAD_TONE.durationMs);
        setTimeout(() => setScanFlash(null), 600);
        setScanCode("");
        scannerRef.current?.focus();
        return;
      }
      if ((error as any).notInProforma) {
        setPendingBypassBaleRef(variables.scanCode);
        setPendingBypassOverloadRef(null);
        setScanFlash("error");
        playScanBeep(SCAN_NOT_IN_PROFORMA_TONE.frequency, SCAN_NOT_IN_PROFORMA_TONE.durationMs);
        setTimeout(() => setScanFlash(null), 600);
        setScanCode("");
        scannerRef.current?.focus();
        return;
      }
      setScanFlash("error");
      setShowScanErrorPopup(true);
      playScanErrorSweep();
      setTimeout(() => {
        setScanFlash(null);
        setShowScanErrorPopup(false);
      }, 1500);
      toast({ title: "Scan Error", description: error.message, variant: "destructive" });
      setScanCode("");
      scannerRef.current?.focus();
    },
  });

  const removeBaleMutation = useMutation({
    mutationFn: async (baleId: number) => {
      await modeApiRequest("DELETE", `/api/factory/customer-orders/${orderId}/bales/${baleId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries(
        { queryKey: ["/api/factory/customer-orders", orderId], exact: true, refetchType: "active" },
        { cancelRefetch: false }
      );
      if (capacityProformaId) {
        void queryClient.invalidateQueries({
          queryKey: ["/api/factory/customer-proformas/capacity", capacityProformaId],
          refetchType: "active",
        });
      }
      toast({ title: "Bale removed" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async () => {
      await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/finalize-loading`);
    },
    onSuccess: () => {
      toast({ title: "Loading finalized", description: "Loading has been sent for office verification" });
      setShowFinalizeDialog(false);
      queryClient.invalidateQueries(
        { predicate: keyStartsWith("/api/factory/customer-orders"), refetchType: "active" },
        { cancelRefetch: false }
      );
      navigate("/factory/invoicing?tab=invoices");
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
      setShowFinalizeDialog(false);
    },
  });

  const saveNoteMutation = useMutation({
    mutationFn: async (note: string) => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/assign-container`, {
        containerNotes: note,
      });
      return await res.json();
    },
    onSuccess: (_data: unknown, note: string) => {
      toast({ title: "Note saved" });
      queryClient.setQueryData<OrderDetail>(["/api/factory/customer-orders", orderId], (current) =>
        current ? { ...current, containerNotes: note } : current
      );
      queryClient.invalidateQueries(
        {
          predicate: keyStartsWith("/api/factory/customer-orders?status=LOADING&profile=summary&pageSize=250"),
          refetchType: "active",
        },
        { cancelRefetch: false }
      );
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error saving note", description: error.message, variant: "destructive" });
    },
  });

  const handleStartLoading = useCallback(() => {
    if (!customerId || !selectedLocationId) return;
    if (
      activeProforma &&
      proformaCapacity?.proformaId === activeProforma.id &&
      proformaCapacity.remainingTotalQty <= 0
    ) {
      toast({ title: "Proforma fully consumed", description: "No remaining quantity is available for a new loading." });
      return;
    }
    createOrderMutation.mutate({
      customerId,
      proformaIdUsed: activeProforma?.id || null,
      locationId: parseInt(selectedLocationId),
      orderDate,
      containerNotes: loadingNote.trim() || undefined,
    });
  }, [
    customerId,
    selectedLocationId,
    activeProforma,
    proformaCapacity,
    orderDate,
    loadingNote,
    createOrderMutation,
    toast,
  ]);

  const handleScan = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter" || !scanCode.trim() || !orderId || !selectedLocationId) return;
      e.preventDefault();
      const trimmed = scanCode.trim();
      const isBypassProforma = pendingBypassBaleRef !== null && pendingBypassBaleRef === trimmed;
      const isBypassOverload = pendingBypassOverloadRef !== null && pendingBypassOverloadRef === trimmed;
      if (pendingBypassBaleRef !== null && !isBypassProforma) setPendingBypassBaleRef(null);
      if (pendingBypassOverloadRef !== null && !isBypassOverload) setPendingBypassOverloadRef(null);
      addBaleMutation.mutate({
        scanCode: trimmed,
        locationId: parseInt(selectedLocationId),
        allowBypassProforma: isBypassProforma || undefined,
        allowBypassOverload: isBypassOverload || undefined,
      });
    },
    [scanCode, orderId, selectedLocationId, pendingBypassBaleRef, pendingBypassOverloadRef, addBaleMutation]
  );

  const toggleGroup = useCallback((articleCode: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(articleCode)) next.delete(articleCode);
      else next.add(articleCode);
      return next;
    });
  }, []);

  const bales = orderDetail?.bales || [];

  const groupedBalesMap = bales.reduce<Record<string, BaleGroup>>((acc, bale) => {
    const key = bale.articleCode;
    if (!acc[key]) {
      acc[key] = { articleCode: bale.articleCode, baleName: bale.baleName, bales: [], totalWeight: 0 };
    }
    acc[key].bales.push(bale);
    acc[key].totalWeight += parseFloat(bale.weight || "0");
    return acc;
  }, {});

  const orderedGroups = Object.values(groupedBalesMap).sort((a, b) => {
    const maxA = Math.max(...a.bales.map((x) => x.id));
    const maxB = Math.max(...b.bales.map((x) => x.id));
    return maxB - maxA;
  });

  const totalWeight = bales.reduce((sum, b) => sum + parseFloat(b.weight || "0"), 0);

  const linkedProforma = orderDetail?.proformaIdUsed
    ? proformas.find((p) => p.id === orderDetail.proformaIdUsed) ||
      (proformaCapacity
        ? {
            id: proformaCapacity.proformaId,
            customerId: proformaCapacity.customerId,
            name: proformaCapacity.proformaName,
            isActive: proformaCapacity.proformaActive,
            lines: [],
          }
        : null)
    : activeProforma;

  const loadedByArticle = bales.reduce<Record<string, number>>((map, b) => {
    map[b.articleCode] = (map[b.articleCode] || 0) + 1;
    return map;
  }, {});

  const proformaProgress = buildProformaProgress(proformaCapacity);
  const fulfilledCount = proformaProgress.filter(
    (line) => line.status === "fulfilled" || line.status === "overloaded"
  ).length;
  const totalLines = proformaProgress.length;

  const proformaArticleCodes = new Set(
    proformaCapacityArticles(proformaCapacity)
      .filter((article) => article.isOnProforma)
      .map((article) => article.normalizedArticleCode)
  );
  const extraArticles = Object.keys(loadedByArticle).filter(
    (code) => !proformaArticleCodes.has(normalizeProformaArticleCode(code))
  );

  const scanInputClass =
    scanFlash === "success"
      ? "ring-2 ring-green-500 bg-green-50 dark:bg-green-950 transition-all"
      : scanFlash === "error"
        ? "ring-2 ring-red-500 bg-red-50 dark:bg-red-950 transition-all"
        : "";

  return {
    navigate,
    // setup
    customers,
    locations,
    proformas,
    activeProforma,
    proformaCapacity,
    isProformaCapacityLoading: capacityQuery.isLoading || capacityQuery.isFetching,
    activeProformaExhausted,
    selectedCustomerId,
    setSelectedCustomerId,
    selectedLocationId,
    setSelectedLocationId,
    customerId,
    loadingNote,
    setLoadingNote,
    saveNoteMutation,
    handleStartLoading,
    createOrderMutation,
    // order
    orderId,
    isResuming,
    bales,
    orderedGroups,
    groupedBalesMap,
    totalWeight,
    expandedGroups,
    toggleGroup,
    viewMode,
    setViewMode,
    removeBaleMutation,
    // scanning
    scannerRef,
    scanCode,
    setScanCode,
    handleScan,
    scanFlash,
    scanInputClass,
    showScanSuccessPopup,
    showScanErrorPopup,
    pendingBypassBaleRef,
    pendingBypassOverloadRef,
    addBaleMutation,
    lastScannedRef,
    showLastScannedPopup,
    setShowLastScannedPopup,
    // proforma comparison
    linkedProforma,
    proformaProgress,
    loadedByArticle,
    extraArticles,
    fulfilledCount,
    totalLines,
    // finalize
    showFinalizeDialog,
    setShowFinalizeDialog,
    finalizeMutation,
  };
}

export type ContainerLoadingScanModel = ReturnType<typeof useContainerLoadingScanModel>;
