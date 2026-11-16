// Extracted from ./FactoryInvoiceLoadingScan.tsx to keep that module under the source-size cap.
import { visibleTabInterval } from "@/lib/queryPolicies";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { CameraScanFeedback } from "@/components/MobileBarcodeScanner";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translateCameraScanMessage } from "@/i18n/mobileCameraScanTranslations";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useLocation, useRoute } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LoadingSummaryResponse } from "./factoryinvoiceloadingscan/types";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";

export function useFactoryInvoiceLoadingScanState() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/factory/invoices/:id/loading-scan");
  const invoiceId = params?.id ? parseInt(params.id) : null;
  const { toast } = useToast();
  const exportSessionExcel = async () => {
    try {
      await downloadFromUrl(`/api/factory/invoice-loading-sessions/${activeSessionId}/export/excel`, {
        fileName: exportFileName(`loading session ${activeSessionId}`, "xlsx"),
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };
  const { language } = useApplicationLanguage();
  const { formatDisplayDate } = useDateFormat();
  useEscapeToParent(`/factory/sales/invoices/${invoiceId}`);

  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [showStartForm, setShowStartForm] = useState(false);

  const lsKey = `loading-scan-form-${invoiceId}`;
  const savedForm = (() => {
    try {
      return JSON.parse(localStorage.getItem(lsKey) || "{}");
    } catch {
      return {};
    }
  })();
  const [truckNo, setTruckNo] = useState<string>(savedForm.truckNo ?? "");
  const [driverName, setDriverName] = useState<string>(savedForm.driverName ?? "");
  const [notes, setNotes] = useState<string>(savedForm.notes ?? "");

  const autosaveForm = useCallback(
    (updates: { truckNo?: string; driverName?: string; notes?: string }) => {
      try {
        const current = (() => {
          try {
            return JSON.parse(localStorage.getItem(lsKey) || "{}");
          } catch {
            return {};
          }
        })();
        localStorage.setItem(lsKey, JSON.stringify({ ...current, ...updates }));
      } catch {
        // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
      }
    },
    [lsKey]
  );

  const [scanInput, setScanInput] = useState("");
  const [scanFlash, setScanFlash] = useState<"success" | "error" | null>(null);
  const [scanMessage, setScanMessage] = useState("");
  const [cameraScanFeedback, setCameraScanFeedback] = useState<CameraScanFeedback | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [completeDialogOpen, setCompleteDialogOpen] = useState(false);
  const [baleRefLine, setBaleRefLine] = useState<{ code: string; name: string } | null>(null);
  const [viewSessionId, setViewSessionId] = useState<number | null>(null);

  const summaryKey = [`/api/factory/invoices/${invoiceId}/loading-summary`, activeSessionId];
  const {
    data: summary,
    isLoading,
    isError,
    error,
  } = useQuery<LoadingSummaryResponse>({
    queryKey: summaryKey,
    queryFn: async () => {
      const url = activeSessionId
        ? `/api/factory/invoices/${invoiceId}/loading-summary?sessionId=${activeSessionId}`
        : `/api/factory/invoices/${invoiceId}/loading-summary`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    enabled: !!invoiceId,
    refetchInterval: visibleTabInterval(10_000),
    retry: 1,
  });

  useEffect(() => {
    if (!summary || activeSessionId) return;
    const openSession = summary.sessions.find((s) => s.status === "OPEN");
    if (openSession) {
      setActiveSessionId(openSession.id);
    }
  }, [activeSessionId, summary]);

  useEffect(() => {
    if (activeSessionId && scanRef.current) {
      scanRef.current.focus();
    }
  }, [activeSessionId, summary?.currentSessionBales?.length]);

  const flashFeedback = useCallback((type: "success" | "error", msg: string) => {
    setScanFlash(type);
    setScanMessage(msg);
    setTimeout(() => setScanFlash(null), 1800);
  }, []);

  const createSessionMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/factory/invoices/${invoiceId}/loading-sessions`, {
        truckNo: truckNo || undefined,
        driverName: driverName || undefined,
        notes: notes || undefined,
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: (data) => {
      setActiveSessionId(data.session.id);
      setShowStartForm(false);
      queryClient.invalidateQueries({ queryKey: [`/api/factory/invoices/${invoiceId}/loading-summary`] });
      toast({ title: "Session started", description: `Loading session #${data.session.id} is now open.` });
    },
    onError: (err) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const scanBaleMutation = useMutation({
    mutationFn: async (barcode: string) => {
      const res = await apiRequest("POST", `/api/factory/invoice-loading-sessions/${activeSessionId}/scan-bale`, {
        barcode,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message);
      }
      return res.json();
    },
    onSuccess: (data, barcode) => {
      setScanInput("");
      queryClient.invalidateQueries({ queryKey: [`/api/factory/invoices/${invoiceId}/loading-summary`] });
      flashFeedback("success", `Scanned: ${data.bale?.referenceNumber || data.loadingBale?.baleReference}`);
      setCameraScanFeedback({
        type: "success",
        referenceNumber: data.bale?.referenceNumber || data.loadingBale?.baleReference || barcode,
        message: translateCameraScanMessage("invoiceSuccess", language),
      });
      setTimeout(() => scanRef.current?.focus(), 50);
    },
    onError: (err, barcode) => {
      setScanInput("");
      flashFeedback("error", err.message);
      setCameraScanFeedback({
        type: /already (?:been )?(?:scanned|loaded|added|in)|reserved for another loading/i.test(err.message)
          ? "duplicate"
          : "error",
        referenceNumber: barcode,
        message: err.message,
      });
      setTimeout(() => scanRef.current?.focus(), 50);
    },
  });

  const removeBaleFromSessionMutation = useMutation({
    mutationFn: async ({ sessionId, baleId }: { sessionId: number; baleId: number }) => {
      const res = await apiRequest("DELETE", `/api/factory/invoice-loading-sessions/${sessionId}/bales/${baleId}`);
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/factory/invoices/${invoiceId}/loading-summary`] });
      toast({ title: "Removed", description: "Bale removed and returned to unloaded." });
    },
    onError: (err) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const completeSessionMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/factory/invoice-loading-sessions/${activeSessionId}/complete`);
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      setActiveSessionId(null);
      queryClient.invalidateQueries({ queryKey: [`/api/factory/invoices/${invoiceId}/loading-summary`] });
      toast({ title: "Completed", description: "Loading session completed successfully." });
    },
    onError: (err) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const cancelSessionMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/factory/invoice-loading-sessions/${activeSessionId}/cancel`);
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      setActiveSessionId(null);
      queryClient.invalidateQueries({ queryKey: [`/api/factory/invoices/${invoiceId}/loading-summary`] });
      toast({ title: "Cancelled", description: "Loading session cancelled." });
    },
    onError: (err) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const createRemainingProformaMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/factory/invoices/${invoiceId}/create-remaining-proforma`);
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json() as Promise<{ proformaId: number; proformaName: string }>;
    },
    onSuccess: (data) => {
      toast({ title: "Proforma created", description: `"${data.proformaName}" is ready. Opening now…` });
      navigate(`/factory/sales/proformas/${data.proformaId}`);
    },
    onError: (err) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleScan = (e: React.FormEvent) => {
    e.preventDefault();
    const code = scanInput.trim();
    if (!code) return;
    scanBaleMutation.mutate(code);
  };

  const currentSession = summary?.sessions.find((s) => s.id === activeSessionId);
  const currentBales = summary?.currentSessionBales || [];
  const isFullyLoaded = (summary?.totals.remaining ?? 1) <= 0;
  const show50Warning = currentBales.length >= 50;
  const pendingLines = summary?.lines.filter((l) => l.remaining > 0) ?? [];
  const doneLineCount = (summary?.lines.length ?? 0) - pendingLines.length;
  return {
    activeSessionId,
    autosaveForm,
    baleRefLine,
    cameraScanFeedback,
    cancelDialogOpen,
    cancelSessionMutation,
    completeDialogOpen,
    completeSessionMutation,
    createRemainingProformaMutation,
    createSessionMutation,
    currentBales,
    currentSession,
    doneLineCount,
    driverName,
    error,
    exportSessionExcel,
    formatDisplayDate,
    handleScan,
    invoiceId,
    isError,
    isFullyLoaded,
    isLoading,
    navigate,
    notes,
    pendingLines,
    removeBaleFromSessionMutation,
    scanBaleMutation,
    scanFlash,
    scanInput,
    scanMessage,
    scanRef,
    setActiveSessionId,
    setBaleRefLine,
    setCancelDialogOpen,
    setCompleteDialogOpen,
    setDriverName,
    setNotes,
    setScanInput,
    setShowStartForm,
    setTruckNo,
    setViewSessionId,
    show50Warning,
    showStartForm,
    summary,
    truckNo,
    viewSessionId,
  };
}
