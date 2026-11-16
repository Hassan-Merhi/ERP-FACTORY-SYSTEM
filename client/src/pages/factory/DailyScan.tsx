import { ScanLine, X, Loader2, ChevronDown, ChevronUp, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/formatNumber";
import { StatusBadge, formatDisplay } from "./getDailyScanPriority";
import { useDailyScanState } from "./useDailyScanState";
import { DailyScanSection } from "./DailyScanSection";

export default function DailyScan() {
  const {
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
        <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
      ) : totalBales === 0 ? (
        <div className="py-14 text-center text-sm text-muted-foreground">
          No bales produced on {formatDisplay(selectedDate)}
        </div>
      ) : (
        <div className="space-y-4">
          {/* ── All-done banner ── */}
          {allDone && (
            <div className="daily-scan-success flex items-center gap-2 rounded-md border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/40 px-4 py-3 text-sm text-green-800 dark:text-green-300">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              All {totalBales} bales verified for {formatDisplay(selectedDate)}
            </div>
          )}

          {/* ── Unscanned section (top) ── */}
          {unscanned.length > 0 && (
            <div className="space-y-2">
              <div className="daily-scan-alert flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />
                <span className="text-sm font-medium">
                  Unverified — {unscanned.length} bale{unscanned.length !== 1 ? "s" : ""} remaining
                </span>
              </div>
              <div className="daily-scan-table rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      <TableHead>Ref Code</TableHead>
                      <TableHead>Article Code</TableHead>
                      <TableHead>Product Name</TableHead>
                      <TableHead className="text-right">Weight (kg)</TableHead>
                      <TableHead>Date Produced</TableHead>
                      <TableHead>Worker</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {unscanned.map((b, i) => (
                      <TableRow key={b.id} data-testid={`row-unscanned-bale-${b.id}`}>
                        <TableCell className="text-muted-foreground text-sm">{i + 1}</TableCell>
                        <TableCell className="font-mono font-medium">{b.reference_number}</TableCell>
                        <TableCell className="text-sm">
                          {b.article_code ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-sm">
                          {b.product_name ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {b.weight_kg ? (
                            formatNumber(parseFloat(b.weight_kg))
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {b.date_bale_produced ? (
                            (() => {
                              const [y, m, d] = b.date_bale_produced.split("-");
                              return `${d}/${m}/${y}`;
                            })()
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {b.worker_name ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell>
                          <StatusBadge
                            status={b.status}
                            isInLoadingOrder={b.is_in_loading_order}
                            isDeleted={b.is_deleted}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {/* ── Scanned section (bottom, collapsible) ── */}
          {scanned.length > 0 && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowScanned((v) => !v)}
                className="daily-scan-scanned-toggle flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                data-testid="button-toggle-scanned-section"
              >
                {showScanned ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                Scanned — {scanned.length} bale{scanned.length !== 1 ? "s" : ""} · {formatNumber(scannedKg)} kg
              </button>

              {showScanned && (
                <div className="daily-scan-table daily-scan-table-completed rounded-md border opacity-80 overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead>Ref Code</TableHead>
                        <TableHead>Article Code</TableHead>
                        <TableHead>Product Name</TableHead>
                        <TableHead className="text-right">Weight (kg)</TableHead>
                        <TableHead>Date Produced</TableHead>
                        <TableHead>Worker</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Scanned At</TableHead>
                        <TableHead className="w-10" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {scanned.map((b, i) => {
                        const scanRow = scannedRefMap.get(b.reference_number)!;
                        return (
                          <TableRow key={b.id} data-testid={`row-scanned-bale-${b.id}`}>
                            <TableCell className="text-muted-foreground text-sm">{i + 1}</TableCell>
                            <TableCell className="font-mono font-medium text-muted-foreground">
                              {b.reference_number}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">{b.article_code ?? "—"}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">{b.product_name ?? "—"}</TableCell>
                            <TableCell className="text-right font-mono text-sm text-muted-foreground">
                              {b.weight_kg ? formatNumber(parseFloat(b.weight_kg)) : "—"}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {b.date_bale_produced
                                ? (() => {
                                    const [y, m, d] = b.date_bale_produced.split("-");
                                    return `${d}/${m}/${y}`;
                                  })()
                                : "—"}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">{b.worker_name ?? "—"}</TableCell>
                            <TableCell>
                              <StatusBadge
                                status={b.status}
                                isInLoadingOrder={b.is_in_loading_order}
                                isDeleted={b.is_deleted}
                              />
                            </TableCell>
                            <TableCell className="text-right text-sm text-muted-foreground">
                              {new Date(scanRow.scanned_at).toLocaleTimeString("en-GB")}
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => removeMutation.mutate(scanRow.id)}
                                disabled={removeMutation.isPending}
                                data-testid={`button-remove-scan-${scanRow.id}`}
                              >
                                <X className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </div>
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
