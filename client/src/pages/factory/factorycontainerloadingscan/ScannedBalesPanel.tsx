/**
 * Left column of the container loading scan page: the scan input with its
 * Ignore-Proforma and Excel import controls, the last-scanned banner, the
 * grouped bale list and the removal log.
 *
 * Split out of FactoryContainerLoadingScan.tsx unchanged — the input keeps
 * autofocus and its Enter-to-scan handler, the flash ring colours follow the
 * scan outcome, and detailed view still lists individual bales newest-first.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlignJustify,
  ChevronDown,
  ChevronUp,
  Download,
  History,
  Package,
  Rows3,
  ScanLine,
  ShieldOff,
  Trash2,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { FactoryContainerLoadingScanModel } from "./useFactoryContainerLoadingScanModel";

interface BaleScanAudit {
  id: number;
  scannedBy: string | null;
  scannedAt: string | null;
}

function formatScanDateTime(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const dateText = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timeText = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${dateText} • ${timeText}`;
}

function ScanControls({ model }: { model: FactoryContainerLoadingScanModel }) {
  if (!model.orderId) return null;
  return (
    <div className="mb-3 min-w-0" data-testid="container-loading-scan-controls">
      <div className="mb-2 flex min-w-0 flex-col gap-2 sm:mb-1 sm:flex-row sm:items-center sm:justify-between">
        <label className="text-sm font-medium">
          <ScanLine className="inline h-4 w-4 mr-1" />
          Scan Bale
        </label>
        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 sm:flex sm:w-auto sm:items-center sm:gap-1">
          <Button
            type="button"
            size="sm"
            variant={model.ignoreProforma ? "default" : "outline"}
            onClick={model.toggleIgnoreProforma}
            aria-pressed={model.ignoreProforma}
            className={
              model.ignoreProforma
                ? "min-w-0 bg-amber-500 px-2 text-white hover:bg-amber-600 sm:px-3"
                : "min-w-0 px-2 text-muted-foreground sm:px-3"
            }
            title={
              model.ignoreProforma
                ? "Ignore Proforma is ON — items not in proforma scan through immediately (still flagged). Click to turn off."
                : "Turn on to scan items not in the proforma without needing to scan twice."
            }
            data-testid="button-ignore-proforma"
          >
            <ShieldOff className="h-3 w-3 shrink-0 sm:mr-1" />
            <span className="hidden truncate min-[360px]:inline">
              {model.ignoreProforma ? "Ignore: ON" : "Ignore Proforma"}
            </span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => model.importFileRef.current?.click()}
            className="min-w-0 px-2 sm:px-3"
            data-testid="button-import-excel"
          >
            <Upload className="h-3 w-3 shrink-0 sm:mr-1" />
            <span className="truncate">Import Excel</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => model.downloadTemplate("ref")}
            className="px-2"
            data-testid="button-template-ref"
            title="Download Ref Number template"
            aria-label="Download Ref Number template"
          >
            <Download className="h-3 w-3" />
          </Button>
        </div>
        <input
          ref={model.importFileRef}
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={model.handleImportFile}
          data-testid="input-import-file"
        />
      </div>
      <Input
        ref={model.scannerRef}
        value={model.scanCode}
        onChange={(e) => model.setScanCode(e.target.value)}
        onKeyDown={model.handleScan}
        placeholder="Scan barcode, ref no., article code, item name (partial ok)…"
        disabled={!model.orderId || !model.selectedLocationId || model.addBaleMutation.isPending}
        className={`h-12 min-w-0 font-mono text-base sm:text-lg ${model.scanInputClass}`}
        autoFocus
        data-testid="input-scan-code"
      />
    </div>
  );
}

function BaleGroups({
  model,
  scanAuditByBaleId,
}: {
  model: FactoryContainerLoadingScanModel;
  scanAuditByBaleId: Map<number, BaleScanAudit>;
}) {
  if (model.orderedGroups.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-12 text-muted-foreground"
        data-testid="text-no-bales"
      >
        <Package className="h-12 w-12 mb-3 opacity-40" />
        <p>No bales scanned yet</p>
        <p className="text-sm mt-1">
          {!model.orderId ? "Set up the loading order first, then scan bales" : "Scan bales using the scanner above"}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {model.orderedGroups.map((group) => (
        <div key={group.articleCode} data-testid={`group-article-${group.articleCode}`}>
          <button
            type="button"
            className="w-full flex flex-wrap items-center justify-between gap-2 mb-1 px-1 cursor-pointer rounded-md p-2 hover-elevate"
            onClick={() => model.toggleGroup(group.articleCode)}
            data-testid={`button-toggle-group-${group.articleCode}`}
          >
            <div className="flex min-w-0 items-center gap-2">
              <Badge variant="outline" className="shrink-0" data-testid={`badge-article-${group.articleCode}`}>
                {group.articleCode}
              </Badge>
              <span className="min-w-0 truncate text-sm font-medium">{group.baleName}</span>
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span>Qty: {group.bales.length}</span>
              <span>Wt: {group.totalWeight.toFixed(2)} kg</span>
            </div>
          </button>
          {model.viewMode === "detailed" && (
            <Table>
              <TableBody>
                {[...group.bales]
                  .sort((a, b) => b.id - a.id)
                  .map((bale) => {
                    const scanAudit = scanAuditByBaleId.get(bale.id);
                    const scannedAtText = formatScanDateTime(scanAudit?.scannedAt ?? null);
                    return (
                      <TableRow key={bale.id} data-testid={`row-bale-${bale.id}`}>
                        <TableCell data-testid={`text-bale-ref-${bale.id}`}>
                          <div className="font-mono text-sm">{bale.baleReference}</div>
                          {bale.baleName && <div className="text-xs text-muted-foreground mt-0.5">{bale.baleName}</div>}
                          {scanAudit && (scanAudit.scannedBy || scannedAtText) && (
                            <div
                              className="text-[11px] text-muted-foreground mt-0.5"
                              data-testid={`text-bale-scan-audit-${bale.id}`}
                            >
                              {scanAudit.scannedBy ? `Scanned by ${scanAudit.scannedBy}` : "Scanned"}
                              {scannedAtText ? ` • ${scannedAtText}` : ""}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">
                          {parseFloat(bale.weight || "0").toFixed(2)} kg
                        </TableCell>
                        <TableCell className="w-[40px]">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => model.setBaleToDelete({ id: bale.id, baleReference: bale.baleReference })}
                            disabled={model.removeBaleMutation.isPending}
                            data-testid={`button-remove-bale-${bale.id}`}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          )}
        </div>
      ))}
    </div>
  );
}

function RemovalLog({ model }: { model: FactoryContainerLoadingScanModel }) {
  const { orderId, baleRemovals, showRemovalLog } = model;
  if (!orderId || baleRemovals.length === 0) return null;
  return (
    <div className="rounded-xl border overflow-hidden mt-4">
      <div className="p-3 sm:p-4">
        <button
          className="w-full flex items-center justify-between gap-2 text-sm font-medium"
          onClick={() => model.setShowRemovalLog((v) => !v)}
          data-testid="button-toggle-removal-log"
          type="button"
        >
          <span className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            Removed Bales
            <Badge variant="secondary" data-testid="badge-removal-count">
              {baleRemovals.length}
            </Badge>
          </span>
          {showRemovalLog ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
        {showRemovalLog && (
          <Table className="mt-3">
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Article</TableHead>
                <TableHead className="text-right">Weight</TableHead>
                <TableHead>Removed By</TableHead>
                <TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {baleRemovals.map((r) => (
                <TableRow key={r.id} data-testid={`row-removal-${r.id}`} className="text-sm text-muted-foreground">
                  <TableCell className="font-mono" data-testid={`text-removal-ref-${r.id}`}>
                    {r.referenceNumber}
                  </TableCell>
                  <TableCell>{r.articleCode || "—"}</TableCell>
                  <TableCell className="text-right">
                    {r.weightKg ? `${parseFloat(r.weightKg).toFixed(2)} kg` : "—"}
                  </TableCell>
                  <TableCell>{r.removedByUsername || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">{new Date(r.removedAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

export function ScannedBalesPanel({ model }: { model: FactoryContainerLoadingScanModel }) {
  const { scanFlash, bales, totalWeight, viewMode, lastScannedRef } = model;
  const { data: scanAuditRows = [] } = useQuery<BaleScanAudit[]>({
    queryKey: ["/api/factory/customer-orders", model.orderId, "scan-audit", bales.length],
    queryFn: async () => {
      const res = await fetch(`/api/factory/customer-orders/${model.orderId}/bale-removals?includeScanAudit=1`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(String(res.status));
      const payload = await res.json();
      return Array.isArray(payload?.scanAudit) ? payload.scanAudit : [];
    },
    enabled: !!model.orderId,
    staleTime: 0,
  });
  const scanAuditByBaleId = useMemo(() => new Map(scanAuditRows.map((entry) => [entry.id, entry])), [scanAuditRows]);

  return (
    <div className="flex min-h-0 min-w-0 flex-col lg:w-[60%]">
      <div
        className={`flex-1 flex flex-col min-h-0 rounded-xl border overflow-hidden transition-colors duration-300 ${scanFlash === "success" ? "ring-4 ring-green-500" : scanFlash === "error" ? "ring-2 ring-red-500" : ""}`}
      >
        {/* Scanned bales header strip */}
        <div
          className={`flex items-center justify-between gap-2 px-3 py-3 sm:px-4 border-b flex-wrap transition-colors duration-300 ${scanFlash === "success" ? "bg-green-50 dark:bg-green-950" : scanFlash === "error" ? "bg-red-50 dark:bg-red-950/30" : "bg-muted/20"}`}
        >
          <h2 className="font-semibold text-sm" data-testid="text-bales-header">
            Scanned Bales
          </h2>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" data-testid="badge-bale-count">
              {bales.length} bales
            </Badge>
            {bales.length > 0 && (
              <Badge variant="outline" data-testid="badge-total-weight">
                {totalWeight.toFixed(2)} kg
              </Badge>
            )}
            <Button
              size="icon"
              variant={viewMode === "detailed" ? "secondary" : "ghost"}
              onClick={() => model.setViewMode(viewMode === "detailed" ? "condensed" : "detailed")}
              title={viewMode === "detailed" ? "Switch to condensed view" : "Switch to detailed view"}
              data-testid="button-toggle-view-mode"
            >
              {viewMode === "detailed" ? <Rows3 className="h-4 w-4" /> : <AlignJustify className="h-4 w-4" />}
            </Button>
          </div>
        </div>
        <div className="flex flex-col flex-1 min-h-0 min-w-0 p-3 sm:p-4">
          <ScanControls model={model} />

          {viewMode === "detailed" && lastScannedRef && (
            <div
              className="mb-3 flex items-center gap-3 rounded-md bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 px-3 py-2"
              data-testid="banner-last-scanned"
            >
              <div className="text-xs font-medium text-green-700 dark:text-green-300 uppercase tracking-wide shrink-0">
                Last Scanned
              </div>
              <div className="min-w-0">
                <div className="font-mono font-bold text-sm text-green-900 dark:text-green-100 truncate">
                  {lastScannedRef.baleReference}
                </div>
                {lastScannedRef.baleName && (
                  <div className="text-xs text-green-700 dark:text-green-400 truncate">{lastScannedRef.baleName}</div>
                )}
              </div>
            </div>
          )}

          <div className="flex-1 min-w-0 overflow-y-auto">
            <BaleGroups model={model} scanAuditByBaleId={scanAuditByBaleId} />
          </div>
        </div>
      </div>

      {/* Removal log — only shown when there are removals */}
      <RemovalLog model={model} />
    </div>
  );
}
