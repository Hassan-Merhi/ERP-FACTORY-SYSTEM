/**
 * Controller hook for the factory container loading scan page.
 *
 * Owns the loading order lifecycle (create / resume / finalize), the bale
 * scanner with its two-scan bypass rules, the Excel bulk import, the removal
 * log, and the proforma-vs-loaded comparison the floor loader works against.
 */
import { useState, useRef, useCallback, useEffect, useMemo, type KeyboardEvent, type ChangeEvent } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import * as XLSX from "@/lib/excelHelper";
import { useToast } from "@/hooks/use-toast";
import { queryClient, keyStartsWith } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { getErrorDetails } from "@shared/errorUtils";
import {
  buildProformaProgress,
  normalizeProformaArticleCode,
  proformaCapacityArticles,
  type ProformaCapacitySnapshot,
} from "@/lib/proformaCapacity";
import type {
  AddLoadingBaleInput,
  AddLoadingBaleResponse,
  BaleRemoval,
  CreateLoadingOrderResponse,
  Customer,
  Location,
  OrderBale,
  OrderDetail,
  Proforma,
} from "./types";
import {
  SCAN_NOT_IN_PROFORMA_TONE,
  SCAN_OVERLOAD_TONE,
  SCAN_SUCCESS_TONE,
  playScanBeep,
  playScanErrorSweep,
} from "./scanFeedback";

/** Statuses that mean an existing loading order is still open for this proforma. */
const OPEN_ORDER_STATUSES = ["LOADING", "DRAFT", "PENDING_VERIFICATION"];

export interface BaleGroup {
  articleCode: string;
  baleName: string;
  bales: OrderBale[];
  totalWeight: number;
}

export type ProformaLineStatus = "fulfilled" | "overloaded" | "short" | "none";

