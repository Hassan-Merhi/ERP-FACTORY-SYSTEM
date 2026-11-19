import { ScanLine, X, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { Input } from "@/components/ui/input";
import { formatDisplay } from "./DailyScanTypes";
import { useDailyScanState } from "./useDailyScanState";
import { DailyScanSection } from "./DailyScanSection";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";
import { DailyScanContent } from "./DailyScanContent";

export default function DailyScan() {
  const {
    refetch,
    isError,
    dayBalesData,
    allDone,
    handleExport,
    handleScan,
    isLoading,
    isToday,
    lastScan,
    removeMutation,
    scanInput,
    scanRef,
    scanned,
    scannedKg,
    scannedRefMap,
    scanning,
    selectedDate,
    setLastScan,
    setScanInput,
    setSelectedDate,
    setShowScanned,
    showScanned,
    today,
    totalBales,
    totalKg,
    unscanned,
  } = useDailyScanState();

  return (
    <div className="daily-scan-modern space-y-4 pt-4 relative">
      {/* ── Date navigation ── */}
      <DailyScanSection
        handleExport={handleExport}
        isLoading={isLoading}
        isToday={isToday}
        scanned={scanned}
        scannedKg={scannedKg}
        selectedDate={selectedDate}
        setSelectedDate={setSelectedDate}
        today={today}
        totalBales={totalBales}
        totalKg={totalKg}
      />

      {/* ── Scan input ── */}
      <div className="daily-scan-scanner flex gap-2">
        <Input
          ref={scanRef}
          value={scanInput}
          onChange={(e) => setScanInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleScan()}
          placeholder="Scan bale ref code / barcode…"
          className="daily-scan-input font-mono"
          data-testid="input-daily-scan-ref"
          disabled={scanning}
        />
        <MobileBarcodeScanner onScan={(code) => void handleScan(code)} disabled={scanning} />
        <Button
          className="daily-scan-submit"
          onClick={() => void handleScan()}
          disabled={scanning || !scanInput.trim()}
          data-testid="button-daily-scan-submit"
        >
          {scanning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <ScanLine className="h-4 w-4 mr-1" />
              Scan
            </>
          )}
        </Button>
      </div>

      {/* ── Body ── */}
      {isLoading ? (
        <LoadingState />
      ) : isError && !dayBalesData ? (
        <ErrorState onAction={() => void refetch()} actionLabel="Try again" />
      ) : totalBales === 0 ? (
        <EmptyState title={`No bales produced on ${formatDisplay(selectedDate)}`} />
      ) : (
        <DailyScanContent
          allDone={allDone}
          removeMutation={removeMutation}
          scanned={scanned}
          scannedKg={scannedKg}
          scannedRefMap={scannedRefMap}
          selectedDate={selectedDate}
          setShowScanned={setShowScanned}
          showScanned={showScanned}
          totalBales={totalBales}
          unscanned={unscanned}
        />
      )}

      {/* ── Scan feedback panel (bottom-right) ── */}
      {lastScan && (
        <div
          className={`fixed bottom-6 right-6 z-50 flex items-start gap-3 rounded-md border px-4 py-3 shadow-lg w-72
            ${
              lastScan.type === "success"
                ? "bg-green-50 border-green-200 dark:bg-green-950/60 dark:border-green-800"
                : lastScan.type === "warn"
                  ? "bg-amber-50 border-amber-200 dark:bg-amber-950/60 dark:border-amber-800"
                  : "bg-red-50 border-red-200 dark:bg-red-950/60 dark:border-red-800"
            }`}
          data-testid="panel-scan-feedback"
        >
          <div className="mt-0.5 shrink-0">
            {lastScan.type === "success" ? (
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
            ) : lastScan.type === "warn" ? (
              <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            ) : (
              <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p
              className={`text-sm font-semibold font-mono truncate
              ${
                lastScan.type === "success"
                  ? "text-green-900 dark:text-green-200"
                  : lastScan.type === "warn"
                    ? "text-amber-900 dark:text-amber-200"
                    : "text-red-900 dark:text-red-200"
              }`}
            >
              {lastScan.refCode}
            </p>
            {(lastScan.articleCode || lastScan.productName) && (
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {[lastScan.articleCode, lastScan.productName].filter(Boolean).join(" · ")}
              </p>
            )}
            <p
              className={`text-xs mt-0.5
              ${
                lastScan.type === "success"
                  ? "text-green-700 dark:text-green-300"
                  : lastScan.type === "warn"
                    ? "text-amber-700 dark:text-amber-300"
                    : "text-red-700 dark:text-red-300"
              }`}
            >
              {lastScan.message}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setLastScan(null)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            data-testid="button-scan-feedback-dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
