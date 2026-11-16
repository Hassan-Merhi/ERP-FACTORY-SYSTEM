import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { FACTORY_MOBILE_ACTION_BAR_CLEARANCE, FactoryMobileActionBar } from "@/components/ui/factory-mobile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ScanLine,
  ArrowLeft,
  Play,
  CheckCircle,
  XCircle,
  Trash2,
  AlertTriangle,
  Package,
  Truck,
  FilePlus,
} from "lucide-react";
import { StatusBadge } from "./factoryinvoiceloadingscan/components/StatusBadge";
import {
  BaleReferencesDialog,
  CancelSessionDialog,
  CompleteSessionDialog,
  SessionBalesDialog,
} from "./factoryinvoiceloadingscan/components/SessionDialogs";
import { SessionHistoryCard } from "./factoryinvoiceloadingscan/components/SessionHistoryCard";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { useFactoryInvoiceLoadingScanState } from "./useFactoryInvoiceLoadingScanState";
import {
  FactoryInvoiceLoadingScanCardSection,
  FactoryInvoiceLoadingScanCardSection2,
} from "./FactoryInvoiceLoadingScanCardSection2";

export default function FactoryInvoiceLoadingScan() {
  const {
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
  } = useFactoryInvoiceLoadingScanState();

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
    <div
      className={`mx-auto flex min-h-full max-w-5xl flex-col space-y-4 sm:p-6 ${activeSessionId && currentSession ? `${FACTORY_MOBILE_ACTION_BAR_CLEARANCE} sm:pb-6` : ""}`}
    >
      <PageHeader
        title={<span data-testid="text-invoice-title">{inv.invoiceNumber || `Order #${inv.id}`}</span>}
        backTarget={`/factory/sales/invoices/${invoiceId}`}
        meta={
          <>
            <Badge variant="default">Finalized</Badge>
            <Badge variant="outline" className="text-xs">
              Scan Loading
            </Badge>
            <span>
              {inv.customerName} · {inv.orderDate ? formatDisplayDate(inv.orderDate) : ""}
            </span>
          </>
        }
      />

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

      <FactoryInvoiceLoadingScanCardSection
        activeSessionId={activeSessionId}
        doneLineCount={doneLineCount}
        pendingLines={pendingLines}
        setBaleRefLine={setBaleRefLine}
      />

      {!activeSessionId && !isFullyLoaded && (
        <FactoryInvoiceLoadingScanCardSection2
          autosaveForm={autosaveForm}
          createSessionMutation={createSessionMutation}
          driverName={driverName}
          notes={notes}
          setDriverName={setDriverName}
          setNotes={setNotes}
          setShowStartForm={setShowStartForm}
          setTruckNo={setTruckNo}
          showStartForm={showStartForm}
          truckNo={truckNo}
        />
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
              <MobileBarcodeScanner
                onScan={(code) => scanBaleMutation.mutate(code)}
                feedback={cameraScanFeedback}
                disabled={!activeSessionId || scanBaleMutation.isPending}
                className="h-12 w-12 shrink-0"
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
                Press <kbd className="text-xs border rounded-sm px-1">Enter</kbd> to submit
              </span>
            </div>

            {currentBales.length > 0 && (
              <div className="table-responsive rounded-md border">
                <Table mobileLayout="cards">
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
              {/* Phones pin Complete / Cancel above the home indicator while scanning; on sm+ the
                  bar dissolves (`sm:contents`) and the buttons sit in this row as before. */}
              <FactoryMobileActionBar className="sm:contents" data-testid="invoice-loading-mobile-actions">
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
              </FactoryMobileActionBar>
              <div className="ml-auto flex items-center gap-2">
                <ExportButton
                  size="sm"
                  label="Export Excel (Session)"
                  onClick={() => void exportSessionExcel()}
                  data-testid="button-export-session-excel"
                />
                <ExportButton
                  kind="pdf"
                  size="sm"
                  label="Export PDF (Session)"
                  onClick={() =>
                    window.open(`/api/factory/invoice-loading-sessions/${activeSessionId}/export/pdf`, "_blank")
                  }
                  data-testid="button-export-session-pdf"
                />
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
