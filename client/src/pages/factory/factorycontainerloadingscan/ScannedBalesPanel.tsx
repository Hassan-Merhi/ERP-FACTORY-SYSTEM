/**
 * Left column of the container loading scan page: the scan input with its
 * Ignore-Proforma and Excel import controls, the last-scanned banner, the
 * grouped bale list and the removal log.
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
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "../customerLoadingFormat";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { canEmptyFactoryLoadingContainer } from "@shared/factoryPermissionCatalog";
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
    <div
      className="mb-4 rounded-2xl border border-blue-100/80 bg-blue-50/40 p-3 dark:border-blue-500/20 dark:bg-[#0b1a31]/70 sm:p-4"
      data-testid="container-loading-scan-controls"
    >
      <div className="mb-3 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-blue-200/70 bg-blue-100 text-blue-600 dark:border-blue-400/20 dark:bg-blue-500/15 dark:text-sky-400">
              <ScanLine className="h-4 w-4 text-primary" />
            </span>
            {model.tr("scanBale")}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{model.tr("scanBaleHint")}</p>
        </div>

        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 sm:flex sm:w-auto sm:items-center">
          {model.canChangeExistingRecords && (
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
              title={model.ignoreProforma ? model.tr("ignoreProformaOnTitle") : model.tr("ignoreProformaOffTitle")}
              data-testid="button-ignore-proforma"
            >
              <ShieldOff className="h-3.5 w-3.5 shrink-0 sm:mr-1.5" />
              <span className="hidden truncate min-[360px]:inline">
                {model.ignoreProforma ? model.tr("ignoreOn") : model.tr("ignoreProforma")}
              </span>
            </Button>
          )}

          {model.canChangeExistingRecords && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => model.importFileRef.current?.click()}
              className="min-w-0 px-2 sm:px-3"
              data-testid="button-import-excel"
            >
              <Upload className="h-3.5 w-3.5 shrink-0 sm:mr-1.5" />
              <span className="truncate">{model.tr("importExcel")}</span>
            </Button>
          )}

          <Button
            size="sm"
            variant="ghost"
            onClick={() => model.downloadTemplate("ref")}
            className="px-2"
            data-testid="button-template-ref"
            title={model.tr("downloadRefTemplate")}
            aria-label={model.tr("downloadRefTemplate")}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        </div>

        {model.canChangeExistingRecords && (
          <input
            ref={model.importFileRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={model.handleImportFile}
            data-testid="input-import-file"
          />
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <ScanLine className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={model.scannerRef}
            value={model.scanCode}
            onChange={(e) => model.setScanCode(e.target.value)}
            onKeyDown={model.handleScan}
            placeholder={model.tr("scanPlaceholder")}
            disabled={
              !model.canChangeExistingRecords ||
              !model.orderId ||
              !model.orderDetail ||
              !model.selectedLocationId ||
              model.addBaleMutation.isPending
            }
            title={model.changeDisabledReason ?? undefined}
            className={`h-14 min-w-0 rounded-xl border-blue-200/80 bg-white pl-12 font-mono text-base shadow-sm transition-all focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:border-blue-500/25 dark:bg-[#0c172b] sm:text-lg ${model.scanInputClass}`}
            autoFocus
            data-testid="input-scan-code"
          />
        </div>
        <MobileBarcodeScanner
          onScan={model.submitScannedCode}
          feedback={model.cameraScanFeedback}
          disabled={
            !model.canChangeExistingRecords ||
            !model.orderId ||
            !model.orderDetail ||
            !model.selectedLocationId ||
            model.addBaleMutation.isPending
          }
          className="h-14 w-14 shrink-0"
        />
      </div>
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
        className="relative flex min-h-[280px] flex-col items-center justify-center overflow-hidden rounded-[22px] border border-dashed border-blue-200 bg-gradient-to-b from-blue-50/80 to-white px-4 py-12 text-center text-muted-foreground dark:border-blue-500/35 dark:from-[#0d2447] dark:via-[#0b1c37] dark:to-[#0a1528]"
        data-testid="text-no-bales"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 h-44 w-44 -translate-x-1/2 -translate-y-[70%] rounded-full bg-blue-400/10 blur-3xl dark:bg-blue-500/20"
        />
        <div className="relative mb-4 flex h-20 w-20 items-center justify-center rounded-[22px] border border-blue-300/60 bg-white/90 shadow-[0_16px_38px_-20px_rgba(37,99,235,0.6)] dark:border-blue-400/40 dark:bg-blue-500/15">
          <span
            aria-hidden="true"
            className="absolute -left-2 -top-2 h-4 w-4 rounded-tl-lg border-l-[3px] border-t-[3px] border-sky-500"
          />
          <span
            aria-hidden="true"
            className="absolute -right-2 -top-2 h-4 w-4 rounded-tr-lg border-r-[3px] border-t-[3px] border-sky-500"
          />
          <span
            aria-hidden="true"
            className="absolute -bottom-2 -left-2 h-4 w-4 rounded-bl-lg border-b-[3px] border-l-[3px] border-sky-500"
          />
          <span
            aria-hidden="true"
            className="absolute -bottom-2 -right-2 h-4 w-4 rounded-br-lg border-b-[3px] border-r-[3px] border-sky-500"
          />
          <Package className="h-10 w-10 text-blue-500 dark:text-sky-300" />
        </div>
        <p className="relative text-base font-semibold text-foreground">{model.tr("noBalesScanned")}</p>
        <p className="relative mt-1 max-w-sm text-sm">
          {!model.orderId ? model.tr("setupFirstHint") : model.tr("scannedAppearHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {model.orderedGroups.map((group) => (
        <div
          key={group.articleCode}
          className="overflow-hidden rounded-xl border border-blue-100/80 bg-white/75 shadow-sm dark:border-blue-500/15 dark:bg-[#0e1b32]/80"
          data-testid={`group-article-${group.articleCode}`}
        >
          <button
            type="button"
            className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
            onClick={() => model.toggleGroup(group.articleCode)}
            data-testid={`button-toggle-group-${group.articleCode}`}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <Badge
                variant="outline"
                className="shrink-0 rounded-md border-blue-200 bg-blue-50 font-mono text-blue-700 dark:border-blue-500/25 dark:bg-blue-500/10 dark:text-sky-300"
                data-testid={`badge-article-${group.articleCode}`}
              >
                {group.articleCode}
              </Badge>
              <span className="min-w-0 truncate text-sm font-medium">{group.baleName}</span>
            </div>

            <div className="flex items-center gap-3 text-xs text-muted-foreground sm:text-sm">
              <span>
                <span className="font-mono font-semibold text-foreground">{group.bales.length}</span> {model.tr("qty")}
              </span>
              <span className="h-4 w-px bg-border" />
              <span className="font-mono">
                {formatNumber(group.totalWeight, 2)} {model.tr("kgUnit")}
              </span>
            </div>
          </button>

          {model.viewMode === "detailed" && (
            <div className="border-t bg-muted/5">
              <Table>
                <TableBody>
                  {[...group.bales]
                    .sort((a, b) => b.id - a.id)
                    .map((bale) => {
                      const scanAudit = scanAuditByBaleId.get(bale.id);
                      const scannedAtText = formatScanDateTime(scanAudit?.scannedAt ?? null);

                      return (
                        <TableRow
                          key={bale.id}
                          className="border-border/60 hover:bg-muted/30"
                          data-testid={`row-bale-${bale.id}`}
                        >
                          <TableCell className="py-2.5" data-testid={`text-bale-ref-${bale.id}`}>
                            <div className="font-mono text-sm font-medium">{bale.baleReference}</div>
                            {bale.baleName && (
                              <div className="mt-0.5 text-xs text-muted-foreground">{bale.baleName}</div>
                            )}
                            {scanAudit && (scanAudit.scannedBy || scannedAtText) && (
                              <div
                                className="mt-0.5 text-[11px] text-muted-foreground/80"
                                data-testid={`text-bale-scan-audit-${bale.id}`}
                              >
                                {scanAudit.scannedBy
                                  ? model.tr("scannedBy", { name: scanAudit.scannedBy })
                                  : model.tr("scanned")}
                                {scannedAtText ? ` • ${scannedAtText}` : ""}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="py-2.5 text-right font-mono text-sm text-muted-foreground">
                            {formatNumber(parseFloat(bale.weight || "0"), 2)} {model.tr("kgUnit")}
                          </TableCell>
                          <TableCell className="w-[44px] py-2.5">
                            {model.canChangeExistingRecords && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                onClick={() =>
                                  model.setBaleToDelete({ id: bale.id, baleReference: bale.baleReference })
                                }
                                disabled={model.removeBaleMutation.isPending}
                                data-testid={`button-remove-bale-${bale.id}`}
                                title={model.tr("returnBaleToStock")}
                                aria-label={model.tr("returnNamedBaleToStock", { reference: bale.baleReference })}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            </div>
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
    <div className="mt-3 overflow-hidden rounded-2xl border border-blue-100/80 bg-white/90 dark:border-blue-500/20 dark:bg-[#101d34]/90">
      <button
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-sm font-medium transition-colors hover:bg-muted/30"
        onClick={() => model.setShowRemovalLog((v) => !v)}
        data-testid="button-toggle-removal-log"
        type="button"
      >
        <span className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          {model.tr("removedBales")}
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
        <div className="border-t">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{model.tr("reference")}</TableHead>
                <TableHead>{model.tr("article")}</TableHead>
                <TableHead className="text-right">{model.tr("weight")}</TableHead>
                <TableHead>{model.tr("removedBy")}</TableHead>
                <TableHead>{model.tr("time")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {baleRemovals.map((r) => (
                <TableRow key={r.id} data-testid={`row-removal-${r.id}`} className="text-sm text-muted-foreground">
                  <TableCell className="font-mono" data-testid={`text-removal-ref-${r.id}`}>
                    {r.referenceNumber}
                  </TableCell>
                  <TableCell>{r.articleCode || "—"}</TableCell>
                  <TableCell className="text-right font-mono">
                    {r.weightKg ? (
                      <>
                        {formatNumber(parseFloat(r.weightKg), 2)} {model.tr("kgUnit")}
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>{r.removedByUsername || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">{new Date(r.removedAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function ScannedBalesPanel({ model }: { model: FactoryContainerLoadingScanModel }) {
  const { scanFlash, bales, totalWeight, viewMode, lastScannedRef } = model;
  const { data: currentUser } = useQuery<{
    id?: string | number;
    role?: string | null;
    currentRole?: string | null;
    currentCompanyId?: number | null;
  }>({ queryKey: ["/api/auth/me"] });
  const { data: factoryAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", currentUser?.currentCompanyId),
    enabled: Boolean(currentUser?.id && currentUser?.currentCompanyId),
  });
  const canEmptyContainer = canEmptyFactoryLoadingContainer({
    role: currentUser?.currentRole ?? currentUser?.role,
    hasFactoryAccess: factoryAccess?.hasFactoryAccess,
    pageKeys: factoryAccess?.pageKeys,
    hiddenCostFields: factoryAccess?.hiddenCostFields,
  });
  // Scan audit fields now ride on the order's bale rows. This avoids a second
  // growing request after every scan while preserving the exact same UI.
  const scanAuditByBaleId = useMemo(
    () =>
      new Map<number, BaleScanAudit>(
        bales.map((bale) => [
          bale.id,
          {
            id: bale.id,
            scannedBy: bale.scannedBy ?? null,
            scannedAt: bale.scannedAt ?? null,
          },
        ])
      ),
    [bales]
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-col xl:w-[60%]">
      <div
        className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] border border-blue-100/90 bg-white shadow-[0_18px_48px_-40px_rgba(30,64,175,0.75)] transition-all duration-300 dark:border-blue-500/25 dark:bg-[#101b30] ${
          scanFlash === "success" ? "ring-2 ring-green-500/80" : scanFlash === "error" ? "ring-2 ring-red-500/80" : ""
        }`}
      >
        <div
          className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 transition-colors sm:px-5 ${
            scanFlash === "success"
              ? "bg-green-50 dark:bg-green-950/40"
              : scanFlash === "error"
                ? "bg-red-50 dark:bg-red-950/30"
                : "bg-gradient-to-r from-blue-50/90 via-white to-white dark:from-[#132848] dark:via-[#10213b] dark:to-[#101b30]"
          }`}
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-blue-200 bg-blue-100/90 text-blue-600 dark:border-blue-400/25 dark:bg-blue-500/15 dark:text-sky-400">
              <ScanLine className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold tracking-tight sm:text-base" data-testid="text-bales-header">
                {model.tr("scannedBales")}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{model.tr("liveContents")}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Badge
              variant="secondary"
              className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 font-semibold text-blue-700 dark:border-blue-400/30 dark:bg-blue-500/15 dark:text-sky-300"
              data-testid="badge-bale-count"
            >
              {bales.length} {model.tr("balesLower")}
            </Badge>
            {bales.length > 0 && (
              <Badge variant="outline" className="rounded-lg px-2.5 py-1 font-mono" data-testid="badge-total-weight">
                {formatNumber(totalWeight, 2)} {model.tr("kgUnit")}
              </Badge>
            )}

            {model.canChangeExistingRecords && canEmptyContainer && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => model.setShowEmptyContainerConfirm(true)}
                disabled={bales.length === 0 || model.emptyContainerMutation.isPending}
                className="h-8 px-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:px-2.5"
                title={model.tr("emptyContainerTitle")}
                data-testid="button-empty-container"
              >
                <Trash2 className="h-3.5 w-3.5 shrink-0 sm:mr-1.5" />
                <span className="hidden sm:inline">
                  {model.emptyContainerMutation.isPending ? model.tr("emptying") : model.tr("empty")}
                </span>
              </Button>
            )}

            <Button
              size="icon"
              variant={viewMode === "detailed" ? "secondary" : "ghost"}
              className="h-8 w-8"
              onClick={() => model.setViewMode(viewMode === "detailed" ? "condensed" : "detailed")}
              title={viewMode === "detailed" ? model.tr("switchCondensed") : model.tr("switchDetailed")}
              data-testid="button-toggle-view-mode"
            >
              {viewMode === "detailed" ? <Rows3 className="h-4 w-4" /> : <AlignJustify className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-gradient-to-b from-white to-slate-50/40 p-3 dark:from-[#0e1a30] dark:to-[#0b1528] sm:p-4">
          <ScanControls model={model} />

          {viewMode === "detailed" && lastScannedRef && (
            <div
              className="mb-3 flex items-center gap-3 rounded-xl border border-green-200/80 bg-green-50/80 px-3 py-2.5 dark:border-green-800 dark:bg-green-950/30"
              data-testid="banner-last-scanned"
            >
              <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-green-500" />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-green-700 dark:text-green-300">
                  {model.tr("lastScanned")}
                </div>
                <div className="truncate font-mono text-sm font-semibold text-green-950 dark:text-green-100">
                  {lastScannedRef.baleReference}
                </div>
              </div>
              {lastScannedRef.baleName && (
                <div className="hidden max-w-[45%] truncate text-xs text-green-700 dark:text-green-400 sm:block">
                  {lastScannedRef.baleName}
                </div>
              )}
            </div>
          )}

          <div className="min-w-0 flex-1 overflow-y-auto pr-0.5">
            <BaleGroups model={model} scanAuditByBaleId={scanAuditByBaleId} />
          </div>
        </div>
      </div>

      <RemovalLog model={model} />
    </div>
  );
}
