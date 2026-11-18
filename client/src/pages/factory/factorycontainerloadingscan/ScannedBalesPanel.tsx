/**
 * Left column of the container loading scan page: the scan input with its
 * Ignore-Proforma and Excel import controls, the last-scanned banner, the
 * grouped bale list and the removal log.
 */
import { useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlignJustify, ChevronDown, ChevronUp, History, Rows3, ScanLine, Trash2, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "../customerLoadingFormat";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { canEmptyFactoryLoadingContainer } from "@shared/factoryPermissionCatalog";
import type { FactoryContainerLoadingScanModel } from "./useFactoryContainerLoadingScanModel";
import { BaleGroups, ScanControls, type BaleScanAudit } from "./ScannedBalesPanelBaleGroups";

function RemovalLog({ model }: { model: FactoryContainerLoadingScanModel }) {
  const { orderId, baleRemovals, showRemovalLog } = model;
  if (!orderId || baleRemovals.length === 0) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-blue-100/80 bg-white/90 dark:border-blue-500/20 dark:bg-[hsl(var(--factory-hue)_53%_13%)]/90">
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
  const [, navigate] = useLocation();
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
        className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] border border-blue-100/90 bg-white shadow-[0_18px_48px_-40px_hsl(var(--factory-hue)_71%_40%_/_0.75)] transition-all duration-300 dark:border-blue-500/25 dark:bg-[hsl(var(--factory-hue)_50%_13%)] ${
          scanFlash === "success" ? "ring-2 ring-green-500/80" : scanFlash === "error" ? "ring-2 ring-red-500/80" : ""
        }`}
      >
        <div
          className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 transition-colors sm:px-5 ${
            scanFlash === "success"
              ? "bg-green-50 dark:bg-green-950/40"
              : scanFlash === "error"
                ? "bg-red-50 dark:bg-red-950/30"
                : "bg-gradient-to-r from-blue-50/90 via-white to-white dark:from-[hsl(var(--factory-hue)_58%_18%)] dark:via-[hsl(var(--factory-hue)_57%_15%)] dark:to-[hsl(var(--factory-hue)_50%_13%)]"
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

            {model.orderId && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 border-blue-300 bg-blue-50 px-2.5 text-blue-700 hover:bg-blue-100 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-sky-200 dark:hover:bg-blue-500/20"
                onClick={() => navigate("/factory/sales/loading/dispatch/" + model.orderId)}
                title="Open truck dispatch verification for this loading"
                data-testid="button-loading-dispatch"
              >
                <Truck className="mr-1.5 h-3.5 w-3.5" />
                Dispatch
              </Button>
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

        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-gradient-to-b from-white to-slate-50/40 p-3 dark:from-[hsl(var(--factory-hue)_55%_12%)] dark:to-[hsl(var(--factory-hue)_57%_10%)] sm:p-4">
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
