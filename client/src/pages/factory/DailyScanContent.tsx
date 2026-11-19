// Extracted from ./DailyScan.tsx
import { X, ChevronDown, ChevronUp, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/formatNumber";
import { formatDisplay } from "./DailyScanTypes";
import { StatusBadge } from "./getDailyScanPriority";
import { useDailyScanState } from "./useDailyScanState";

export function DailyScanContent({
  allDone,
  removeMutation,
  scanned,
  scannedKg,
  scannedRefMap,
  selectedDate,
  setShowScanned,
  showScanned,
  totalBales,
  unscanned,
}: Pick<
  ReturnType<typeof useDailyScanState>,
  | "allDone"
  | "removeMutation"
  | "scanned"
  | "scannedKg"
  | "scannedRefMap"
  | "selectedDate"
  | "setShowScanned"
  | "showScanned"
  | "totalBales"
  | "unscanned"
>) {
  return (
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
  );
}
