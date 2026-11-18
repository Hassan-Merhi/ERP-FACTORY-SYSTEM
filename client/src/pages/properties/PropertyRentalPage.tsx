import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Building2, Store, Boxes, Coins, ShieldCheck, Layers, Wallet, UsersRound } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import "./property-rental/propertiesRentalsPremium.css";

import type { Props } from "./property-rental/types";
import { ApiBaseCtx } from "./property-rental/shared";
import { CreateUnitDialog } from "./property-rental/components/CreateUnitDialog";
import { UnitActionDialog } from "./property-rental/components/UnitActionDialog";
import { BulkPaymentDialog } from "./property-rental/components/BulkPaymentDialog";
import { RentalUnitCards } from "./property-rental/components/RentalUnitCards";
import { ErpMobileSummaryGrid } from "@/components/ui/erp-mobile-records";
import { PaymentsReconciliation } from "./property-rental/components/PaymentsReconciliation";
import { usePropertyRentalPageModel } from "./PropertyRentalPageModel";
import { PropertyRentalUnitsTable } from "./PropertyRentalUnitsTable";

export default function PropertyRentalPage(props: Props) {
  const m = usePropertyRentalPageModel(props);

  return (
    <ApiBaseCtx.Provider value={m.apiBase}>
      <div
        className={
          m.isPropertiesRental ? "properties-rentals-premium space-y-5" : m.isErp ? "space-y-4 sm:p-4" : "p-4 space-y-4"
        }
        data-testid={`page-${m.testIdPrefix}`}
      >
        {m.showHistoricalPaid && (
          <PaymentsReconciliation
            payments={m.historicalPayments}
            companyId={m.selectedCompany?.id}
            isLoading={m.historicalLoading}
            isError={m.historicalError}
            onReconciliationChange={m.setHistoryReconciliation}
          />
        )}
        {m.isPropertiesRental ? (
          // The Properties module keeps its hero design (docs/properties-unification-*.md) but
          // renders the same title, subtitle and actions as the shared PageHeader below.
          <section
            className="properties-rentals-hero"
            aria-label={m.unitType === "SHOP" ? "Shop rentals overview" : "Warehouse rentals overview"}
          >
            <div className="properties-rentals-hero-copy">
              <span className="properties-rentals-hero-icon" aria-hidden="true">
                {m.unitType === "SHOP" ? <Store className="h-7 w-7" /> : <Building2 className="h-7 w-7" />}
              </span>
              <div className="properties-rentals-hero-text">
                <span className="properties-rentals-eyebrow">PROPERTIES</span>
                <h1 className="properties-rentals-heading" data-testid="text-page-title">
                  {m.headerTitle}
                </h1>
                <p className="properties-rentals-subheading" data-testid="text-page-subtitle">
                  {m.headerSubtitle}
                </p>
              </div>
            </div>
            <div className="properties-rentals-hero-actions">{m.headerActionsForWidth}</div>
          </section>
        ) : (
          <PageHeader title={m.headerTitle} subtitle={m.headerSubtitle} icon={m.pageIcon}>
            {m.headerActionsForWidth}
          </PageHeader>
        )}

        {m.isPropertiesRental && m.units.some((unit) => unit.isInternalLeaseProjection) && (
          <p className="text-xs text-muted-foreground" data-testid="properties-factory-internal-lease-note">
            Internal ERP/Factory leases appear for reference only. They are excluded from Properties rent and balance
            totals; manage payments and accounting from the originating rental module.
          </p>
        )}
        {!m.contractTotalsAreUsd && (
          <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
            Contract currencies are not all verified as USD. Contract-based overview totals are withheld rather than
            silently reported in USD. Individual contracts and ledger balances remain unchanged.
          </p>
        )}
        {m.currentRole === "Developer" && m.showHistoricalPaid && m.reconciledAccountTotalsReady && (
          <p className="text-xs text-muted-foreground" data-testid="properties-rent-account-balance-explanation">
            Combined account balances:{" "}
            <span className="font-semibold tabular-nums">
              {m.ledgerUsdMoney(m.historyReconciliation!.accountSum! / 100)}
            </span>{" "}
            (historical rent withdrawal through 26 Oct 2026; current ALI cash, Properties cashbox if present, and tenant
            deposits). These are account balances, not unique rent receipts.
            {m.historyReconciliation!.guaranteeCashOverlap != null &&
              m.historyReconciliation!.guaranteeCashOverlap > 0 && (
                <>
                  {" "}
                  Guarantee cash of {m.ledgerUsdMoney(m.historyReconciliation!.guaranteeCashOverlap / 100)} appears in
                  both a cash account and the deposit liability; these are not unique receipts.
                </>
              )}
            {(m.historicalAccountMismatch || m.guaranteeLedgerMismatch) && (
              <span className="block text-amber-600 dark:text-amber-400" role="status">
                {m.historicalAccountMismatch && " Payments history does not reconcile to the account balances."}
                {m.guaranteeLedgerMismatch && " Unit guarantee balances differ from the Tenant Deposits ledger."} No
                accounting entries have been changed.
              </span>
            )}
          </p>
        )}
        {m.phoneCards ? (
          <ErpMobileSummaryGrid
            className={m.isPropertiesRental ? "properties-rentals-mobile-stats" : undefined}
            data-testid={`summary-${m.testIdPrefix}`}
            items={[
              { label: "TOTAL UNITS", value: m.units.length },
              {
                label: "RENT / MONTH",
                value: `${m.summaryMoney(m.totals.totalMonthlyRent)}`,
                valueClassName: "text-blue-600 dark:text-blue-400",
              },
              {
                label: m.isPropertiesRental ? "TO COLLECT" : "OUTSTANDING",
                value: `${m.summaryMoney(m.totals.totalOwed)}`,
                valueClassName: m.isPropertiesRental
                  ? "text-green-600 dark:text-green-400"
                  : "text-red-600 dark:text-red-400",
              },
              {
                label: m.isPropertiesRental ? "OWED TO TENANTS" : "CREDIT",
                value: `${m.summaryMoney(m.totals.totalCredit)}`,
                valueClassName: m.isPropertiesRental
                  ? "text-red-600 dark:text-red-400"
                  : "text-green-600 dark:text-green-400",
              },
              {
                label: m.isPropertiesRental ? "GUARANTEE HELD" : "TOTAL GUARANTEE",
                value: m.guaranteeValue,
                valueClassName: m.isPropertiesRental ? "text-red-600 dark:text-red-400" : undefined,
              },
              { label: m.usesRentExpensePaidBasis ? "TOTAL PAID · LEDGER BASIS" : m.paidLabel, value: m.paidValue },
            ]}
          />
        ) : (
          /* Summary tiles: six equal tiles; the former Outstanding/Credit pair overflowed its card at
             tablet widths. */
          <div
            className={
              m.isPropertiesRental
                ? "properties-rentals-kpis grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6"
                : "grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2"
            }
          >
            <Card
              className={m.isPropertiesRental ? "properties-rentals-stat properties-rentals-stat--units" : undefined}
            >
              <CardHeader className="px-3 pt-3 pb-1">
                {m.isPropertiesRental && (
                  <span className="properties-rentals-stat-icon" aria-hidden="true">
                    <Boxes className="h-[19px] w-[19px]" />
                  </span>
                )}
                <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">
                  TOTAL UNITS
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3">
                <div className="text-lg font-bold" data-testid={`stat-${m.testIdPrefix}-total-units`}>
                  {m.units.length}
                </div>
              </CardContent>
            </Card>
            <Card
              className={m.isPropertiesRental ? "properties-rentals-stat properties-rentals-stat--rent" : undefined}
            >
              <CardHeader className="px-3 pt-3 pb-1">
                {m.isPropertiesRental && (
                  <span className="properties-rentals-stat-icon" aria-hidden="true">
                    <Coins className="h-[19px] w-[19px]" />
                  </span>
                )}
                <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">
                  RENT / MONTH
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3">
                <div
                  className="text-lg font-bold text-blue-600 dark:text-blue-400"
                  data-testid={`stat-${m.testIdPrefix}-monthly-rent`}
                >
                  {m.summaryMoney(m.totals.totalMonthlyRent)}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">expected from active leases</p>
              </CardContent>
            </Card>
            <Card
              className={
                m.isPropertiesRental ? "properties-rentals-stat properties-rentals-stat--guarantee" : undefined
              }
            >
              <CardHeader className="px-3 pt-3 pb-1">
                {m.isPropertiesRental && (
                  <span className="properties-rentals-stat-icon" aria-hidden="true">
                    <ShieldCheck className="h-[19px] w-[19px]" />
                  </span>
                )}
                <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">
                  {m.isPropertiesRental ? "GUARANTEE HELD" : "TOTAL GUARANTEE"}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3">
                <div
                  className={`text-lg font-bold ${m.isPropertiesRental ? "text-red-600 dark:text-red-400" : ""}`}
                  data-testid={`stat-${m.testIdPrefix}-total-guarantee`}
                >
                  {m.guaranteeValue}
                </div>
              </CardContent>
            </Card>
            <Card
              className={m.isPropertiesRental ? "properties-rentals-stat properties-rentals-stat--paid" : undefined}
            >
              <CardHeader className="px-3 pt-3 pb-1">
                {m.isPropertiesRental && (
                  <span className="properties-rentals-stat-icon" aria-hidden="true">
                    <Layers className="h-[19px] w-[19px]" />
                  </span>
                )}
                <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">
                  {m.paidLabel}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3">
                <div
                  className={`text-lg font-bold ${m.summaryPaid > 0 ? "text-green-600 dark:text-green-400" : ""}`}
                  data-testid={`stat-${m.testIdPrefix}-total-paid`}
                >
                  {m.paidValue}
                </div>
                {m.usesRentExpensePaidBasis && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Recognized rent · ledger basis, including accruals
                  </p>
                )}
              </CardContent>
            </Card>
            <Card
              className={m.isPropertiesRental ? "properties-rentals-stat properties-rentals-stat--collect" : undefined}
            >
              <CardHeader className="px-3 pt-3 pb-1">
                {m.isPropertiesRental && (
                  <span className="properties-rentals-stat-icon" aria-hidden="true">
                    <Wallet className="h-[19px] w-[19px]" />
                  </span>
                )}
                <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">
                  {m.isPropertiesRental ? "TO COLLECT" : "OUTSTANDING"}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3">
                <div
                  className={`text-lg font-bold ${m.isPropertiesRental ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                  data-testid={`stat-${m.testIdPrefix}-total-outstanding`}
                >
                  {m.summaryMoney(m.totals.totalOwed)}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {m.isPropertiesRental ? "tenants owe you" : "owed by tenants"}
                </p>
              </CardContent>
            </Card>
            <Card
              className={m.isPropertiesRental ? "properties-rentals-stat properties-rentals-stat--owed" : undefined}
            >
              <CardHeader className="px-3 pt-3 pb-1">
                {m.isPropertiesRental && (
                  <span className="properties-rentals-stat-icon" aria-hidden="true">
                    <UsersRound className="h-[19px] w-[19px]" />
                  </span>
                )}
                <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">
                  {m.isPropertiesRental ? "OWED TO TENANTS" : "CREDIT"}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3">
                <div
                  className={`text-lg font-bold ${m.isPropertiesRental ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
                  data-testid={`stat-${m.testIdPrefix}-total-credit`}
                >
                  {m.summaryMoney(m.totals.totalCredit)}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {m.isPropertiesRental ? "tenant prepayments / overpayments" : "advance / overpaid"}
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {m.phoneCards ? (
          m.isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading units…</div>
          ) : m.grouped.length === 0 ? (
            <div className="rounded-lg border p-8 text-center text-muted-foreground">
              {m.unitType === "WAREHOUSE"
                ? "No warehouses yet. Add your first unit above."
                : "No shops yet. Add your first unit above."}
            </div>
          ) : (
            <RentalUnitCards
              landlordView={m.isPropertiesRental}
              grouped={m.grouped}
              selectedContractIds={m.selectedContractIds}
              onToggleSelect={(contractId) =>
                m.toggleSelect(contractId, { stopPropagation: () => {} } as React.MouseEvent<Element, MouseEvent>)
              }
              onOpenUnit={m.setOpenUnitId}
              onDeleteUnit={m.setConfirmDeleteUnitId}
              onRenameGroup={m.isPropertiesRental ? m.openRenameGroup : undefined}
              canRenameGroup={(groupUnits) => !!m.editableUnitInGroup(groupUnits)}
            />
          )
        ) : (
          /* Main table */
          <PropertyRentalUnitsTable m={m} />
        )}

        {m.bulkPayOpen && m.selectedUnits.length > 0 && (
          <BulkPaymentDialog
            units={m.selectedUnits}
            cashAccounts={m.cashAccounts}
            testIdPrefix={m.testIdPrefix}
            onClose={() => m.setBulkPayOpen(false)}
            onSuccess={() => m.setSelectedContractIds(new Set())}
          />
        )}

        {m.openUnit && (
          <UnitActionDialog
            unit={m.openUnit}
            cashAccounts={m.cashAccounts}
            onClose={() => m.setOpenUnitId(null)}
            unitType={m.unitType}
            testIdPrefix={m.testIdPrefix}
          />
        )}

        {m.createUnitOpen && (
          <CreateUnitDialog
            unitType={m.unitType}
            onClose={() => m.setCreateUnitOpen(false)}
            testIdPrefix={m.testIdPrefix}
          />
        )}

        {m.renameGroup && (
          <Dialog open onOpenChange={(open) => !open && !m.renameLocationGroup.isPending && m.setRenameGroup(null)}>
            <DialogContent data-testid={`dialog-${m.testIdPrefix}-rename-group`}>
              <DialogHeader>
                <DialogTitle>Rename location group</DialogTitle>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="rename-rental-location-group">Group name</Label>
                <Input
                  id="rename-rental-location-group"
                  value={m.newGroupName}
                  maxLength={120}
                  onChange={(e) => m.setNewGroupName(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      m.newGroupName.trim() &&
                      m.newGroupName.trim().toUpperCase() !== m.renameGroup.name.toUpperCase() &&
                      !m.renameLocationGroup.isPending
                    ) {
                      m.renameLocationGroup.mutate({
                        unitId: m.renameGroup.unitId,
                        locationGroup: m.newGroupName.trim(),
                      });
                    }
                  }}
                  data-testid={`input-${m.testIdPrefix}-rename-group`}
                />
                <p className="text-xs text-muted-foreground">
                  Renames this location for all its warehouses or shops in this company. Contracts, payments, and
                  accounting records are unchanged.
                </p>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => m.setRenameGroup(null)}
                  disabled={m.renameLocationGroup.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() =>
                    m.renameLocationGroup.mutate({ unitId: m.renameGroup.unitId, locationGroup: m.newGroupName.trim() })
                  }
                  disabled={
                    !m.newGroupName.trim() ||
                    m.newGroupName.trim().toUpperCase() === m.renameGroup.name.toUpperCase() ||
                    m.renameLocationGroup.isPending
                  }
                  data-testid={`button-${m.testIdPrefix}-save-group`}
                >
                  {m.renameLocationGroup.isPending ? "Saving…" : `Rename ${m.renameGroup.count} units`}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {/* Confirm delete unit dialog */}
        {m.confirmDeleteUnit && (
          <Dialog open onOpenChange={(o) => !o && m.setConfirmDeleteUnitId(null)}>
            <DialogContent data-testid={`dialog-${m.testIdPrefix}-confirm-delete`}>
              <DialogHeader>
                <DialogTitle>Delete Unit {m.confirmDeleteUnit.unitNumber}?</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                This will permanently remove unit{" "}
                <span className="font-semibold text-foreground">{m.confirmDeleteUnit.unitNumber}</span> from the list.
                {m.confirmDeleteUnit.contract ? (
                  <span className="block mt-1 text-destructive font-medium">
                    This unit has an active contract — end it first before deleting.
                  </span>
                ) : (
                  <span className="block mt-1">The unit is currently vacant and can be safely deleted.</span>
                )}
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => m.setConfirmDeleteUnitId(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => m.deleteUnit.mutate(m.confirmDeleteUnit.id)}
                  disabled={m.deleteUnit.isPending || !!m.confirmDeleteUnit.contract}
                  data-testid={`button-${m.testIdPrefix}-confirm-delete-submit`}
                >
                  {m.deleteUnit.isPending ? "Deleting…" : "Delete Unit"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </ApiBaseCtx.Provider>
  );
}
