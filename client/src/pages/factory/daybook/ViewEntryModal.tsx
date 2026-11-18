/**
 * Factory Daybook entry detail modal.
 *
 * Roughly 1,400 lines of the original page, and self-contained: it takes an
 * entry and a close handler and owns everything else itself.
 */
import { LoadingState } from "@/components/ui/page-state";
import { DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/formatNumber";
import type { DaybookEntry } from "./types";
import { ContainerImportView } from "./entry-views/ContainerImportView";
import { PayrollPaymentView } from "./entry-views/PayrollPaymentView";
import { MixBatchView } from "./entry-views/MixBatchView";
import { LoadingCreatedView } from "./entry-views/LoadingCreatedView";
import { OpenContainerButton } from "./entry-views/OpenContainerButton";
import { formatDaybookDescription, formatTxType } from "./daybookUtils";
import { formatUsd } from "@/lib/moneyDisplay";
import { useViewEntryModalModel } from "./ViewEntryModalModel";
import { ViewEntryVoucherView } from "./ViewEntryVoucherView";

export function ViewEntryModal({
  entry,
  onClose,
  onNavigate,
  formatDisplayDate,
}: {
  entry: DaybookEntry;
  onClose: () => void;
  onNavigate: (path: string) => void;
  formatDisplayDate: (d: string) => string;
}) {
  const m = useViewEntryModalModel({ entry });
  const {
    isVoucherBacked,
    isContainerImport,
    containerDetail,
    supplierBalance,
    isPayrollPayment,
    payrollSummary,
    badgeVariant,
    badgeClass,
    isMixBatchCreated,
    mixBatchDetail,
    mixBatchSources,
    isLoadingCreated,
    loadingOrder,
    isBaleStockEntry,
    bales,
    amt,
    sym,
    isOffloadRawStock,
    metaContainerDetail,
    metaContainerId,
    isCommission,
    isWasteDisposal,
    isOtherCharge,
    otherChargeContainerDetail,
    isBaleRemoval,
    hasBalesMeta,
  } = m;

  if (isVoucherBacked) {
    return <ViewEntryVoucherView m={m} entry={entry} formatDisplayDate={formatDisplayDate} />;
  }

  // ── CONTAINER_IMPORT enriched view ──────────────────────────────────────
  if (isContainerImport) {
    return (
      <ContainerImportView
        entry={entry}
        containerDetail={containerDetail}
        supplierBalance={supplierBalance}
        onClose={onClose}
        formatDisplayDate={formatDisplayDate}
        onNavigate={onNavigate}
      />
    );
  }

  // ── PAYROLL_PAYMENT enriched view ────────────────────────────────────────
  if (isPayrollPayment) {
    return (
      <PayrollPaymentView
        entry={entry}
        payrollSummary={payrollSummary}
        formatDisplayDate={formatDisplayDate}
        badgeVariant={badgeVariant}
        badgeClass={badgeClass}
      />
    );
  }

  // ── MIX_BATCH_CREATED / MIX_BATCH_TOPUP enriched view ────────────────────
  if (isMixBatchCreated) {
    return (
      <MixBatchView
        entry={entry}
        mixBatchDetail={mixBatchDetail}
        onClose={onClose}
        formatDisplayDate={formatDisplayDate}
        mixBatchSources={mixBatchSources}
        onNavigate={onNavigate}
      />
    );
  }

  // ── LOADING_CREATED enriched view ───────────────────────────────────────
  if (isLoadingCreated) {
    return (
      <LoadingCreatedView
        entry={entry}
        onClose={onClose}
        formatDisplayDate={formatDisplayDate}
        loadingOrder={loadingOrder}
        badgeVariant={badgeVariant}
        badgeClass={badgeClass}
        onNavigate={onNavigate}
      />
    );
  }

  // ── BALE_STOCK_ENTRY enriched view ────────────────────────────────────────
  if (isBaleStockEntry && bales.length > 0) {
    const totalAmt = amt;
    const amtPerBale = bales.length > 0 ? totalAmt / bales.length : 0;
    const groups = bales.reduce((acc: Record<string, { count: number; totalAmount: number }>, b) => {
      const key = b.productName || b.ref || "Unknown";
      if (!acc[key]) acc[key] = { count: 0, totalAmount: 0 };
      acc[key].count += 1;
      acc[key].totalAmount += amtPerBale;
      return acc;
    }, {});
    const sortedGroups = Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
    return (
      <>
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <DialogTitle>Bale Stock Entry</DialogTitle>
            <Badge variant={badgeVariant} className={badgeClass}>
              Bale Stock Entry
            </Badge>
          </div>
          <DialogDescription>{formatDisplayDate(entry.txDate + "T00:00:00")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 border-b">
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Item
                  </th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Qty
                  </th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Total Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedGroups.map(([name, stats]) => (
                  <tr key={name} className="border-b last:border-0">
                    <td className="px-3 py-2 font-medium">{name}</td>
                    <td className="px-3 py-2 text-right font-mono">{stats.count}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      {sym}
                      {formatNumber(stats.totalAmount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/50 border-t font-semibold">
                  <td className="px-3 py-2 text-xs">Total</td>
                  <td className="px-3 py-2 text-right font-mono">{bales.length}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {sym}
                    {formatNumber(totalAmt)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </>
    );
  }

  // ── OFFLOAD_RAW_STOCK enriched view ────────────────────────────────────────
  if (isOffloadRawStock) {
    const c = metaContainerDetail;
    return (
      <>
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <DialogTitle>Offload Raw Stock</DialogTitle>
            <Badge variant={badgeVariant} className={badgeClass}>
              Offload Raw Stock
            </Badge>
          </div>
          <DialogDescription>{formatDisplayDate(entry.txDate + "T00:00:00")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border p-4 space-y-2">
            {!c && metaContainerId ? (
              <LoadingState title="Loading container details…" className="min-h-0 border-0 bg-transparent p-0 sm:p-0" />
            ) : c ? (
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <p className="font-semibold text-base">{c.supplierName || "Unknown Supplier"}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Container: <span className="font-mono">{c.containerNumber}</span>
                  </p>
                  {c.origin && <p className="text-xs text-muted-foreground">Origin: {c.origin}</p>}
                </div>
                <OpenContainerButton containerId={metaContainerId} onClose={onClose} onNavigate={onNavigate} />
              </div>
            ) : null}
          </div>
          <div className="rounded-md border px-4 py-3 space-y-1">
            <p className="text-xs text-muted-foreground">Amount</p>
            <p className="text-lg font-bold font-mono">
              {sym}
              {formatNumber(amt)}
            </p>
            {entry.currencyCode !== "USD" && parseFloat(entry.fxRateToUsd || "1") !== 1 && (
              <p className="text-xs font-mono text-muted-foreground">
                {formatUsd(parseFloat(entry.amountUsd || "0"), 0, 2)} USD
              </p>
            )}
            {entry.description && <p className="text-sm text-muted-foreground mt-1">{entry.description}</p>}
          </div>
        </div>
      </>
    );
  }

  // ── COMMISSION enriched view ───────────────────────────────────────────────
  if (isCommission) {
    const c = metaContainerDetail;
    return (
      <>
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <DialogTitle>Commission</DialogTitle>
            <Badge variant={badgeVariant} className={badgeClass}>
              Commission
            </Badge>
          </div>
          <DialogDescription>{formatDisplayDate(entry.txDate + "T00:00:00")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border p-4 space-y-2">
            {!c && metaContainerId ? (
              <LoadingState title="Loading container details…" className="min-h-0 border-0 bg-transparent p-0 sm:p-0" />
            ) : c ? (
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <p className="font-semibold text-base">{c.containerNumber}</p>
                  {c.supplierName && <p className="text-xs text-muted-foreground">Supplier: {c.supplierName}</p>}
                </div>
                <OpenContainerButton containerId={metaContainerId} onClose={onClose} onNavigate={onNavigate} />
              </div>
            ) : null}
          </div>
          <div className="rounded-md border px-4 py-3 space-y-1">
            <p className="text-xs text-muted-foreground">Commission Amount</p>
            <p className="text-lg font-bold font-mono">
              {sym}
              {formatNumber(amt)}
            </p>
            {entry.description && <p className="text-sm text-muted-foreground mt-1">{entry.description}</p>}
          </div>
        </div>
      </>
    );
  }

  // ── WASTE_DISPOSAL enriched view ───────────────────────────────────────────
  if (isWasteDisposal) {
    return (
      <>
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <DialogTitle>Waste Disposal</DialogTitle>
            <Badge variant={badgeVariant} className={badgeClass}>
              Waste Disposal
            </Badge>
          </div>
          <DialogDescription>{formatDisplayDate(entry.txDate + "T00:00:00")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {entry.description && (
            <div className="rounded-md border p-4">
              <p className="text-sm font-medium">{entry.description}</p>
            </div>
          )}
          <div className="rounded-md border px-4 py-3">
            <p className="text-xs text-muted-foreground">Written Off Value</p>
            <p className="text-lg font-bold font-mono">
              {sym}
              {formatNumber(amt)}
            </p>
          </div>
        </div>
      </>
    );
  }

  // ── OTHER_CHARGE enriched view ─────────────────────────────────────────────
  if (isOtherCharge) {
    const c = otherChargeContainerDetail;
    return (
      <>
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <DialogTitle>Other Charge</DialogTitle>
            <Badge variant={badgeVariant} className={badgeClass}>
              Other Charge
            </Badge>
          </div>
          <DialogDescription>{formatDisplayDate(entry.txDate + "T00:00:00")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {c && (
            <div className="rounded-md border p-4">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <p className="font-semibold text-base">{c.supplierName || c.containerNumber}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Container: <span className="font-mono">{c.containerNumber}</span>
                  </p>
                </div>
                <OpenContainerButton containerId={entry.referenceId} onClose={onClose} onNavigate={onNavigate} />
              </div>
            </div>
          )}
          <div className="rounded-md border px-4 py-3 space-y-1">
            <p className="text-xs text-muted-foreground">Amount</p>
            <p className="text-lg font-bold font-mono">
              {sym}
              {formatNumber(amt)}
            </p>
            {entry.description && <p className="text-sm text-muted-foreground mt-1">{entry.description}</p>}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <DialogTitle>Transaction Details</DialogTitle>
          <Badge variant={badgeVariant} className={badgeClass}>
            {formatTxType(entry.txType)}
          </Badge>
        </div>
        <DialogDescription>{formatDisplayDate(entry.txDate + "T00:00:00")}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Description</p>
          <p className="text-sm font-medium">{formatDaybookDescription(entry)}</p>
        </div>
        <div className="rounded-md border px-4 py-3 flex items-center justify-between gap-4">
          <div>
            <p className="text-xs text-muted-foreground">Amount</p>
            <p className="text-lg font-bold font-mono">
              {sym}
              {formatNumber(amt)}
            </p>
          </div>
          {entry.currencyCode !== "USD" && parseFloat(entry.fxRateToUsd) !== 1 && (
            <div className="text-right">
              <p className="text-xs text-muted-foreground">USD Equivalent</p>
              <p className="text-sm font-mono">{formatUsd(parseFloat(entry.amountUsd || "0"), 0, 2)}</p>
            </div>
          )}
        </div>
        {isBaleRemoval && bales.length === 0 && (
          <div className="rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            Bale details were not recorded for this entry (created before bale tracking was enabled).
          </div>
        )}
        {hasBalesMeta && bales.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">
              {isBaleRemoval ? "Removed Bales" : "Bales"} ({bales.length})
            </p>
            <div className="max-h-64 overflow-y-auto space-y-1">
              {bales.map((bale) => (
                <div
                  key={bale.ref}
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover-elevate cursor-pointer"
                  onClick={() => {
                    onClose();
                    onNavigate(`/factory/barcode-lookup?ref=${encodeURIComponent(bale.ref)}`);
                  }}
                  data-testid={`view-bale-row-${bale.ref}`}
                >
                  <div>
                    <span className="font-mono font-medium">{bale.ref}</span>
                    <span className="text-muted-foreground ml-2 text-xs">{bale.productName}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground text-xs">{parseFloat(bale.weightKg).toFixed(1)} kg</span>
                    <Badge variant={bale.status === "IN_STOCK" ? "secondary" : "outline"} className="text-xs">
                      {bale.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
