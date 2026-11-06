import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { DataTableToolbar } from "@/components/DataTableToolbar";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { MoneyAmount } from "@/components/MoneyAmount";
import { formatMoneyNumber } from "@/lib/moneyDisplay";
import { useAppMode } from "@/contexts/AppModeContext";
import { useMobileCardTable } from "@/components/ui/mobile-card-table";
import { AlertTriangle, ClipboardList, Copy, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { PaymentsReconciliation, type ReconciliationSnapshot } from "./property-rental/components/PaymentsReconciliation";
import { cashCents, nonCashCents, paymentHistoryTsv, receiptTotals } from "./property-rental/paymentsReceiptMath";
import {
  HISTORICAL_RENT_COMPANY,
  HISTORICAL_RENT_CUTOFF_LABEL,
  belongsToHistoricalRentSnapshot,
} from "./property-rental/historicalRentSnapshot";

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RECONCILIATION_VIEWS = [
  { key: "HISTORICAL_RENT", label: "Rent through 26 Oct" },
  { key: "ACTIVE_RENT", label: "Active rent" },
  { key: "GUARANTEE", label: "Guarantee movements" },
  { key: "ENDED_RENT", label: "Ended leases" },
  { key: "SCHEDULED", label: "Scheduled" },
  { key: "OTHER", label: "Other / billing adjustments" },
  { key: "ALL", label: "All records" },
] as const;
type ReconciliationView = (typeof RECONCILIATION_VIEWS)[number]["key"];
type PaymentRow = {
  id: number;
  paymentDate: string;
  amount: string;
  forYear: number;
  forMonth: number;
  notes: string | null;
  contractId: number;
  unitId: number;
  currency?: string;
  cashAccountId: number | null;
  voucherId: number | null;
  tenantName: string | null;
  unitNumber: string | null;
  locationGroup: string | null;
  sourceModule?: string;
  reconciliationCategory?: "ACTIVE_RENT" | "GUARANTEE" | "ENDED_RENT" | "SCHEDULED" | "OTHER";
  postingStatus?: string;
  receiptKind?: string;
  readOnly?: boolean;
};

interface Props {
  pageTitle: string;
  pageIcon?: React.ReactNode;
  testIdPrefix: string;
  apiBase?: string;
}

export default function RentalPaymentsLog({
  pageTitle,
  pageIcon,
  testIdPrefix,
  apiBase = "/api/properties/rental",
}: Props) {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const appMode = useAppMode();
  // ERP and Properties share the page-header contract; Factory keeps its hub strip.
  const isErp = appMode === "erp" || appMode === "properties";
  // Phones restack the payments table as cards in every mode.
  const { tableProps: cardTableProps } = useMobileCardTable();
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<PaymentRow | null>(null);
  const [reconciliationView, setReconciliationView] = useState<ReconciliationView>("HISTORICAL_RENT");
  const [reconciliation, setReconciliation] = useState<ReconciliationSnapshot | null>(null);

  // Both pages use the same voucher-backed dated rent snapshot. No payment is created.
  const isPropertiesPayments = apiBase === "/api/properties/rental";
  const isHassanProperties = isPropertiesPayments && selectedCompany?.name === HISTORICAL_RENT_COMPANY;
  const effectiveView = !isHassanProperties && reconciliationView === "HISTORICAL_RENT"
    ? "ACTIVE_RENT"
    : reconciliationView;
  const queryKey = [apiBase + "/payments", { companyId: selectedCompany?.id, view: isPropertiesPayments ? "warehouse-reconciliation" : "default" }];
  const { data: warehouseUnits = [], isLoading: warehouseTotalsLoading, isError: warehouseTotalsError } =
    useQuery<Array<{ totalPaid?: number | null }>>({
      queryKey: [apiBase + "/units", { unitType: "WAREHOUSE", companyId: selectedCompany?.id }],
      queryFn: async () => {
        const res = await fetch(`${apiBase}/units?unitType=WAREHOUSE`, { credentials: "include" });
        if (!res.ok) throw new Error("Failed to load warehouse rent totals");
        return res.json();
      },
      enabled: !!selectedCompany && isPropertiesPayments,
    });

  const { data: payments = [], isLoading, isError: paymentsError } = useQuery<PaymentRow[]>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(
        `${apiBase}/payments${isPropertiesPayments ? "?view=warehouse-reconciliation" : ""}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed to load payments");
      return res.json();
    },
    enabled: !!selectedCompany,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `${apiBase}/payments/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      toast({ title: "Payment deleted", description: "The payment and its accounting entry have been removed." });
      setDeleteTarget(null);
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Delete failed", description: e.message, variant: "destructive" });
      setDeleteTarget(null);
    },
  });

  const viewPayments = useMemo(() => {
    if (!isPropertiesPayments || effectiveView === "ALL") return payments;
    if (effectiveView === "HISTORICAL_RENT") return payments.filter(belongsToHistoricalRentSnapshot);
    if (effectiveView === "OTHER") {
      // Includes recorded unvouchered corrections, which are not cash receipts.
      return payments.filter((p) => p.reconciliationCategory === "OTHER" || 
        (p.voucherId == null && p.reconciliationCategory === "ACTIVE_RENT"));
    }
    return payments.filter((p) => p.reconciliationCategory === effectiveView);
  }, [payments, isPropertiesPayments, effectiveView]);

  const filtered = useMemo(() => {
    if (!search.trim()) return viewPayments;
    return viewPayments.filter((p) => searchAny(search, p.tenantName, p.unitNumber, p.locationGroup, p.notes, p.sourceModule));
  }, [viewPayments, search]);

  // Keep recorded billing allocations visible, but do NOT count them as cash.
  // All amounts come from the visible records and are accumulated in cents.
  const paymentTotals = receiptTotals(filtered);
  const isFullHistory = isHassanProperties && effectiveView === "ALL" && !search.trim();
  const reconciliationReady = isFullHistory && !isLoading && !paymentsError &&
    reconciliation?.companyId === selectedCompany?.id && !reconciliation.loading;
  const total = isPropertiesPayments
    ? paymentTotals.cash / 100
    : filtered.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const clipboardIsUsd = filtered.every((payment) => !payment.currency || payment.currency.toUpperCase() === "USD");
  const copyHistory = async () => {
    try {
      await navigator.clipboard.writeText(paymentHistoryTsv(filtered));
      toast({ title: "History copied", description: "Paste into Excel; cash receipts and non-cash adjustments have separate numeric columns and totals." });
    } catch {
      toast({ title: "Could not copy", description: "Please allow clipboard access and try again.", variant: "destructive" });
    }
  };
  const activeWarehouseRentPaid = warehouseUnits.reduce((s, u) => s + Number(u.totalPaid ?? 0), 0);
  const isActiveUnfiltered = isPropertiesPayments && effectiveView === "ACTIVE_RENT" && !search.trim();
  const discrepancy = isActiveUnfiltered && !warehouseTotalsLoading && !warehouseTotalsError
    && !isLoading && Math.abs(total - activeWarehouseRentPaid) > 0.009;
  const currentViewLabel = RECONCILIATION_VIEWS.find((v) => v.key === effectiveView)?.label ?? "Payments";

  return (
    <div
      className={isErp || appMode === "factory" ? "space-y-4 sm:p-4" : "p-4 space-y-4"}
      data-testid={`page-${testIdPrefix}-payments-log`}
    >
      {isErp ? (
        <>
          <PageHeader
            title={pageTitle}
            subtitle="All payment receipts recorded across all units, sorted by date."
            icon={pageIcon ?? <ClipboardList className="h-5 w-5" />}
          />
          <DataTableToolbar
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search tenant, unit, notes…"
            searchTestId={`input-${testIdPrefix}-payments-search`}
            className="mb-0"
          />
        </>
      ) : (
        <div className="flex items-center gap-3 flex-wrap justify-between">
          <div className="flex items-center gap-3">
            {pageIcon ?? <ClipboardList className="h-7 w-7 text-indigo-600" />}
            <div>
              <PageHeader
                title={pageTitle}
                subtitle="All payment receipts recorded across all units, sorted by date."
              />
            </div>
          </div>
          <DataTableToolbar
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search tenant, unit, notes…"
            searchTestId={`input-${testIdPrefix}-payments-search`}
            className="mb-0"
          />
        </div>
      )}

      {isPropertiesPayments && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Payment type">
          {RECONCILIATION_VIEWS.filter((view) => isHassanProperties || view.key !== "HISTORICAL_RENT").map((view) => {
            const count = view.key === "ALL"
              ? payments.length
              : view.key === "HISTORICAL_RENT"
                ? payments.filter(belongsToHistoricalRentSnapshot).length
                : view.key === "OTHER"
                  ? payments.filter((payment) => payment.reconciliationCategory === "OTHER" ||
                      (payment.voucherId == null && payment.reconciliationCategory === "ACTIVE_RENT")).length
                  : payments.filter((payment) => payment.reconciliationCategory === view.key).length;
            return (
              <Button
                key={view.key}
                size="sm"
                variant={effectiveView === view.key ? "default" : "outline"}
                onClick={() => setReconciliationView(view.key)}
                aria-pressed={effectiveView === view.key}
              >
                {view.label} ({count})
              </Button>
            );
          })}
        </div>
      )}

      {isHassanProperties && (
        <PaymentsReconciliation
          payments={payments}
          companyId={selectedCompany?.id}
          isLoading={isLoading}
          isError={paymentsError}
          onReconciliationChange={setReconciliation}
        />
      )}

      {isHassanProperties && effectiveView === "HISTORICAL_RENT" && (
        <p className="text-xs text-muted-foreground">
          Historical rent through {HISTORICAL_RENT_CUTOFF_LABEL}, including MORINA K's ended lease.
          Later receipts, guarantee releases and unvouchered adjustments are shown in their own views.
        </p>
      )}

      {isHassanProperties && effectiveView === "OTHER" && (
        <p className="text-xs text-muted-foreground">
          STE SIARSEGO's $800 billing transition adjustment has no payment voucher.
          It remains in the original records but is not counted as voucher-backed rent paid.
        </p>
      )}

      {isHassanProperties && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" disabled={isLoading || paymentsError || !filtered.length || !clipboardIsUsd} onClick={() => void copyHistory()} data-testid="button-properties-copy-payment-history">
            <Copy className="h-4 w-4 mr-1" /> Copy visible rows only
          </Button>
          {!clipboardIsUsd && <span className="text-xs text-amber-600">Non-USD entries need their booked currency conversion before export.</span>}
        </div>
      )}
      {paymentsError && (
        <div className="rounded-md border border-destructive p-3 text-sm text-destructive" role="alert">
          Could not retrieve the complete payment history. Totals are unavailable; no accounting data has been changed.
        </div>
      )}

      {/* Summary */}
      <div className={`grid grid-cols-1 ${isHassanProperties ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3"} gap-3`}>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">TOTAL PAYMENTS</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid={`stat-${testIdPrefix}-total-payments`}>
              {paymentsError ? "Unavailable" : filtered.length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">
              {isHassanProperties && effectiveView === "HISTORICAL_RENT"
                ? "RENT PAID THROUGH 26 OCT"
                : isFullHistory ? "HISTORY + ACCOUNT ADJUSTMENT"
                : isHassanProperties ? "CASH RECEIVED (VOUCHER-BACKED)" : "TOTAL AMOUNT RECEIVED"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className="text-2xl font-bold text-green-600 dark:text-green-400"
              data-testid={`stat-${testIdPrefix}-total-amount`}
            >
              {paymentsError ? "Unavailable" : isFullHistory
                ? reconciliationReady && reconciliation?.reconciled != null
                  ? formatMoneyNumber(reconciliation.reconciled / 100)
                  : "Verifying…"
                : formatMoneyNumber(total)}
            </div>
          </CardContent>
        </Card>
        {isHassanProperties && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground font-normal">NON-CASH ADJUSTMENTS</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-600 dark:text-amber-400" data-testid="stat-prop-rental-non-cash-adjustments">
                {paymentsError ? "Unavailable" : formatMoneyNumber(paymentTotals.nonCash / 100)}
              </div>
              <p className="text-xs text-muted-foreground">Shown in history, not added to cash</p>
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">UNIQUE TENANTS</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{paymentsError ? "Unavailable" : new Set(filtered.map((p) => p.tenantName).filter(Boolean)).size}</div>
          </CardContent>
        </Card>
      </div>

      {discrepancy && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300" role="status">
          Active rent entries total ${formatMoneyNumber(total)}, while Warehouse Total Paid is
          ${formatMoneyNumber(activeWarehouseRentPaid)}. Check cross-company payment ownership or timing.
          No amounts have been adjusted.
        </div>
      )}

      {/* Payments table */}
      <Card>
        <CardContent className="p-0">
          <div className="table-responsive">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading payments…</div>
            ) : paymentsError ? (
              <div className="p-8 text-center text-destructive">Payment history could not be loaded. Please retry.</div>
            ) : filtered.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                {payments.length === 0 ? "No payments recorded yet." : "No payments match the selected type or search."}
              </div>
            ) : (
              <table className="w-full text-sm" {...cardTableProps} data-testid={`table-${testIdPrefix}-payments`}>
                <thead className="sticky top-0 z-30 bg-muted border-b">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold">Date</th>
                    <th className="text-left px-3 py-2 font-semibold">Client Name</th>
                    <th className="text-left px-3 py-2 font-semibold">Unit</th>
                    <th className="text-right px-3 py-2 font-semibold">{isHassanProperties ? "Cash Received" : "Amount"}</th>
                    {isHassanProperties && <th className="text-right px-3 py-2 font-semibold">Non-cash Adjustment</th>}
                    <th className="text-left px-3 py-2 font-semibold">For Month</th>
                    <th className="text-left px-3 py-2 font-semibold">Notes</th>
                    <th className="text-left px-3 py-2 font-semibold">Daybook</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p, i) => (
                    <tr
                      key={p.id}
                      className={`border-t ${i % 2 === 1 ? "bg-muted/20" : ""}`}
                      data-testid={`row-payment-${p.id}`}
                    >
                      <td className="px-3 py-2 tabular-nums text-sm">
                        {format(new Date(p.paymentDate), "dd MMM yyyy")}
                      </td>
                      <td className="px-3 py-2 font-medium">{p.tenantName ?? "—"}</td>
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs">{p.unitNumber ?? "—"}</span>
                        {p.locationGroup && (
                          <Badge variant="outline" className="ml-1.5 text-xs">
                            {p.locationGroup}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-green-700 dark:text-green-400">
                        {!isHassanProperties ? (
                          <MoneyAmount amount={p.amount} currency={p.currency ?? "USD"} />
                        ) : cashCents(p) !== 0 ? (
                          <MoneyAmount amount={cashCents(p) / 100} currency={p.currency ?? "USD"} />
                        ) : "—"}
                      </td>
                      {isHassanProperties && (
                        <td className="px-3 py-2 text-right tabular-nums text-amber-600 dark:text-amber-400">
                          {nonCashCents(p) !== 0 ? <MoneyAmount amount={nonCashCents(p) / 100} currency={p.currency ?? "USD"} /> : "—"}
                        </td>
                      )}
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {MONTH_NAMES[p.forMonth]} {p.forYear}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {isPropertiesPayments && p.sourceModule === "ERP" && (
                          <Badge variant="outline" className="mr-2 text-[10px]">ERP source</Badge>
                        )}
                        {p.readOnly && (
                          <Badge variant="outline" className="mr-2 text-[10px]">Voucher-only guarantee receipt</Badge>
                        )}
                        {p.notes ?? ""}
                      </td>
                      <td className="px-3 py-2">
                        {p.voucherId ? (
                          <span className="text-xs text-muted-foreground font-mono">#{p.voucherId}</span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
                            title="No accounting entry — payment was recorded without a cash account"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            No entry
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {p.readOnly ? (
                          <span className="text-xs text-muted-foreground" title="Original posted guarantee voucher; no editable payment record exists.">Read-only</span>
                        ) : isPropertiesPayments && p.sourceModule !== "PROPERTIES" ? (
                          <span className="text-xs text-muted-foreground" title="Manage this payment from its original ERP rental module">
                            ERP source
                          </span>
                        ) : (
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setDeleteTarget(p)}
                            aria-label="Delete payment"
                            data-testid={`button-delete-payment-${p.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 z-20 border-t-2 bg-muted/30">
                  <tr>
                    <td className="px-3 py-2 font-semibold" colSpan={3}>
                      {isPropertiesPayments ? `TOTAL — ${currentViewLabel.toUpperCase()}` : "TOTAL"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-bold text-green-700 dark:text-green-400">
                      {formatMoneyNumber(total)}
                    </td>
                    {isHassanProperties && (
                      <td className="px-3 py-2 text-right tabular-nums font-bold text-amber-600 dark:text-amber-400">
                        {formatMoneyNumber(paymentTotals.nonCash / 100)}
                      </td>
                    )}
                    <td colSpan={4}></td>
                  </tr>
                  {isFullHistory && (
                    <>
                      <tr className="border-t">
                        <td colSpan={8} className="px-3 py-2 text-right">Recorded source history (cash + non-cash)</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums">{formatMoneyNumber(paymentTotals.recorded / 100)}</td>
                      </tr>
                      <tr>
                        <td colSpan={8} className="px-3 py-2 text-right">Net account classification adjustment (not a payment)</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums">
                          {reconciliationReady && reconciliation?.netAdjustment != null
                            ? formatMoneyNumber(reconciliation.netAdjustment / 100) : "Verifying…"}
                        </td>
                      </tr>
                      <tr className="border-t-2">
                        <td colSpan={8} className="px-3 py-2 text-right font-bold">RECONCILED HISTORY + ADJUSTMENT</td>
                        <td className="px-3 py-2 text-right font-bold tabular-nums" data-testid="properties-history-reconciled-footer">
                          {reconciliationReady && reconciliation?.reconciled != null
                            ? formatMoneyNumber(reconciliation.reconciled / 100) : "Verifying…"}
                        </td>
                      </tr>
                      <tr>
                        <td colSpan={8} className="px-3 py-2 text-right">Three-account balance sum</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums">
                          {reconciliationReady && reconciliation?.accountSum != null
                            ? formatMoneyNumber(reconciliation.accountSum / 100) : "Verifying…"}
                        </td>
                      </tr>
                      <tr>
                        <td colSpan={8} className="px-3 py-2 text-right">Unreconciled difference</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums" data-testid="properties-history-reconciliation-difference">
                          {reconciliationReady && reconciliation?.difference != null
                            ? formatMoneyNumber(reconciliation.difference / 100) : "Verifying…"}
                        </td>
                      </tr>
                    </>
                  )}
                </tfoot>
              </table>
            )}
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(isOpen) => {
          if (!isOpen) setDeleteTarget(null);
        }}
        title="Delete this payment?"
        tone="destructive"
        confirmText="Yes, Delete Payment"
        confirmButtonTestId="button-confirm-delete-payment"
        loading={deleteMutation.isPending}
        description={
          deleteTarget ? (
            <>
              This will permanently remove the{" "}
              <strong>
                <MoneyAmount amount={deleteTarget.amount} currency={deleteTarget.currency ?? "USD"} />
              </strong>{" "}
              payment from <strong>{deleteTarget.tenantName ?? "—"}</strong> ({MONTH_NAMES[deleteTarget.forMonth]}{" "}
              {deleteTarget.forYear}). The accounting entry will be reversed, and any inter-company transfer
              automatically created for this payment will be fully reversed in both companies. This cannot be undone.
            </>
          ) : undefined
        }
        onConfirm={async () => {
          if (deleteTarget) await deleteMutation.mutateAsync(deleteTarget.id);
        }}
      />
    </div>
  );
}
