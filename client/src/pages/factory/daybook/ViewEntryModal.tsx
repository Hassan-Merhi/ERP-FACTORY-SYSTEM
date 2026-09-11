/**
 * Factory Daybook entry detail modal.
 *
 * Roughly 1,400 lines of the original page, and self-contained: it takes an
 * entry and a close handler and owns everything else itself.
 */
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/formatNumber";
import type { DaybookEntry } from "./types";
import type {
  ContainerDetail,
  ContainerImportDetail,
  LoadingOrder,
  MixBatchDetail,
  MixBatchSource,
  PayrollSummary,
  SupplierBalance,
  VoucherViewEntry,
} from "./entry-views/types";
import { apiNumber } from "./entry-views/types";
import { ContainerImportView } from "./entry-views/ContainerImportView";
import { PayrollPaymentView } from "./entry-views/PayrollPaymentView";
import { MixBatchView } from "./entry-views/MixBatchView";
import { LoadingCreatedView } from "./entry-views/LoadingCreatedView";
import {
  parseBalesMeta,
  formatDaybookDescription,
  currencySymbol,
  formatTxType,
  getFactoryTxTypeBadge,
} from "./daybookUtils";

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
  const isVoucherBacked = entry.referenceTable === "vouchers" && !!entry.referenceId;
  const isBaleStockEntry = entry.txType === "BALE_STOCK_ENTRY";
  const isBaleRemoval = entry.txType === "BALE_REMOVAL";
  const hasBalesMeta = isBaleStockEntry || isBaleRemoval;
  const isContainerImport = entry.txType === "CONTAINER_IMPORT" && !!entry.referenceId;
  const isPayrollPayment = entry.txType === "PAYROLL_PAYMENT" && !!entry.referenceId;
  const isMixBatchCreated =
    (entry.txType === "MIX_BATCH_CREATED" || entry.txType === "MIX_BATCH_TOPUP") && !!entry.referenceId;
  const isLoadingCreated = entry.txType === "LOADING_CREATED" && !!entry.referenceId;
  const isOffloadRawStock = entry.txType === "OFFLOAD_RAW_STOCK";
  const isCommission = entry.txType === "COMMISSION";
  const isWasteDisposal = entry.txType === "WASTE_DISPOSAL";
  const isOtherCharge = entry.txType === "OTHER_CHARGE";

  const entryMeta = (() => {
    try {
      return JSON.parse(entry.metaJson || "{}");
    } catch {
      return {};
    }
  })();
  const metaContainerId: number | undefined = entryMeta.containerId;

  const { data: viewEntries = [] } = useQuery<VoucherViewEntry[]>({
    queryKey: [`/api/vouchers/${entry.referenceId}/view-entries`],
    enabled: isVoucherBacked && !!entry.referenceId,
  });

  const { data: containerDetail } = useQuery<ContainerImportDetail>({
    queryKey: [`/api/factory/containers/${entry.referenceId}`],
    enabled: isContainerImport,
  });

  const { data: supplierBalance } = useQuery<SupplierBalance>({
    queryKey: [`/api/factory/suppliers/${containerDetail?.supplierId}/balance`],
    enabled: isContainerImport && !!containerDetail?.supplierId,
  });

  const { data: payrollSummary } = useQuery<PayrollSummary>({
    queryKey: [`/api/factory/payroll/${entry.referenceId}/summary`],
    enabled: isPayrollPayment,
  });

  const { data: mixBatchDetail } = useQuery<MixBatchDetail>({
    queryKey: [`/api/factory/mix-batches/${entry.referenceId}`],
    enabled: isMixBatchCreated,
  });

  const { data: mixBatchSources = [] } = useQuery<MixBatchSource[]>({
    queryKey: [`/api/factory/mix-batches/${entry.referenceId}/sources`],
    enabled: isMixBatchCreated,
  });

  const { data: loadingOrder } = useQuery<LoadingOrder>({
    queryKey: [`/api/factory/customer-orders/${entry.referenceId}`],
    enabled: isLoadingCreated,
  });

  const { data: metaContainerDetail } = useQuery<ContainerDetail>({
    queryKey: [`/api/factory/containers/${metaContainerId}`],
    enabled: (isOffloadRawStock || isCommission) && !!metaContainerId,
  });

  const { data: otherChargeContainerDetail } = useQuery<ContainerDetail>({
    queryKey: [`/api/factory/containers/${entry.referenceId}`],
    enabled: isOtherCharge && !!entry.referenceId,
  });

  // Balance fetching for Payment / Receipt / Journal vouchers
  const [sourceBalance, setSourceBalance] = useState<string | null>(null);
  const [entryBalances, setEntryBalances] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!isVoucherBacked || viewEntries.length === 0) {
      setSourceBalance(null);
      setEntryBalances({});
      return;
    }
    const txType = entry.txType;
    if (txType !== "PAYMENT" && txType !== "RECEIPT" && txType !== "JOURNAL") {
      setSourceBalance(null);
      setEntryBalances({});
      return;
    }

    // Determine source entry (the "Paid From" / "Received In" account)
    const src =
      txType === "PAYMENT"
        ? viewEntries.find((e) => apiNumber(e.creditAmount) > 0)
        : txType === "RECEIPT"
          ? viewEntries.find((e) => apiNumber(e.debitAmount) > 0)
          : null;

    // Determine display entries
    const display =
      txType === "PAYMENT"
        ? viewEntries.filter((e) => apiNumber(e.debitAmount) > 0)
        : txType === "RECEIPT"
          ? viewEntries.filter((e) => apiNumber(e.creditAmount) > 0)
          : viewEntries;

    const resolveUrl = (e: VoucherViewEntry): string | null => {
      if (e.ledgerAccountId) return `/api/accounts/ledger/${e.ledgerAccountId}/balance`;
      if (e.bankAccountId) return `/api/accounts/ledger/${e.bankAccountId}/balance`;
      if (e.customerId) return `/api/customers/${e.customerId}/balance`;
      if (e.employeeId) return `/api/employees/${e.employeeId}/balance`;
      if (e.supplierId) return `/api/suppliers/${e.supplierId}/balance`;
      if (e.factorySupplierId) return `/api/factory/suppliers/${e.factorySupplierId}/balance`;
      return null;
    };

    const fetchAll = async () => {
      // Source balance
      if (src) {
        const url = resolveUrl(src);
        if (url) {
          try {
            const r = await fetch(url, { credentials: "include" });
            if (r.ok) {
              const d = await r.json();
              setSourceBalance(d.balance?.toString() ?? null);
            }
          } catch {
            /* ignore */
          }
        }
      }
      // Per-entry balances
      const results: Record<number, string> = {};
      await Promise.all(
        display.map(async (e) => {
          const url = resolveUrl(e);
          if (!url) return;
          try {
            const r = await fetch(url, { credentials: "include" });
            if (r.ok) {
              const d = await r.json();
              results[e.id] = d.balance?.toString() || "0";
            }
          } catch {
            /* ignore */
          }
        })
      );
      setEntryBalances(results);
    };

    fetchAll();
  }, [isVoucherBacked, viewEntries, entry.txType]);

  const bales = parseBalesMeta(entry);
  const amt = parseFloat(entry.amountCurrency || "0");
  const sym = currencySymbol(entry.currencyCode);

  const totalDebit = viewEntries.reduce((s, e) => s + apiNumber(e.debitAmount), 0);
  const totalCredit = viewEntries.reduce((s, e) => s + apiNumber(e.creditAmount), 0);

  const { variant: badgeVariant, className: badgeClass } = getFactoryTxTypeBadge(entry.txType);

  if (isVoucherBacked) {
    // Determine voucher type from txType: PAYMENT → Payment, RECEIPT → Receipt, JOURNAL → Journal
    const voucherType =
      entry.txType === "PAYMENT"
        ? "Payment"
        : entry.txType === "RECEIPT"
          ? "Receipt"
          : entry.txType === "JOURNAL"
            ? "Journal"
            : entry.txType;

    const isPayment = voucherType === "Payment";
    const isReceipt = voucherType === "Receipt";
    const isJournal = voucherType === "Journal";
    const isPaymentOrReceipt = isPayment || isReceipt;

    // Source account: For Payment = credit entry (cash going OUT), For Receipt = debit entry (cash coming IN)
    const sourceEntry = isPayment
      ? viewEntries.find((e) => apiNumber(e.creditAmount) > 0)
      : isReceipt
        ? viewEntries.find((e) => apiNumber(e.debitAmount) > 0)
        : null;

    // Total = opposite side of source for Payment/Receipt
    const totalAmount = isPayment
      ? viewEntries.reduce((s: number, e) => s + apiNumber(e.debitAmount), 0)
      : isReceipt
        ? viewEntries.reduce((s: number, e) => s + apiNumber(e.creditAmount), 0)
        : Math.max(totalDebit, totalCredit);

    // Display entries: Payment = debit side only, Receipt = credit side only, Journal = all
    const displayEntries = isPayment
      ? viewEntries.filter((e) => apiNumber(e.debitAmount) > 0)
      : isReceipt
        ? viewEntries.filter((e) => apiNumber(e.creditAmount) > 0)
        : viewEntries;

    return (
      <>
        <DialogHeader>
          <DialogTitle>Voucher Details</DialogTitle>
          <DialogDescription>View voucher information</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 md:space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Date</p>
              <p className="font-medium">{formatDisplayDate(entry.txDate + "T00:00:00")}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Type</p>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={badgeVariant} className={badgeClass}>
                  {voucherType}
                </Badge>
                {entry.optional && <span className="text-sm text-muted-foreground">Optional</span>}
              </div>
            </div>
          </div>
          <div>
            <p className="text-sm text-muted-foreground mb-1">Description</p>
            <p className="text-sm font-medium">{formatDaybookDescription(entry)}</p>
          </div>

          {/* Paid From / Received In card — Payment and Receipt only */}
          {isPaymentOrReceipt && sourceEntry && (
            <div className="p-3 md:p-4 bg-muted/50 rounded-md">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
                <div>
                  <p className="text-sm text-muted-foreground mb-1">{isPayment ? "Paid From" : "Received In"}</p>
                  <p className="font-medium text-base md:text-lg">{sourceEntry.accountName}</p>
                  {sourceBalance !== null && (
                    <p className="text-sm font-mono mt-2 text-muted-foreground">
                      Balance: {sym}
                      {formatNumber(parseFloat(sourceBalance))}
                    </p>
                  )}
                </div>
                <div className="sm:text-right">
                  <p className="text-sm text-muted-foreground mb-1">Total Amount</p>
                  <p className="text-xl md:text-2xl font-bold font-mono">
                    {sym} {formatNumber(totalAmount)}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Entries table */}
          <div>
            <h3 className="font-semibold mb-3">Entries</h3>
            {viewEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No entries found</p>
            ) : (
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Account
                      </th>
                      {isPaymentOrReceipt || isJournal ? (
                        <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Amount
                        </th>
                      ) : (
                        <>
                          <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Debit
                          </th>
                          <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Credit
                          </th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {displayEntries.map((e, i: number) => (
                      <tr key={e.id ?? i} className="border-b last:border-0">
                        <td className="px-3 py-2">
                          <p className="font-medium">{e.accountName || "—"}</p>
                          {(isPaymentOrReceipt || isJournal) && entryBalances[e.id] !== undefined && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Balance: {sym}
                              {formatNumber(parseFloat(entryBalances[e.id] || "0"))}
                            </p>
                          )}
                        </td>
                        {isPaymentOrReceipt || isJournal ? (
                          <td className="px-3 py-2 text-right font-mono">
                            {sym}
                            {formatNumber(
                              Math.max(apiNumber(e.debitAmount), apiNumber(e.creditAmount))
                            )}
                          </td>
                        ) : (
                          <>
                            <td className="px-3 py-2 text-right font-mono">
                              {apiNumber(e.debitAmount) > 0
                                ? `${sym}${formatNumber(apiNumber(e.debitAmount))}`
                                : "-"}
                            </td>
                            <td className="px-3 py-2 text-right font-mono">
                              {apiNumber(e.creditAmount) > 0
                                ? `${sym}${formatNumber(apiNumber(e.creditAmount))}`
                                : "-"}
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/50 font-bold border-t">
                      <td className="px-3 py-2">Total</td>
                      {isPaymentOrReceipt || isJournal ? (
                        <td className="px-3 py-2 text-right font-mono">
                          {sym}
                          {formatNumber(totalAmount)}
                        </td>
                      ) : (
                        <>
                          <td className="px-3 py-2 text-right font-mono">
                            {sym}
                            {formatNumber(totalDebit)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {sym}
                            {formatNumber(totalCredit)}
                          </td>
                        </>
                      )}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </div>
      </>
    );
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
              <p className="text-sm text-muted-foreground">Loading container details…</p>
            ) : c ? (
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <p className="font-semibold text-base">{c.supplierName || "Unknown Supplier"}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Container: <span className="font-mono">{c.containerNumber}</span>
                  </p>
                  {c.origin && <p className="text-xs text-muted-foreground">Origin: {c.origin}</p>}
                </div>
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => {
                    onClose();
                    onNavigate(`/factory/containers?edit=${metaContainerId}`);
                  }}
                  data-testid="button-open-container"
                >
                  Open Container
                </Button>
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
                ${formatNumber(parseFloat(entry.amountUsd || "0"))} USD
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
              <p className="text-sm text-muted-foreground">Loading container details…</p>
            ) : c ? (
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <p className="font-semibold text-base">{c.containerNumber}</p>
                  {c.supplierName && <p className="text-xs text-muted-foreground">Supplier: {c.supplierName}</p>}
                </div>
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => {
                    onClose();
                    onNavigate(`/factory/containers?edit=${metaContainerId}`);
                  }}
                  data-testid="button-open-container"
                >
                  Open Container
                </Button>
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
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => {
                    onClose();
                    onNavigate(`/factory/containers?edit=${entry.referenceId}`);
                  }}
                  data-testid="button-open-container"
                >
                  Open Container
                </Button>
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
              <p className="text-sm font-mono">${formatNumber(parseFloat(entry.amountUsd || "0"))}</p>
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