export function useFactoryContainerLoadingScanModel() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const search = useSearch();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const continuationFromOrderId = new URLSearchParams(search).get("continuationFromOrderId");

  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("");
  const [selectedLocationId, setSelectedLocationId] = useState<string>("");
  const [orderDate] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [orderId, setOrderId] = useState<number | null>(null);
  const [isResuming, setIsResuming] = useState(false);
  const [loadingNote, setLoadingNote] = useState<string>("");
  const [scanCode, setScanCode] = useState("");
  const [scanFlash, setScanFlash] = useState<"success" | "error" | null>(null);
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
  const [showRemovalLog, setShowRemovalLog] = useState(false);
  const [selectedProformaId, setSelectedProformaId] = useState<string>("");
  const scannerRef = useRef<HTMLInputElement>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const ignoreProformaRef = useRef(false);

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

  // Check for ?orderId= resume param using wouter's useSearch (reactive to URL changes)
  useEffect(() => {
    const params = new URLSearchParams(search);
    const resumeOrderId = params.get("orderId");
    if (resumeOrderId) {
      const id = parseInt(resumeOrderId);
      if (!isNaN(id)) {
        setOrderId(id);
        setIsResuming(true);
      }
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
      return res.json();
    },
    enabled: !!capacityProformaId,
    staleTime: 0,
  });
  const proformaCapacity = capacityQuery.data ?? null;
  const selectedProformaExhausted =
    !!selectedCapacityProformaId &&
    proformaCapacity?.proformaId === selectedCapacityProformaId &&
    proformaCapacity.remainingTotalQty <= 0;

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
    onSuccess: (data: CreateLoadingOrderResponse) => {
      setOrderId(data.id);
      toast({
        title: "Loading order created",
        description: "You can now start scanning bales",
      });
      setTimeout(() => scannerRef.current?.focus(), 100);
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
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
    onSuccess: (data: AddLoadingBaleResponse, variables: AddLoadingBaleInput) => {
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
    },
    onError: (error: Error, variables: AddLoadingBaleInput) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      // Overload and not-in-proforma are soft rejections: arm a bypass so the
      // same code scanned a second time goes through.
      if ((error as unknown as Error & { overloaded: unknown }).overloaded) {
        setPendingBypassOverloadRef(variables.scanCode);
        setPendingBypassBaleRef(null);
        setScanFlash("error");
        playScanBeep(SCAN_OVERLOAD_TONE.frequency, SCAN_OVERLOAD_TONE.durationMs);
        setTimeout(() => setScanFlash(null), 600);
        setScanCode("");
        return;
      }
      if ((error as unknown as Error & { notInProforma: unknown }).notInProforma) {
        setPendingBypassBaleRef(variables.scanCode);
        setPendingBypassOverloadRef(null);
        setScanFlash("error");
        playScanBeep(SCAN_NOT_IN_PROFORMA_TONE.frequency, SCAN_NOT_IN_PROFORMA_TONE.durationMs);
        setTimeout(() => setScanFlash(null), 600);
        setScanCode("");
        return;
      }
      setScanFlash("error");
      setShowScanErrorPopup(true);
      playScanErrorSweep();
      setTimeout(() => {
        setScanFlash(null);
        setShowScanErrorPopup(false);
      }, 1500);
      toast({
        title: "Scan Error",
        description: error.message,
        variant: "destructive",
      });
      setScanCode("");
    },
  });

  // Restore focus to the scan input whenever the mutation finishes (success or error).
  // Using a useEffect keyed on isPending is more reliable than setTimeout because
  // it fires after React re-enables the input (disabled={isPending}), so focus
  // is never called on a disabled element.
  const wasPending = useRef(false);
  useEffect(() => {
    const justFinished = wasPending.current && !addBaleMutation.isPending;
    wasPending.current = addBaleMutation.isPending;
    if (justFinished && scannerRef.current) {
      scannerRef.current.focus();
    }
  }, [addBaleMutation.isPending]);

  const removeBaleMutation = useMutation({
    mutationFn: async (baleId: number) => {
      await modeApiRequest("DELETE", `/api/factory/customer-orders/${orderId}/bales/${baleId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries(
        { queryKey: ["/api/factory/customer-orders", orderId], exact: true, refetchType: "active" },
        { cancelRefetch: false }
      );
      queryClient.invalidateQueries({
        queryKey: ["/api/factory/customer-orders", orderId, "bale-removals"],
      });
      if (capacityProformaId) {
        void queryClient.invalidateQueries({
          queryKey: ["/api/factory/customer-proformas/capacity", capacityProformaId],
          refetchType: "active",
        });
      }
      setBaleToDelete(null);
      toast({ title: "Bale removed" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const bulkImportMutation = useMutation({
    mutationFn: async (
      payload:
        | { mode: "articleCode"; items: Array<{ articleCode: string; qty: number }> }
        | { mode: "refNumber"; refNumbers: string[] }
    ) => {
      const body =
        payload.mode === "refNumber"
          ? {
              locationId: parseInt(selectedLocationId),
              refNumbers: payload.refNumbers,
              allowBypassProforma: ignoreProformaRef.current || undefined,
            }
          : {
              locationId: parseInt(selectedLocationId),
              items: payload.items,
              allowBypassProforma: ignoreProformaRef.current || undefined,
            };
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/bales/bulk-import`, body);
      return await res.json();
    },
    onSuccess: (data) => {
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
      setShowImportDialog(false);
      setImportPreview([]);
      setImportRefNumbers([]);
      const notFoundMsgs = (data.notFound || []).map(
        (n: any) => `${n.articleCode}: requested ${n.requestedQty}, found ${n.foundQty}`
      );
      const notFoundRefMsgs =
        (data.notFoundRefs || []).length > 0 ? `Not found: ${(data.notFoundRefs as string[]).join(", ")}` : undefined;
      toast({
        title: `Import complete — ${data.added} bale${data.added === 1 ? "" : "s"} added`,
        description: notFoundMsgs.length > 0 ? `Short: ${notFoundMsgs.join(", ")}` : notFoundRefMsgs,
      });
      setTimeout(() => scannerRef.current?.focus(), 100);
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Import failed", description: error.message, variant: "destructive" });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async (variables: { txDate?: string; createCarryoverProforma?: boolean }) => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/finalize-loading`, variables);
      return await res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries(
        { predicate: keyStartsWith("/api/factory/customer-orders"), refetchType: "active" },
        { cancelRefetch: false }
      );
      const carriedOverProforma = data?.carriedOverProforma;
      toast({
        title: "Loading finalized",
        description: carriedOverProforma
          ? `Loading sent for verification. Proforma "${carriedOverProforma.name}" was created for the remaining quantity.`
          : "Loading has been sent for office verification",
      });
      setShowFinalizeDialog(false);
      navigate("/factory/invoicing?tab=invoices");
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      setShowFinalizeDialog(false);
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const saveNoteMutation = useMutation({
    mutationFn: async (note: string) => {
      await modeApiRequest("PATCH", `/api/factory/customer-orders/${orderId}/loading-note`, { note });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(
        { predicate: keyStartsWith("/api/factory/customer-orders"), refetchType: "active" },
        { cancelRefetch: false }
      );
      toast({ title: "Note saved" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Failed to save note", description: error.message, variant: "destructive" });
    },
  });

  const chosenProforma = useCallback(
    () =>
      selectedProformaId && selectedProformaId !== "none"
        ? proformas.find((p) => p.id === parseInt(selectedProformaId)) || null
        : null,
    [selectedProformaId, proformas]
  );

  const handleStartLoading = useCallback(async () => {
    if (!customerId || !selectedLocationId) return;
    const proforma = chosenProforma();
    if (proforma && proformaCapacity?.proformaId === proforma.id && proformaCapacity.remainingTotalQty <= 0) {
      toast({ title: "Proforma fully consumed", description: "No remaining quantity is available for a new loading." });
      return;
    }

    // Check if there are already pending loading orders for this proforma
    if (proforma) {
      try {
        const res = await fetch(`/api/factory/customer-orders?customerId=${customerId}&proformaId=${proforma.id}`, {
          credentials: "include",
        });
        if (res.ok) {
          const allOrders: any[] = await res.json();
          const pending = allOrders.filter((o: { status: string }) => OPEN_ORDER_STATUSES.includes(o.status));
          if (pending.length > 0) {
            setPendingOrders(pending);
            setShowPendingWarning(true);
            return;
          }
        }
      } catch {
        // If check fails, proceed with creation anyway
      }
    }

    createOrderMutation.mutate({
      customerId,
      proformaIdUsed: proforma?.id || null,
      locationId: parseInt(selectedLocationId),
      orderDate,
      containerNotes: loadingNote.trim() || undefined,
    });
  }, [
    customerId,
    selectedLocationId,
    chosenProforma,
    proformaCapacity,
    orderDate,
    loadingNote,
    createOrderMutation,
    toast,
  ]);

  /** "Start New Loading" from the pending-orders warning — no note is carried over. */
  const startNewLoadingAnyway = () => {
    setShowPendingWarning(false);
    const proforma = chosenProforma();
    createOrderMutation.mutate({
      customerId: customerId!,
      proformaIdUsed: proforma?.id || null,
      locationId: parseInt(selectedLocationId),
      orderDate,
    });
  };

  const downloadTemplate = useCallback(async (mode: "ref" | "articleCode") => {
    const wb = XLSX.utils.book_new();
    let ws;
    if (mode === "ref") {
      ws = XLSX.utils.aoa_to_sheet([["Ref Number"], ["REF00001"], ["REF00002"], ["REF00003"]]);
      ws["!cols"] = [{ wch: 20 }];
    } else {
      ws = XLSX.utils.aoa_to_sheet([
        ["Article Code", "Qty"],
        ["ART001", 10],
        ["ART002", 5],
      ]);
      ws["!cols"] = [{ wch: 20 }, { wch: 10 }];
    }
    XLSX.utils.book_append_sheet(wb, ws, "Import");
    await XLSX.writeFile(
      wb,
      mode === "ref" ? "bale-import-ref-number-template.xlsx" : "bale-import-article-code-template.xlsx"
    );
  }, []);

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
        // When ignoreProforma is ON, always bypass the proforma check so the
        // first scan succeeds immediately (item still appears as "Not in Proforma"
        // in the comparison table — only the double-scan requirement is skipped).
        allowBypassProforma: ignoreProformaRef.current ? true : isBypassProforma || undefined,
        allowBypassOverload: isBypassOverload || undefined,
      });
    },
    [scanCode, orderId, selectedLocationId, pendingBypassBaleRef, pendingBypassOverloadRef, addBaleMutation]
  );

  const handleImportFile = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (evt) => {
        try {
          const data = new Uint8Array(evt.target?.result as ArrayBuffer);
          const wb = await XLSX.read(data, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws);

          // Detect mode: if any row has a "Ref" / "Reference" / "Ref Number" / "Ref Code" column, use ref mode
          const firstRow = rows[0] || {};
          const refKey = Object.keys(firstRow).find((k) =>
            /^ref(erence)?([\s_-]?(number|code|no|num))?$/i.test(k.trim())
          );

          if (refKey) {
            // REF NUMBER / REF CODE MODE
            const refs = rows.map((r) => String(r[refKey] ?? "").trim()).filter(Boolean);
            if (refs.length === 0) {
              toast({
                title: "No valid rows found",
                description: "Ensure the Ref / Ref Code column has values",
                variant: "destructive",
              });
              return;
            }
            setImportMode("refNumber");
            setImportRefNumbers(refs);
            setImportPreview([]);
            setShowImportDialog(true);
          } else {
            // ARTICLE CODE MODE (existing)
            const parsed = rows
              .map((r) => ({
                articleCode: String(
                  r["Article Code"] ?? r.articleCode ?? r.article_code ?? r.ArticleCode ?? r.ARTICLECODE ?? ""
                ).trim(),
                qty: parseInt(String(r.Qty ?? r.qty ?? r.QTY ?? r.Quantity ?? r.quantity ?? 0), 10) || 0,
              }))
              .filter((r) => r.articleCode && r.qty > 0);
            if (parsed.length === 0) {
              toast({
                title: "No valid rows found",
                description:
                  "Ensure columns are Article Code and Qty, or use a Ref Number column for individual bale import",
                variant: "destructive",
              });
              return;
            }
            setImportMode("articleCode");
            setImportPreview(parsed);
            setImportRefNumbers([]);
            setShowImportDialog(true);
          }
        } catch (err) {
          toast({ title: "Parse error", description: getErrorDetails(err).message, variant: "destructive" });
        }
      };
      reader.readAsArrayBuffer(file);
      e.target.value = "";
    },
    [toast]
  );

  const toggleGroup = useCallback((articleCode: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(articleCode)) next.delete(articleCode);
      else next.add(articleCode);
      return next;
    });
  }, []);

  const closeImportDialog = () => {
    setShowImportDialog(false);
    setImportPreview([]);
    setImportRefNumbers([]);
  };

  const submitImport = () => {
    if (importMode === "refNumber") {
      bulkImportMutation.mutate({ mode: "refNumber", refNumbers: importRefNumbers });
    } else {
      bulkImportMutation.mutate({ mode: "articleCode", items: importPreview });
    }
  };

  const bales = orderDetail?.bales || [];

  const groupedBalesMap = bales.reduce<Record<string, BaleGroup>>((acc, bale) => {
    const key = bale.articleCode ?? "__unknown__";
    if (!acc[key]) {
      acc[key] = {
        articleCode: bale.articleCode ?? "",
        baleName: bale.baleName,
        bales: [],
        totalWeight: 0,
      };
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

  // Stock count targets come from the same authoritative capacity buckets.
  const proformaArticleCodesForStock = useMemo(
    () =>
      proformaCapacityArticles(proformaCapacity)
        .filter((article) => article.isOnProforma)
        .map((article) => article.articleCode)
        .filter(Boolean),
    [proformaCapacity]
  );
  const stockLocationId = orderDetail?.locationId || (selectedLocationId ? parseInt(selectedLocationId) : null);
  const { data: stockCounts = {} } = useQuery<Record<string, number>>({
    queryKey: ["/api/factory/bale-stock-count", proformaArticleCodesForStock.join(","), stockLocationId],
    queryFn: async () => {
      if (proformaArticleCodesForStock.length === 0) return {};
      const params = new URLSearchParams({ articleCodes: proformaArticleCodesForStock.join(",") });
      if (stockLocationId) params.set("locationId", String(stockLocationId));
      const res = await fetch(`/api/factory/bale-stock-count?${params}`, { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    enabled: proformaArticleCodesForStock.length > 0,
    refetchInterval: 30000,
  });

  // Linked proforma metadata stays compact; all quantity math comes from the
  // authoritative capacity snapshot so sibling loadings are never missed.
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
    : proformas.find((p) => p.isActive) || null;

  const loadedByArticle = bales.reduce<Record<string, number>>((map, b) => {
    const key = b.articleCode ?? "__unknown__";
    map[key] = (map[key] || 0) + 1;
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
  const remainingProformaBales = proformaCapacity?.remainingTotalQty ?? 0;
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
    selectedCustomerId,
    setSelectedCustomerId,
    selectedLocationId,
    setSelectedLocationId,
    customerId,
    activeProformas,
    selectedProformaId,
    proformaCapacity,
    isProformaCapacityLoading: capacityQuery.isLoading || capacityQuery.isFetching,
    selectedProformaExhausted,
    setSelectedProformaId,
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
    baleRemovals,
    showRemovalLog,
    setShowRemovalLog,
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
    setPendingBypassBaleRef,
    pendingBypassOverloadRef,
    ignoreProforma,
    toggleIgnoreProforma,
    addBaleMutation,
    lastScannedRef,
    showLastScannedPopup,
    setShowLastScannedPopup,
    // removals
    baleToDelete,
    setBaleToDelete,
    removeBaleMutation,
    // import
    importFileRef,
    handleImportFile,
    downloadTemplate,
    showImportDialog,
    setShowImportDialog,
    closeImportDialog,
    submitImport,
    importMode,
    importPreview,
    importRefNumbers,
    bulkImportMutation,
    // proforma comparison
    linkedProforma,
    proformaProgress,
    remainingProformaBales,
    loadedByArticle,
    extraArticles,
    fulfilledCount,
    totalLines,
    stockCounts,
    stockLocationId,
    // finalize
    showFinalizeDialog,
    setShowFinalizeDialog,
    finalizeDate,
    setFinalizeDate,
    finalizeMutation,
    // pending-order warning
    showPendingWarning,
    setShowPendingWarning,
    pendingOrders,
    startNewLoadingAnyway,
  };
}

export type FactoryContainerLoadingScanModel = ReturnType<typeof useFactoryContainerLoadingScanModel>;
