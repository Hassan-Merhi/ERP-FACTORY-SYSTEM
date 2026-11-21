import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";
import { DataTableToolbar } from "@/components/DataTableToolbar";
import { MoneyAmount } from "@/components/MoneyAmount";
import { formatMoneyNumber, formatMoneyDisplay } from "@/lib/moneyDisplay";
import { AlertTriangle, Trash2 } from "lucide-react";
import { rentalPaymentDateLabel, mayOfferRentalPaymentDelete } from "@/properties/config/rentalPaymentPresentation";
import { PropertiesPaymentsPremium } from "./property-rental/components/PropertiesPaymentsPremium";
import { RentalPaymentDeleteDialog } from "./property-rental/components/RentalPaymentDeleteDialog";
import "./property-rental/propertiesPaymentsPremium.css";
import { PaymentsReconciliation } from "./property-rental/components/PaymentsReconciliation";
import { MONTH_NAMES, type Props } from "./RentalPaymentsLogModel";
import { useRentalPaymentsLogState } from "./useRentalPaymentsLogState";
export type { PaymentRow } from "./RentalPaymentsLogModel";

export default function RentalPaymentsLog({ rentalModule, testIdPrefix }: Props) {
  const {
    selectedCompany,
    recordChanges,
    cardTableProps,
    setDeleteTarget,
    deleteTarget,
    reconciliation,
    setReconciliation,
    isPropertiesPayments,
    isHassanProperties,
    paymentsError,
    payments,
    isLoading,
    filtered,
    search,
    setSearch,
    period,
    setPeriod,
    selectedUnit,
    setSelectedUnit,
    selectedTenant,
    setSelectedTenant,
    unitOptions,
    tenantOptions,
    deleteMutation,
    isFullHistory,
    reconciliationReady,
    total,
    clipboardIsUsd,
    fullHistoryIsUsd,
    displayedFigure,
    SectionIcon,
    header,
  } = useRentalPaymentsLogState({ rentalModule, testIdPrefix });

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
    return (
      <div className="space-y-4" data-testid={`page-${testIdPrefix}-payments-log`}>
        {header}
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
          onDelete={recordChanges.allowed ? setDeleteTarget : undefined}
        />
        {!clipboardIsUsd && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Payments contain non-USD or unverified currencies. No unconverted combined USD total is shown; USD
            copy/export requires verified currency evidence.
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
    <div className="space-y-4" data-testid={`page-${testIdPrefix}-payments-log`}>
      {header}
      <DataTableToolbar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search tenant, unit, notes…"
        searchTestId={`input-${testIdPrefix}-payments-search`}
        className="mb-0"
      />

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
            <CardTitle className="text-xs text-muted-foreground font-normal">TOTAL AMOUNT RECEIVED</CardTitle>
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
              <LoadingState title="Loading payments…" />
            ) : paymentsError ? (
              <ErrorState title="Payment history could not be loaded. Please retry." />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={SectionIcon}
                title={payments.length === 0 ? "No payments recorded yet." : "No payments match the search."}
              />
            ) : (
              <table className="w-full text-sm" {...cardTableProps} data-testid={`table-${testIdPrefix}-payments`}>
                <thead className="sticky top-0 z-30 bg-muted border-b">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold">Date</th>
                    <th className="text-left px-3 py-2 font-semibold">Client Name</th>
                    <th className="text-left px-3 py-2 font-semibold">Unit</th>
                    <th className="text-right px-3 py-2 font-semibold">Amount</th>
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
                      <td className="px-3 py-2 tabular-nums text-sm">{rentalPaymentDateLabel(p.paymentDate)}</td>
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
                        {p.currency?.trim() ? (
                          <MoneyAmount amount={p.amount} currency={p.currency} />
                        ) : (
                          <span title="Recorded currency not verified">{p.amount} (currency unverified)</span>
                        )}
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
                        ) : !recordChanges.allowed ? null : (
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
