import { getRentalModulePolicy, type RentalModule } from "@/properties/config/rentalModulePolicy";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { DataTableToolbar } from "@/components/DataTableToolbar";
import { MoneyAmount } from "@/components/MoneyAmount";
import { formatMoneyNumber, formatMoneyDisplay } from "@/lib/moneyDisplay";
import { hasSingleUsdBasis, rentalReportingFigure } from "@/properties/config/rentalReportingPresentation";
import { useAppMode } from "@/contexts/AppModeContext";
import { useMobileCardTable } from "@/components/ui/mobile-card-table";
import { AlertTriangle, ClipboardList, Trash2 } from "lucide-react";
import { rentalPaymentDateLabel, mayOfferRentalPaymentDelete } from "@/properties/config/rentalPaymentPresentation";
import { PropertiesPaymentsPremium } from "./property-rental/components/PropertiesPaymentsPremium";
import { RentalPaymentDeleteDialog } from "./property-rental/components/RentalPaymentDeleteDialog";
import "./property-rental/propertiesPaymentsPremium.css";
import {
  PaymentsReconciliation,
  type ReconciliationSnapshot,
} from "./property-rental/components/PaymentsReconciliation";
import {
  paymentHistoryTsv,
  reconciledHistoryTsv,
  receiptTotals,
} from "./property-rental/paymentsReceiptMath";
import { hasHassanPropertiesHistoricalReportingPolicy } from "@/properties/config/historicalRentReportingPolicy";
import { useRentalPayments, rentalPaymentsQueryKey } from "@/properties/hooks/useRentalPayments";
import { useRentalPaymentsFilters } from "@/properties/hooks/useRentalPaymentsFilters";

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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
  const [deleteTarget, setDeleteTarget] = useState<PaymentRow | null>(null);
  const [reconciliation, setReconciliation] = useState<ReconciliationSnapshot | null>(null);

  // Both pages use the same voucher-backed dated rent snapshot. No payment is created.
  const isPropertiesPayments = rentalPolicy.usesPropertiesReconciliation;
  const isHassanProperties = isPropertiesPayments && hasHassanPropertiesHistoricalReportingPolicy(selectedCompany);
  const queryKey = rentalPaymentsQueryKey(apiBase, selectedCompany?.id, isPropertiesPayments);
  const { data: payments = [], isLoading, isError: paymentsError } = useRentalPayments(
    apiBase, selectedCompany?.id, isPropertiesPayments,
  );
  const {
    search, setSearch, period, setPeriod, selectedUnit, setSelectedUnit,
    selectedTenant, setSelectedTenant,
    unitOptions, tenantOptions, filtered, noFilters,
  } = useRentalPaymentsFilters(payments, isPropertiesPayments, selectedCompany?.id);

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

  // Keep recorded billing allocations visible, but do NOT count them as cash.
  // All amounts come from the visible records and are accumulated in cents.
  const paymentTotals = receiptTotals(filtered);
  const isFullHistory = isHassanProperties && noFilters;
  const reconciliationReady =
    isFullHistory &&
    !isLoading &&
    !paymentsError &&
    reconciliation?.companyId === selectedCompany?.id &&
    reconciliation?.loading === false &&
    reconciliation?.accountSum != null &&
    reconciliation?.aliCashLedgerId != null;
  const total = isPropertiesPayments
    ? paymentTotals.cash / 100
    : filtered.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const clipboardIsUsd = hasSingleUsdBasis(filtered);
  const fullHistoryIsUsd = hasSingleUsdBasis(payments);
  const displayedFigure = rentalReportingFigure(
    clipboardIsUsd ? total : null,
    "posted-cash",
  );
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
    if (!reconciliationReady || !fullHistoryIsUsd || reconciliation?.aliCashLedgerId == null || reconciliation.accountSum == null) return;
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

  if (isPropertiesPayments) {
    const amountDisplay = paymentsError
      ? "Unavailable"
      : !clipboardIsUsd
        ? "Mixed or unverified currencies — see entries"
        : isFullHistory
          ? reconciliationReady && fullHistoryIsUsd && reconciliation?.reconciled != null
            ? formatMoneyDisplay(reconciliation.reconciled / 100, { currency: "USD" })
            : "Verifying…"
          : formatMoneyDisplay(displayedFigure.amount, { currency: displayedFigure.currency });
    // Full-history export is available only to the verified historical reporting company.
    const copyIsFull = isFullHistory;
    const copyAllowed =
      !isLoading && !paymentsError && filtered.length > 0 && clipboardIsUsd && (!isFullHistory || (reconciliationReady && fullHistoryIsUsd));
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
          amountLabel={isFullHistory ? "Reconciled account balances (USD)" : "Voucher-backed cash received (USD)"}
          canCopy={copyAllowed}
          fullHistory={copyIsFull}
          onCopy={() => {
            void (isFullHistory ? copyFullHistory() : copyHistory());
          }}
          onDelete={setDeleteTarget}
        />
        {!clipboardIsUsd && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Payments contain non-USD or unverified currencies. No unconverted combined USD total is shown; USD copy/export requires verified currency evidence.
          </p>
        )}
        <RentalPaymentDeleteDialog
          payment={deleteTarget}
          module={rentalModule}
          pending={deleteMutation.isPending}
          onClose={() => setDeleteTarget(null)}
          onConfirm={(id) => deleteMutation.mutateAsync(id)}
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
              TOTAL AMOUNT RECEIVED
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className="text-2xl font-bold text-green-600 dark:text-green-400"
              data-testid={`stat-${testIdPrefix}-total-amount`}
            >
              {paymentsError ? "Unavailable" : formatMoneyNumber(total)}
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
                {payments.length === 0 ? "No payments recorded yet." : "No payments match the search."}
              </div>
            ) : (
              <table className="w-full text-sm" {...cardTableProps} data-testid={`table-${testIdPrefix}-payments`}>
                <thead className="sticky top-0 z-30 bg-muted border-b">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold">Date</th>
                    <th className="text-left px-3 py-2 font-semibold">Client Name</th>
                    <th className="text-left px-3 py-2 font-semibold">Unit</th>
                    <th className="text-right px-3 py-2 font-semibold">
                      Amount
                    </th>
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
                        {rentalPaymentDateLabel(p.paymentDate)}
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
                        {p.currency?.trim() ? <MoneyAmount amount={p.amount} currency={p.currency} /> : <span title="Recorded currency not verified">{p.amount} (currency unverified)</span>}
                      </td>

                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {MONTH_NAMES[p.forMonth]} {p.forYear}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
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
                        {!mayOfferRentalPaymentDelete(p.sourceModule, p.readOnly, rentalModule) ? (
                          <span
                            className="text-xs text-muted-foreground"
                            title="Original posted guarantee voucher; no editable payment record exists."
                          >
                            Read-only
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
                      data-testid={`footer-${testIdPrefix}-total-amount`}
                    >
                      {formatMoneyNumber(total)}
                    </td>
                    <td colSpan={4}></td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </CardContent>
      </Card>

      <RentalPaymentDeleteDialog
        payment={deleteTarget}
        module={rentalModule}
        pending={deleteMutation.isPending}
        onClose={() => setDeleteTarget(null)}
        onConfirm={(id) => deleteMutation.mutateAsync(id)}
      />
    </div>
  );
}
