import { ScanLine, Trash2, AlertCircle, X, Package, Loader2, Upload, ServerCrash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { formatNumber } from "@/lib/formatNumber";
import { StatusBadge } from "./groundscan/components/StatusBadge";
import { GroundScanSection } from "./useGroundScanState";
import { useGroundScanModel } from "./GroundScanModel";

export default function GroundScan() {
  const gs = useGroundScanModel();

  return (
    <div className="ground-scan-refresh flex flex-col gap-4 p-4">
      {/* ── Migration banner ── */}
      {gs.hasMigrationData && (
        <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <ServerCrash className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              You have {gs.localBales.length} locally stored scan{gs.localBales.length !== 1 ? "s" : ""} from a previous
              session
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Upload them so the whole team can see them, or discard them.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              onClick={gs.handleMigrateUpload}
              disabled={gs.uploading}
              data-testid="button-ground-scan-upload-local"
            >
              {gs.uploading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Upload className="h-4 w-4 mr-1" />}
              {gs.uploading ? "Uploading…" : "Upload Now"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={gs.handleMigrateDiscard}
              data-testid="button-ground-scan-discard-local"
            >
              Discard
            </Button>
          </div>
        </div>
      )}

      {/* ── Location selector ── */}
      <GroundScanSection
        selectedLocationId={gs.selectedLocationId}
        setSelectedLocationId={gs.setSelectedLocationId}
        stockLocations={gs.stockLocations}
      />

      {/* ── Scan bar ── */}
      <div className="ground-scan-toolbar flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex-1 flex flex-col gap-2">
          <div className="relative">
            <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={gs.scanRef}
              value={gs.scanInput}
              onChange={(e) => {
                gs.setScanInput(e.target.value);
                gs.setScanError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && gs.handleScan()}
              placeholder="Scan ref code / barcode..."
              className="ground-scan-input pl-9"
              disabled={gs.scanning}
              data-testid="input-ground-scan"
              autoComplete="off"
            />
          </div>
          {gs.scanError && (
            <div className="flex items-center gap-2 text-destructive text-sm" data-testid="text-ground-scan-error">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {gs.scanError}
            </div>
          )}
        </div>

        <div className="ground-scan-actions flex items-center gap-2 shrink-0">
          <MobileBarcodeScanner onScan={(code) => void gs.handleScan(code)} disabled={gs.scanning} />
          <Button
            onClick={() => void gs.handleScan()}
            disabled={gs.scanning || !gs.scanInput.trim()}
            className="ground-scan-submit"
            data-testid="button-ground-scan-confirm"
          >
            {gs.scanning ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <ScanLine className="mr-1.5 h-4 w-4" />
            )}
            {gs.scanning ? "Looking up..." : "Scan"}
          </Button>
          <ExportButton
            kind="excel"
            variant="outline"
            busy={gs.exporting}
            onClick={gs.exportExcel}
            disabled={gs.scannedBales.length === 0 || gs.exporting}
            className="ground-scan-export"
            data-testid="button-ground-scan-export"
          />
          {gs.scannedBales.length > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" data-testid="button-ground-scan-clear">
                  <Trash2 className="h-4 w-4 mr-1.5" />
                  Clear
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear all scans?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will remove all {gs.scannedBales.length} scanned bales from the shared list for everyone. This
                    cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => gs.clearMutation.mutate()}>Clear All</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {/* ── Stats ── */}
      <div className="ground-scan-summary flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <span data-testid="text-ground-scan-count">
            <span className="font-semibold text-foreground">{gs.scannedBales.length}</span> bale
            {gs.scannedBales.length !== 1 ? "s" : ""} scanned
          </span>
          <span data-testid="text-ground-scan-weight">
            <span className="font-semibold text-foreground">{formatNumber(gs.totalWeight, 2)} kg</span> total weight
          </span>
          {gs.isLoading && <span className="text-xs text-muted-foreground">Syncing…</span>}
        </div>
      </div>

      {/* ── Table ── */}
      {gs.scannedBales.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
          <Package className="h-10 w-10 opacity-30" />
          <p className="text-sm">Scan a bale to add it to the list</p>
        </div>
      ) : (
        <div className="ground-scan-table-shell rounded-md border overflow-x-auto">
          <Table className="ground-scan-table">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Ref Code</TableHead>
                <TableHead>Article Code</TableHead>
                <TableHead>Product Name</TableHead>
                <TableHead className="text-right">Weight (kg)</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date Produced</TableHead>
                <TableHead>Worker</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {gs.scannedBales.map((bale, idx) => (
                <TableRow key={bale.refCode} data-testid={`row-ground-scan-${bale.refCode}`}>
                  <TableCell className="text-muted-foreground text-xs">{gs.scannedBales.length - idx}</TableCell>
                  <TableCell className="font-mono text-sm" data-testid={`text-ground-scan-ref-${bale.refCode}`}>
                    {bale.refCode}
                  </TableCell>
                  <TableCell data-testid={`text-ground-scan-article-${bale.refCode}`}>
                    {bale.articleCode ? (
                      <Badge variant="outline">{bale.articleCode}</Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell data-testid={`text-ground-scan-product-${bale.refCode}`}>{bale.productName}</TableCell>
                  <TableCell className="text-right font-mono" data-testid={`text-ground-scan-weight-${bale.refCode}`}>
                    {formatNumber(bale.weightKg, 2)}
                  </TableCell>
                  <TableCell data-testid={`text-ground-scan-status-${bale.refCode}`}>
                    <StatusBadge status={bale.status} isInLoadingOrder={bale.isInLoadingOrder} />
                  </TableCell>
                  <TableCell
                    className="text-sm text-muted-foreground"
                    data-testid={`text-ground-scan-date-produced-${bale.refCode}`}
                  >
                    {bale.dateBaleProduced ? (
                      (() => {
                        const [y, m, d] = bale.dateBaleProduced.split("-");
                        return `${d}/${m}/${y}`;
                      })()
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell
                    className="text-sm text-muted-foreground"
                    data-testid={`text-ground-scan-worker-${bale.refCode}`}
                  >
                    {bale.workerName ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="ground-scan-remove"
                      aria-label={`Remove scan ${bale.refCode}`}
                      onClick={() => {
                        const item = gs.serverItems.find((i) => i.reference_number === bale.refCode);
                        if (item) gs.removeMutation.mutate(item.id);
                      }}
                      disabled={gs.removeMutation.isPending}
                      data-testid={`button-ground-scan-remove-${bale.refCode}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
