import { visibleTabInterval } from "@/lib/queryPolicies";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { useLocation, useRoute } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ScanLine,
  ArrowLeft,
  Play,
  CheckCircle,
  XCircle,
  Trash2,
  FileDown,
  FileSpreadsheet,
  AlertTriangle,
  Package,
  Truck,
  FilePlus,
} from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";

import type { LoadingSummaryResponse } from "./factoryinvoiceloadingscan/types";
import { StatusBadge } from "./factoryinvoiceloadingscan/components/StatusBadge";
import {
  BaleReferencesDialog,
  CancelSessionDialog,
  CompleteSessionDialog,
  SessionBalesDialog,
} from "./factoryinvoiceloadingscan/components/SessionDialogs";
import { SessionHistoryCard } from "./factoryinvoiceloadingscan/components/SessionHistoryCard";

export default function FactoryInvoiceLoadingScan() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/factory/invoices/:id/loading-scan");
  const invoiceId = params?.id ? parseInt(params.id) : null;
  const { toast } = useToast();
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
    onSuccess: (data) => {
      setScanInput("");
      queryClient.invalidateQueries({ queryKey: [`/api/factory/invoices/${invoiceId}/loading-summary`] });
      flashFeedback("success", `Scanned: ${data.bale?.referenceNumber || data.loadingBale?.baleReference}`);
      setTimeout(() => scanRef.current?.focus(), 50);
    },
    onError: (err) => {
      setScanInput("");
      flashFeedback("error", err.message);
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

  if (isLoading) {
    return (
      <div className="p-6 space-y-4 max-w-5xl mx-auto">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || (!isLoading && !summary)) {
    const msg = error?.message || "Invoice not found";
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 gap-3">
        <p className="text-destructive font-medium">{msg}</p>
        <Button variant="outline" onClick={() => navigate(`/factory/sales/invoices/${invoiceId}`)}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Invoice
        </Button>
      </div>
    );
  }

  if (!summary) return null;

  const inv = summary.invoice;

  return (
    <div className="flex flex-col min-h-full p-4 sm:p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate(`/factory/sales/invoices/${invoiceId}`)}
          data-testid="button-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold" data-testid="text-invoice-title">
              {inv.invoiceNumber || `Order #${inv.id}`}
            </h1>
            <Badge variant="default">Finalized</Badge>
            <Badge variant="outline" className="text-xs">
              Scan Loading
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {inv.customerName} · {inv.orderDate ? formatDisplayDate(inv.orderDate) : ""}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardContent className="pt-5 pb-4 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Scanned</p>
            <p
              className="text-5xl font-bold text-green-600 dark:text-green-400 leading-none"
              data-testid="text-loaded-bales"
            >
              {summary.totals.alreadyLoaded}
            </p>
            <p className="text-xs text-muted-foreground mt-1">of {summary.totals.invoiceBales} bales</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Remaining</p>
            <p
              className={`text-5xl font-bold leading-none ${
                summary.totals.remaining === 0
                  ? "text-green-600 dark:text-green-400"
                  : "text-amber-600 dark:text-amber-400"
              }`}
              data-testid="text-remaining-bales"
            >
              {summary.totals.remaining}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {summary.sessions.length} session{summary.sessions.length !== 1 ? "s" : ""}
            </p>
          </CardContent>
        </Card>
      </div>

      {isFullyLoaded && (
        <Card className="border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950">
          <CardContent className="pt-4 pb-3 flex items-center gap-3">
            <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0" />
            <p className="text-sm font-medium text-green-800 dark:text-green-200">
              This invoice is fully loaded — all {summary.totals.invoiceBales} bales have been assigned to loading
              sessions.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium">Remaining Lines</CardTitle>
            {doneLineCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-green-700 dark:text-green-400 font-medium">
                <CheckCircle className="h-3.5 w-3.5" />
                {doneLineCount} line{doneLineCount !== 1 ? "s" : ""} fully loaded
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {pendingLines.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-6 text-green-700 dark:text-green-400">
              <CheckCircle className="h-5 w-5" />
              <span className="font-medium text-sm">All lines fully loaded</span>
            </div>
          ) : (
            <div className="table-responsive">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Article Code</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Invoice Qty</TableHead>
                    <TableHead className="text-right">Loaded</TableHead>
                    {activeSessionId && <TableHead className="text-right">This Session</TableHead>}
                    <TableHead className="text-right">Remaining</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingLines.map((line) => (
                    <TableRow key={line.lineId} data-testid={`row-line-${line.lineId}`}>
                      <TableCell className="font-mono text-xs">{line.articleCode}</TableCell>
                      <TableCell className="text-sm">
                        <button
                          className="text-left hover-elevate rounded-md px-1 -mx-1 py-0.5 font-medium underline-offset-2 hover:underline"
                          onClick={() => setBaleRefLine({ code: line.articleCode, name: line.productName })}
                          data-testid={`button-scan-bale-refs-${line.lineId}`}
                          title="Click to see all reference numbers"
                        >
                          {line.productName}
                        </button>
                      </TableCell>
                      <TableCell className="text-right text-sm">{line.invoiceQty}</TableCell>
                      <TableCell className="text-right text-sm text-green-700 dark:text-green-400">
                        {line.alreadyLoaded}
                      </TableCell>
                      {activeSessionId && (
                        <TableCell className="text-right text-sm text-blue-700 dark:text-blue-400">
                          {line.currentSessionLoaded}
                        </TableCell>
                      )}
                      <TableCell className="text-right text-sm font-bold text-amber-700 dark:text-amber-400">
                        {line.remaining}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {!activeSessionId && !isFullyLoaded && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm font-medium">Start New Loading Session</CardTitle>
              {!showStartForm && (
                <Button size="sm" onClick={() => setShowStartForm(true)} data-testid="button-show-start-form">
                  <Play className="h-4 w-4 mr-1" />
                  Start Loading
                </Button>
              )}
            </div>
          </CardHeader>
          {showStartForm && (
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label htmlFor="input-truck-no">Truck No.</Label>
                  <Input
                    id="input-truck-no"
                    placeholder="e.g. ABC-1234"
                    value={truckNo}
                    onChange={(e) => {
                      setTruckNo(e.target.value);
                      autosaveForm({ truckNo: e.target.value });
                    }}
                    data-testid="input-truck-no"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="input-driver-name">Driver Name</Label>
                  <Input
                    id="input-driver-name"
                    placeholder="Driver's name"
                    value={driverName}
                    onChange={(e) => {
                      setDriverName(e.target.value);
                      autosaveForm({ driverName: e.target.value });
                    }}
                    data-testid="input-driver-name"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="input-notes">Notes</Label>
                <Textarea
                  id="input-notes"
                  placeholder="Optional notes..."
                  value={notes}
                  onChange={(e) => {
                    setNotes(e.target.value);
                    autosaveForm({ notes: e.target.value });
                  }}
                  data-testid="input-notes"
                  className="resize-none"
                  rows={2}
                />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => createSessionMutation.mutate()}
                  disabled={createSessionMutation.isPending}
                  data-testid="button-create-session"
                >
                  <Play className="h-4 w-4 mr-1" />
                  {createSessionMutation.isPending ? "Starting…" : "Start Session"}
                </Button>
                <Button variant="ghost" onClick={() => setShowStartForm(false)} data-testid="button-cancel-start-form">
                  Cancel
                </Button>
              </div>
            </CardContent>
          )}
        </Card>
      )}

      {activeSessionId && currentSession && (
        <Card className="border-blue-200 dark:border-blue-800">
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm font-medium">Active Session #{currentSession.id}</CardTitle>
                <StatusBadge status={currentSession.status} />
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {currentSession.truckNo && (
                  <span className="flex items-center gap-1">
                    <Truck className="h-3 w-3" />
                    {currentSession.truckNo}
                  </span>
                )}
                {currentSession.driverName && <span>{currentSession.driverName}</span>}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {show50Warning && (
              <div className="flex items-center gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  This load has reached {currentBales.length} bales. You can continue scanning if this truck is taking
                  more.
                </p>
              </div>
            )}

            {scanFlash && (
              <div
                className={`flex items-center gap-2 p-3 rounded-md font-medium text-sm transition-all ${
                  scanFlash === "success"
                    ? "bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 border border-green-300 dark:border-green-700"
                    : "bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 border border-red-300 dark:border-red-700"
                }`}
                data-testid="text-scan-feedback"
              >
                {scanFlash === "success" ? (
                  <CheckCircle className="h-4 w-4 shrink-0" />
                ) : (
                  <XCircle className="h-4 w-4 shrink-0" />
                )}
                {scanMessage}
              </div>
            )}

            <form onSubmit={handleScan} className="flex gap-2">
              <Input
                ref={scanRef}
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                placeholder="Scan bale barcode / reference number…"
                className="font-mono text-base h-12 text-lg"
                autoComplete="off"
                autoFocus
                disabled={scanBaleMutation.isPending}
                data-testid="input-scanner"
              />
              <Button
                type="submit"
                size="default"
                className="h-12 px-5"
                disabled={!scanInput.trim() || scanBaleMutation.isPending}
                data-testid="button-scan-submit"
              >
                <ScanLine className="h-5 w-5" />
              </Button>
            </form>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                <strong className="text-foreground">{currentBales.length}</strong> scanned this session
              </span>
              <span>·</span>
              <span>
                <strong
                  className={
                    summary.totals.remaining === 0
                      ? "text-green-600 dark:text-green-400"
                      : "text-amber-600 dark:text-amber-400"
                  }
                >
                  {summary.totals.remaining}
                </strong>{" "}
                remaining overall
              </span>
              <span>·</span>
              <span>
                Press <kbd className="text-xs border rounded px-1">Enter</kbd> to submit
              </span>
            </div>

            {currentBales.length > 0 && (
              <div className="table-responsive rounded-md border">
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead className="w-8">#</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead>Article</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Weight (kg)</TableHead>
                      <TableHead className="text-right w-8"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...currentBales].reverse().map((b, i) => (
                      <TableRow key={b.id} data-testid={`row-scanned-bale-${b.baleId}`}>
                        <TableCell className="text-muted-foreground text-xs">{currentBales.length - i}</TableCell>
                        <TableCell className="font-mono text-sm">{b.baleReference}</TableCell>
                        <TableCell className="text-xs">{b.articleCode || "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{b.productName || "—"}</TableCell>
                        <TableCell className="text-right text-sm font-mono">
                          {parseFloat(b.weightKg || "0").toFixed(3)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              activeSessionId &&
                              removeBaleFromSessionMutation.mutate({ sessionId: activeSessionId, baleId: b.baleId })
                            }
                            disabled={removeBaleFromSessionMutation.isPending}
                            data-testid={`button-remove-bale-${b.baleId}`}
                            title="Remove from session"
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                onClick={() => setCompleteDialogOpen(true)}
                disabled={currentBales.length === 0 || completeSessionMutation.isPending}
                data-testid="button-complete-session"
              >
                <CheckCircle className="h-4 w-4 mr-1" />
                Complete Loading
              </Button>
              <Button variant="outline" onClick={() => setCancelDialogOpen(true)} data-testid="button-cancel-session">
                <XCircle className="h-4 w-4 mr-1" />
                Cancel Session
              </Button>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    window.open(`/api/factory/invoice-loading-sessions/${activeSessionId}/export/excel`, "_blank")
                  }
                  data-testid="button-export-session-excel"
                >
                  <FileSpreadsheet className="h-4 w-4 mr-1" />
                  Session Excel
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    window.open(`/api/factory/invoice-loading-sessions/${activeSessionId}/export/pdf`, "_blank")
                  }
                  data-testid="button-export-session-pdf"
                >
                  <FileDown className="h-4 w-4 mr-1" />
                  Session PDF
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {!activeSessionId &&
        !isFullyLoaded &&
        summary.totals.remaining > 0 &&
        summary.sessions.some((s) => s.status === "COMPLETED") && (
          <Card className="border-amber-200 dark:border-amber-800">
            <CardContent className="pt-4 pb-4 flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <FilePlus className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                    {summary.totals.remaining} bale{summary.totals.remaining !== 1 ? "s" : ""} not loaded
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Create a new proforma with the remaining items so you can start a new loading.
                  </p>
                </div>
              </div>
              <Button
                onClick={() => createRemainingProformaMutation.mutate()}
                disabled={createRemainingProformaMutation.isPending}
                data-testid="button-create-remaining-proforma"
              >
                <FilePlus className="h-4 w-4 mr-1" />
                {createRemainingProformaMutation.isPending ? "Creating…" : "Create Proforma for Remaining"}
              </Button>
            </CardContent>
          </Card>
        )}

      {summary.sessions.length > 0 && (
        <SessionHistoryCard
          invoiceId={invoiceId}
          sessions={summary.sessions}
          activeSessionId={activeSessionId}
          onViewSession={setViewSessionId}
          onResumeSession={setActiveSessionId}
        />
      )}

      {summary.sessions.length === 0 && !showStartForm && !activeSessionId && (
        <Card>
          <CardContent className="pt-8 pb-8 flex flex-col items-center gap-3 text-center">
            <Package className="h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground text-sm">No loading sessions yet for this invoice.</p>
            {!isFullyLoaded && (
              <Button onClick={() => setShowStartForm(true)} data-testid="button-show-start-form-empty">
                <Play className="h-4 w-4 mr-1" />
                Start Loading
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <CompleteSessionDialog
        open={completeDialogOpen}
        onOpenChange={setCompleteDialogOpen}
        sessionId={activeSessionId}
        baleCount={currentBales.length}
        isPending={completeSessionMutation.isPending}
        onConfirm={() => {
          setCompleteDialogOpen(false);
          completeSessionMutation.mutate();
        }}
      />

      <CancelSessionDialog
        open={cancelDialogOpen}
        onOpenChange={setCancelDialogOpen}
        sessionId={activeSessionId}
        isPending={cancelSessionMutation.isPending}
        onConfirm={() => {
          setCancelDialogOpen(false);
          cancelSessionMutation.mutate();
        }}
      />

      <SessionBalesDialog
        sessionId={viewSessionId}
        onClose={() => setViewSessionId(null)}
        session={summary.sessions.find((s) => s.id === viewSessionId)}
        bales={summary.invoiceBales.filter((b) => b.loadedSessionId === viewSessionId)}
        removePending={removeBaleFromSessionMutation.isPending}
        onRemoveBale={(baleId) =>
          viewSessionId && removeBaleFromSessionMutation.mutate({ sessionId: viewSessionId, baleId })
        }
      />

      <BaleReferencesDialog
        line={baleRefLine}
        onClose={() => setBaleRefLine(null)}
        bales={baleRefLine ? summary.invoiceBales.filter((b) => b.articleCode === baleRefLine.code) : []}
      />
    </div>
  );
}
