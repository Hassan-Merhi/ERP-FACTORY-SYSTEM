import { searchAny } from "@shared/searchNormalization";
import { getRentalModulePolicy, type RentalModule } from "@/properties/config/rentalModulePolicy";
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
import { PropertiesPaymentsPremium, type PaymentsPeriod } from "./property-rental/components/PropertiesPaymentsPremium";
import "./property-rental/propertiesPaymentsPremium.css";
import {
  PaymentsReconciliation,
  type ReconciliationSnapshot,
} from "./property-rental/components/PaymentsReconciliation";
import {
  cashCents,
  nonCashCents,
  paymentHistoryTsv,
  reconciledHistoryTsv,
  receiptTotals,
} from "./property-rental/paymentsReceiptMath";
import { belongsToHistoricalRentSnapshot } from "./property-rental/historicalRentSnapshot";
import { hasHassanPropertiesHistoricalReportingPolicy } from "@/properties/config/historicalRentReportingPolicy";

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
export type PaymentRow = {
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
  rentalModule: RentalModule;
}

export default function RentalPaymentsLog({
  rentalModule,
  pageTitle,
  pageIcon,
  testIdPrefix,
}: Props) {
  const rentalPolicy = getRentalModulePolicy(rentalModule);
  const apiBase = rentalPolicy.apiBase;
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const appMode = useAppMode();
  // ERP and Properties share the page-header contract; Factory keeps its hub strip.
  const isErp = appMode === "erp" || appMode === "properties";
  // Phones restack the payments table as cards in every mode.
  const { tableProps: cardTableProps } = useMobileCardTable();
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState<PaymentsPeriod>("all");
  const [selectedUnit, setSelectedUnit] = useState("all");
  const [selectedTenant, setSelectedTenant] = useState("all");
  const [deleteTarget, setDeleteTarget] = useState<PaymentRow | null>(null);
  const [reconciliationView, setReconciliationView] = useState<ReconciliationView>("HISTORICAL_RENT");
  const [reconciliation, setReconciliation] = useState<ReconciliationSnapshot | null>(null);

  // Both pages use the same voucher-backed dated rent snapshot. No payment is created.
  const isPropertiesPayments = rentalPolicy.usesPropertiesReconciliation;
  const isHassanProperties = isPropertiesPayments && hasHassanPropertiesHistoricalReportingPolicy(selectedCompany);
  // In HASSAN PROPERTIES the only visible rental payment history is All Records.
  // Other company/module views retain their existing tabs.
  // Widened to the full view union: Properties payments now show only All
  // Records, so the "HISTORICAL_RENT" branches below are unreachable for now,
  // and without the widening TypeScript rejects them as impossible comparisons.
  const effectiveView = (
    rentalPolicy.paymentsAllRecordsOnly ? "ALL" : reconciliationView === "HISTORICAL_RENT" ? "ACTIVE_RENT" : reconciliationView
  ) as ReconciliationView;
  const queryKey = [
    apiBase + "/payments",
    { companyId: selectedCompany?.id, view: isPropertiesPayments ? "warehouse-reconciliation" : "default" },
  ];
  const {
    data: warehouseUnits = [],
    isLoading: warehouseTotalsLoading,
    isError: warehouseTotalsError,
  } = useQuery<Array<{ totalPaid?: number | null }>>({
    queryKey: [apiBase + "/units", { unitType: "WAREHOUSE", companyId: selectedCompany?.id }],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/units?unitType=WAREHOUSE`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load warehouse rent totals");
      return res.json();
    },
    enabled: !!selectedCompany && isPropertiesPayments,
  });

  const {
    data: payments = [],
    isLoading,
    isError: paymentsError,
  } = useQuery<PaymentRow[]>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`${apiBase}/payments${isPropertiesPayments ? "?view=warehouse-reconciliation" : ""}`, {
        credentials: "include",
      });
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
    if (effectiveView === "OTHER") {
      // Includes recorded unvouchered corrections, which are not cash receipts.
      return payments.filter(
        (p) =>
          p.reconciliationCategory === "OTHER" || (p.voucherId == null && p.reconciliationCategory === "ACTIVE_RENT")
      );
    }
    return payments.filter((p) => p.reconciliationCategory === effectiveView);
  }, [payments, isPropertiesPayments, effectiveView]);

  const unitOptions = useMemo(() => {
    const uniqueUnits = new Map<string, string>();
    payments.forEach((payment) => {
      if (payment.unitId != null && !uniqueUnits.has(String(payment.unitId))) {
        uniqueUnits.set(
          String(payment.unitId),
          [payment.unitNumber, payment.locationGroup].filter(Boolean).join(" — ") || `Unit ${payment.unitId}`
        );
      }
    });
    return [...uniqueUnits.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }, [payments]);

  const tenantOptions = useMemo(
    () =>
      [...new Set(payments.map((p) => p.tenantName).filter((name): name is string => Boolean(name)))]
        .sort((a, b) => a.localeCompare(b))
        .map((value) => ({ value, label: value })),
    [payments]
  );

  const filtered = useMemo(() => {
    const now = new Date();
    const since =
      period === "month"
        ? new Date(now.getFullYear(), now.getMonth(), 1)
        : period === "year"
          ? new Date(now.getFullYear(), 0, 1)
          : period === "30days"
            ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)
            : null;
    return viewPayments.filter((p) => {
      if (
        search.trim() &&
        !searchAny(
          search,
          p.tenantName,
          p.unitNumber,
          p.locationGroup,
          p.notes,
          p.sourceModule,
          String(p.voucherId ?? "")
        )
      )
        return false;
      if (isPropertiesPayments && selectedUnit !== "all" && String(p.unitId) !== selectedUnit) return false;
      if (isPropertiesPayments && selectedTenant !== "all" && p.tenantName !== selectedTenant) return false;
      if (isPropertiesPayments && since && new Date(p.paymentDate).getTime() < since.getTime()) return false;
      return true;
    });
  }, [viewPayments, search, period, selectedUnit, selectedTenant, isPropertiesPayments]);

  // Keep recorded billing allocations visible, but do NOT count them as cash.
  // All amounts come from the visible records and are accumulated in cents.
  const paymentTotals = receiptTotals(filtered);
  const noFilters = !search.trim() && period === "all" && selectedUnit === "all" && selectedTenant === "all";
  const isFullHistory = isHassanProperties && effectiveView === "ALL" && noFilters;
  const reconciliationReady =
    isFullHistory &&
    !isLoading &&
    !paymentsError &&
    reconciliation?.companyId === selectedCompany?.id &&
    !reconciliation.loading &&
    reconciliation.accountSum !== null &&
    reconciliation.aliCashLedgerId !== null;
  const total = isPropertiesPayments
    ? paymentTotals.cash / 100
    : filtered.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const clipboardIsUsd = filtered.every((payment) => !payment.currency || payment.currency.toUpperCase() === "USD");
  const copyHistory = async () => {
    try {
      await navigator.clipboard.writeText(paymentHistoryTsv(filtered));
      toast({
        title: "History copied",
        description:
          "Paste into Excel; cash receipts and non-cash adjustments have separate numeric columns and totals.",
      });
    } catch {
      toast({
        title: "Could not copy",
        description: "Please allow clipboard access and try again.",
        variant: "destructive",
      });
    }
  };
  const copyFullHistory = async () => {
    if (!reconciliationReady || reconciliation?.aliCashLedgerId == null || reconciliation.accountSum == null) return;
    try {
      await navigator.clipboard.writeText(
        reconciledHistoryTsv(payments, {
          aliCashLedgerId: reconciliation.aliCashLedgerId,
          cashboxLedgerId: reconciliation.cashboxLedgerId,
          threeAccountsTotal: reconciliation.accountSum,
        })
      );
      toast({
        title: "Full history copied",
        description: "Paste into Excel to see all recorded rows and the source-based account reconciliation.",
      });
    } catch {
      toast({
        title: "Could not copy",
        description: "Please allow clipboard access and try again.",
        variant: "destructive",
      });
    }
  };
  const activeWarehouseRentPaid = warehouseUnits.reduce((s, u) => s + Number(u.totalPaid ?? 0), 0);
  const isActiveUnfiltered = isPropertiesPayments && effectiveView === "ACTIVE_RENT" && !search.trim();
  const discrepancy =
    isActiveUnfiltered &&
    !warehouseTotalsLoading &&
    !warehouseTotalsError &&
    !isLoading &&
    Math.abs(total - activeWarehouseRentPaid) > 0.009;

  if (isPropertiesPayments) {
    const amountDisplay = paymentsError
      ? "Unavailable"
      : isFullHistory
        ? reconciliationReady && reconciliation?.reconciled != null
          ? formatMoneyNumber(reconciliation.reconciled / 100)
          : "Verifying…"
        : formatMoneyNumber(total);
    const copyIsFull = noFilters;
    const copyAllowed =
      !isLoading && !paymentsError && filtered.length > 0 && clipboardIsUsd && (!isFullHistory || reconciliationReady);
    return (
      <div className="space-y-4 sm:p-4" data-testid={`page-${testIdPrefix}-payments-log`}>
        {isHassanProperties && (
          <PaymentsReconciliation
            payments={payments}
            companyId={selectedCompany?.id}
            isLoading={isLoading}
            isError={paymentsError}
            onReconciliationChange={setReconciliation}
          />
        )}
        <PropertiesPaymentsPremium
          payments={filtered}
          totalRecords={payments.length}
          isLoading={isLoading}
          isError={paymentsError}
          search={search}
          onSearchChange={setSearch}
          period={period}
          onPeriodChange={setPeriod}
          selectedUnit={selectedUnit}
          onUnitChange={setSelectedUnit}
          selectedTenant={selectedTenant}
          onTenantChange={setSelectedTenant}
          unitOptions={unitOptions}
          tenantOptions={tenantOptions}
          totalAmount={amountDisplay}
          amountLabel={isHassanProperties && !isFullHistory ? "Cash Received" : "Total Amount Recorded"}
          canCopy={copyAllowed}
          fullHistory={copyIsFull}
          onCopy={() => {
            void (isFullHistory ? copyFullHistory() : copyHistory());
          }}
          onDelete={setDeleteTarget}
        />
        {!clipboardIsUsd && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Non-USD entries need their booked currency conversion before copying history.
          </p>
        )}
        <ConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
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
                {deleteTarget.forYear}). The accounting entry and any associated inter-company transfer will be reversed
                in their respective companies. This cannot be undone.
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

      {isHassanProperties && (
        <div className="text-sm font-medium text-muted-foreground" data-testid="properties-all-records-label">
          All Records ({payments.length})
        </div>
      )}
      {isPropertiesPayments && !isHassanProperties && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Payment type">
          {RECONCILIATION_VIEWS.filter((view) => isHassanProperties || view.key !== "HISTORICAL_RENT").map((view) => {
            const count =
              view.key === "ALL"
                ? payments.length
                : view.key === "HISTORICAL_RENT"
                  ? payments.filter(belongsToHistoricalRentSnapshot).length
                  : view.key === "OTHER"
                    ? payments.filter(
                        (payment) =>
                          payment.reconciliationCategory === "OTHER" ||
                          (payment.voucherId == null && payment.reconciliationCategory === "ACTIVE_RENT")
                      ).length
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

      {isHassanProperties && effectiveView === "OTHER" && (
        <p className="text-xs text-muted-foreground">
          STE SIARSEGO's $800 billing transition adjustment has no payment voucher. It remains in the original records
          but is not counted as voucher-backed rent paid.
        </p>
      )}

      {isHassanProperties && (
        <div className="flex flex-wrap justify-end gap-2">
          {isFullHistory ? (
            <Button
              size="sm"
              disabled={!reconciliationReady || !clipboardIsUsd}
              onClick={() => void copyFullHistory()}
              data-testid="button-properties-copy-reconciled-history"
            >
              <Copy className="h-4 w-4 mr-1" /> Copy full history
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={isLoading || paymentsError || !filtered.length || !clipboardIsUsd}
              onClick={() => void copyHistory()}
              data-testid="button-properties-copy-payment-history"
            >
              <Copy className="h-4 w-4 mr-1" /> Copy search results
            </Button>
          )}
          {!clipboardIsUsd && (
            <span className="text-xs text-amber-600">
              Non-USD entries need their booked currency conversion before export.
            </span>
          )}
        </div>
      )}
      {paymentsError && (
        <div className="rounded-md border border-destructive p-3 text-sm text-destructive" role="alert">
          Could not retrieve the complete payment history. Totals are unavailable; no accounting data has been changed.
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
              {isFullHistory
                ? "TOTAL AMOUNT RECORDED"
                : isHassanProperties
                  ? "CASH RECEIVED (VOUCHER-BACKED)"
                  : "TOTAL AMOUNT RECEIVED"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className="text-2xl font-bold text-green-600 dark:text-green-400"
              data-testid={`stat-${testIdPrefix}-total-amount`}
            >
              {paymentsError
                ? "Unavailable"
                : isFullHistory
                  ? reconciliationReady && reconciliation?.reconciled != null
                    ? formatMoneyNumber(reconciliation.reconciled / 100)
                    : "Verifying…"
                  : formatMoneyNumber(total)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">UNIQUE TENANTS</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {paymentsError ? "Unavailable" : new Set(filtered.map((p) => p.tenantName).filter(Boolean)).size}
            </div>
          </CardContent>
        </Card>
      </div>

      {discrepancy && (
        <div
          className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"
          role="status"
        >
          Active rent entries total ${formatMoneyNumber(total)}, while Warehouse Total Paid is $
          {formatMoneyNumber(activeWarehouseRentPaid)}. Check cross-company payment ownership or timing. No amounts have
          been adjusted.
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
                    <th className="text-right px-3 py-2 font-semibold">
                      {isHassanProperties ? "Cash Received" : "Amount"}
                    </th>
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
                        ) : (
                          "—"
                        )}
                      </td>
                      {isHassanProperties && (
                        <td className="px-3 py-2 text-right tabular-nums text-amber-600 dark:text-amber-400">
                          {nonCashCents(p) !== 0 ? (
                            <MoneyAmount amount={nonCashCents(p) / 100} currency={p.currency ?? "USD"} />
                          ) : (
                            "—"
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {MONTH_NAMES[p.forMonth]} {p.forYear}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {isPropertiesPayments && p.sourceModule === "ERP" && (
                          <Badge variant="outline" className="mr-2 text-[10px]">
                            ERP source
                          </Badge>
                        )}
                        {p.readOnly && (
                          <Badge variant="outline" className="mr-2 text-[10px]">
                            Voucher-only guarantee receipt
                          </Badge>
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
                          <span
                            className="text-xs text-muted-foreground"
                            title="Original posted guarantee voucher; no editable payment record exists."
                          >
                            Read-only
                          </span>
                        ) : isPropertiesPayments && p.sourceModule !== "PROPERTIES" ? (
                          <span
                            className="text-xs text-muted-foreground"
                            title="Manage this payment from its original ERP rental module"
                          >
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
                    <td className="px-3 py-2 font-bold" colSpan={3}>
                      TOTAL
                    </td>
                    <td
                      className="px-3 py-2 text-right tabular-nums font-bold text-green-700 dark:text-green-400"
                      data-testid="properties-history-reconciled-footer"
                    >
                      {isFullHistory
                        ? reconciliationReady && reconciliation?.reconciled != null
                          ? formatMoneyNumber(reconciliation.reconciled / 100)
                          : "Verifying…"
                        : formatMoneyNumber(total)}
                    </td>
                    <td colSpan={isHassanProperties ? 5 : 4}></td>
                  </tr>
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
