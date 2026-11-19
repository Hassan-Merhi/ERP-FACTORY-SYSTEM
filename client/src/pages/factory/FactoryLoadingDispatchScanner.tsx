import { AlertTriangle, CheckCircle2, Loader2, ScanLine, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { useFactoryLoadingDispatchScannerState, type Props } from "./useFactoryLoadingDispatchScannerState";
import { FactoryLoadingDispatchScannerCardSection } from "./FactoryLoadingDispatchScannerCardSection";

export default function FactoryLoadingDispatchScanner(props: Props & { embedded?: boolean }) {
  const embedded = Boolean(props.embedded);
  const {
    active,
    activeSelection,
    allFilteredSelected,
    bulkBusy,
    bulkMode,
    bulkReason,
    canCorrect,
    corrected,
    correcting,
    correction,
    correctionReason,
    data,
    error,
    feedback,
    filterText,
    filtered,
    formatDisplayDateTime,
    inputRef,
    isError,
    isLoading,
    onKeyDown,
    pendingCount,
    refetch,
    removeBulk,
    removeScan,
    removedVisible,
    scanText,
    selectAllFiltered,
    selectedIds,
    setBulkMode,
    setBulkReason,
    setCorrection,
    setCorrectionReason,
    setFilterText,
    setRemovedVisible,
    setScanText,
    setSelectedIds,
    setVisibleCount,
    status,
    submitBarcode,
    toggleSelection,
    visibleCount,
    visibleScans,
    writable,
  } = useFactoryLoadingDispatchScannerState(props);

  return (
    <div className={embedded ? "space-y-3" : "space-y-4"} data-testid="dispatch-verification-scanner">
      <Card className={embedded ? "border-0 bg-transparent shadow-none" : "border-blue-200 bg-white dark:border-blue-500/30 dark:bg-[hsl(var(--factory-hue)_53%_13%)]"}>
        <CardContent className={embedded ? "space-y-3 p-0" : "space-y-4 p-4 sm:p-5"}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-bold">
                <ScanLine className="h-5 w-5 text-blue-500" /> Truck barcode verification
              </h3>
              {!embedded && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Scan the exact reference of each bale entering this truck. This does not change main loading.
                </p>
              )}
            </div>
            <Badge
              variant="outline"
              className={writable ? "border-emerald-400 text-emerald-700 dark:text-emerald-300" : ""}
            >
              {status === "OPEN" ? "Trip open" : "Trip read-only"}
            </Badge>
          </div>
          {writable && (
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <ScanLine className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={inputRef}
                  value={scanText}
                  onChange={(event) => setScanText(event.target.value)}
                  onKeyDown={onKeyDown}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Scan bale reference and press Enter"
                  className="h-12 bg-white pl-10 font-mono dark:bg-[hsl(var(--factory-hue)_61%_10%)]"
                  data-testid="input-dispatch-scan"
                />
              </div>
              <MobileBarcodeScanner onScan={submitBarcode} feedback={feedback} className="h-12 w-12 shrink-0" />
              <Button
                type="button"
                size="sm"
                className="h-12 shrink-0"
                disabled={!scanText.trim()}
                onClick={() => {
                  const value = scanText;
                  setScanText("");
                  submitBarcode(value);
                  inputRef.current?.focus();
                }}
                data-testid="button-submit-dispatch-scan"
              >
                Verify
              </Button>
            </div>
          )}
          {!writable && (
            <p className="text-sm text-muted-foreground">
              This trip cannot accept further scans. The permanent verification record remains available below.
            </p>
          )}
          {pendingCount > 0 && (
            <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-sky-300" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {pendingCount} barcode(s) being processed or queued
            </div>
          )}
          {feedback && (
            <div
              role="status"
              aria-live="polite"
              data-testid="dispatch-scan-feedback"
              className={
                "flex items-start gap-2 rounded-xl border p-3 text-sm " +
                (feedback.type === "success"
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-200"
                  : feedback.type === "warn"
                    ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200"
                    : "border-red-300 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-950/30 dark:text-red-200")
              }
            >
              {feedback.type === "success" ? (
                <CheckCircle2 className="h-5 w-5 shrink-0" />
              ) : feedback.type === "warn" ? (
                <AlertTriangle className="h-5 w-5 shrink-0" />
              ) : (
                <XCircle className="h-5 w-5 shrink-0" />
              )}
              <div className="min-w-0">
                <p className="break-all font-mono font-semibold">{feedback.referenceNumber}</p>
                <p className="mt-1">{feedback.message}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <FactoryLoadingDispatchScannerCardSection
        embedded={embedded}
        active={active}
        activeSelection={activeSelection}
        allFilteredSelected={allFilteredSelected}
        bulkBusy={bulkBusy}
        canCorrect={canCorrect}
        corrected={corrected}
        correcting={correcting}
        data={data}
        error={error}
        filterText={filterText}
        filtered={filtered}
        formatDisplayDateTime={formatDisplayDateTime}
        isError={isError}
        isLoading={isLoading}
        pendingCount={pendingCount}
        refetch={refetch}
        removedVisible={removedVisible}
        selectAllFiltered={selectAllFiltered}
        selectedIds={selectedIds}
        setBulkMode={setBulkMode}
        setBulkReason={setBulkReason}
        setCorrection={setCorrection}
        setCorrectionReason={setCorrectionReason}
        setFilterText={setFilterText}
        setRemovedVisible={setRemovedVisible}
        setSelectedIds={setSelectedIds}
        setVisibleCount={setVisibleCount}
        toggleSelection={toggleSelection}
        visibleCount={visibleCount}
        visibleScans={visibleScans}
      />

      <Dialog
        open={bulkMode !== null}
        onOpenChange={(open) => {
          if (!open && !bulkBusy) setBulkMode(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {bulkMode === "all" ? "Delete all verified scans?" : "Delete selected verified scans?"}
            </DialogTitle>
            <DialogDescription>
              {bulkMode === "all"
                ? "This removes all " +
                  active.length +
                  " active scans from this dispatch, including scans not currently visible or filtered."
                : "This removes " + activeSelection.length + " selected active scans from this dispatch."}{" "}
              The operation is atomic and keeps permanent correction history. It does not remove bales from the main
              loading.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={bulkReason}
            rows={3}
            maxLength={500}
            placeholder="Required reason for deleting these scans"
            onChange={(event) => setBulkReason(event.target.value)}
            data-testid="input-bulk-dispatch-removal-reason"
          />
          <DialogFooter>
            <Button variant="outline" disabled={bulkBusy} onClick={() => setBulkMode(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={bulkBusy || bulkReason.trim().length < 3 || pendingCount > 0}
              onClick={() => void removeBulk()}
              data-testid="button-confirm-bulk-dispatch-removal"
            >
              {bulkBusy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {bulkMode === "all" ? "Delete all scans" : "Delete selected scans"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(correction)}
        onOpenChange={(open) => {
          if (!open && !correcting) setCorrection(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Correct dispatch verification</DialogTitle>
            <DialogDescription>
              Remove {correction?.baleReference || "this bale"} from active truck verification? The original scan
              remains in the permanent audit history. This never removes the bale from main loading.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={correctionReason}
            rows={3}
            maxLength={500}
            placeholder="Required reason for correction"
            onChange={(event) => setCorrectionReason(event.target.value)}
            data-testid="input-dispatch-correction-reason"
          />
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" disabled={correcting} onClick={() => setCorrection(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={correcting || correctionReason.trim().length < 3}
              onClick={() => void removeScan()}
              data-testid="button-confirm-dispatch-correction"
            >
              {correcting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Remove verification
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
