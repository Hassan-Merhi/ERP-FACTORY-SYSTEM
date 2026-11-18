import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Boxes, Coins, ShieldCheck, Layers, Wallet, UsersRound } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState, LoadingState } from "@/components/ui/page-state";
import { RENTAL_SECTION_DEFINITIONS, rentalUnitSection } from "@/properties/config/rentalSections";
import "./property-rental/propertiesRentalsPremium.css";

import type { Props } from "./property-rental/types";
import { ApiBaseCtx } from "./property-rental/shared";
import { CreateUnitDialog } from "./property-rental/components/CreateUnitDialog";
import { UnitActionDialog } from "./property-rental/components/UnitActionDialog";
import { BulkPaymentDialog } from "./property-rental/components/BulkPaymentDialog";
import { RentalUnitCards } from "./property-rental/components/RentalUnitCards";
import { ErpMobileSummaryGrid } from "@/components/ui/erp-mobile-records";
import { PaymentsReconciliation } from "./property-rental/components/PaymentsReconciliation";
import { usePropertyRentalPageState } from "./usePropertyRentalPageState";
import { PropertyRentalUnitsTable } from "./PropertyRentalUnitsTable";

export default function PropertyRentalPage(props: Props) {
  const m = usePropertyRentalPageState(props);
  const {
    unitType,
    apiBase,
    isPropertiesRental,
    testIdPrefix,
    showHistoricalPaid,
    historicalPayments,
    selectedCompany,
    historicalLoading,
    historicalError,
    setHistoryReconciliation,
    headerSubtitle,
    headerActionsForWidth,
    units,
    contractTotalsAreUsd,
    currentRole,
    reconciledAccountTotalsReady,
    ledgerUsdMoney,
    historyReconciliation,
    historicalAccountMismatch,
    guaranteeLedgerMismatch,
    phoneCards,
    summaryMoney,
    totals,
    guaranteeValue,
    usesRentExpensePaidBasis,
    paidLabel,
    paidValue,
    summaryPaid,
    isLoading,
    grouped,
    selectedContractIds,
    toggleSelect,
    setOpenUnitId,
    setConfirmDeleteUnitId,
    openRenameGroup,
    editableUnitInGroup,
    bulkPayOpen,
    selectedUnits,
    cashAccounts,
    setBulkPayOpen,
    setSelectedContractIds,
    openUnit,
    createUnitOpen,
    setCreateUnitOpen,
    renameGroup,
    renameLocationGroup,
    setRenameGroup,
    newGroupName,
    setNewGroupName,
    confirmDeleteUnit,
    deleteUnit,
  } = m;

  // One header for every module; the title and icon come from the shared rental sections.
  const section = RENTAL_SECTION_DEFINITIONS[rentalUnitSection(unitType)];
  const SectionIcon = section.icon;
  const unitsLoadingState = <LoadingState title="Loading units…" />;
  const unitsEmptyState = (
    <EmptyState
      icon={SectionIcon}
      title={
        unitType === "WAREHOUSE"
          ? "No warehouses yet. Add your first unit above."
          : "No shops yet. Add your first unit above."
      }
    />
  );

  return (
    <ApiBaseCtx.Provider value={apiBase}>
      <div
        className={isPropertiesRental ? "properties-rentals-premium space-y-4" : "space-y-4"}
        data-testid={`page-${testIdPrefix}`}
      >
        {showHistoricalPaid && (
          <PaymentsReconciliation
            payments={historicalPayments}
            companyId={selectedCompany?.id}
            isLoading={historicalLoading}
            isError={historicalError}
            onReconciliationChange={setHistoryReconciliation}
          />
        )}
        <PageHeader
          title={section.title}
          subtitle={headerSubtitle}
          icon={<SectionIcon className="h-6 w-6 text-primary" aria-hidden="true" />}
        >
          {headerActionsForWidth}
        </PageHeader>

        {isPropertiesRental && units.some((unit) => unit.isInternalLeaseProjection) && (
          <p className="text-xs text-muted-foreground" data-testid="properties-factory-internal-lease-note">
            Internal ERP/Factory leases appear for reference only. They are excluded from Properties rent and balance
            totals; manage payments and accounting from the originating rental module.
          </p>
        )}
        {!contractTotalsAreUsd && (
          <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
            Contract currencies are not all verified as USD. Contract-based overview totals are withheld rather than
            silently reported in USD. Individual contracts and ledger balances remain unchanged.
          </p>
        )}
        {currentRole === "Developer" && showHistoricalPaid && reconciledAccountTotalsReady && (
          <p className="text-xs text-muted-foreground" data-testid="properties-rent-account-balance-explanation">
            Combined account balances:{" "}
            <span className="font-semibold tabular-nums">
              {ledgerUsdMoney(historyReconciliation!.accountSum! / 100)}
            </span>{" "}
            (historical rent withdrawal through 26 Oct 2026; current ALI cash, Properties cashbox if present, and tenant
            deposits). These are account balances, not unique rent receipts.
            {historyReconciliation!.guaranteeCashOverlap != null && historyReconciliation!.guaranteeCashOverlap > 0 && (
              <>
                {" "}
                Guarantee cash of {ledgerUsdMoney(historyReconciliation!.guaranteeCashOverlap / 100)} appears in both a
                cash account and the deposit liability; these are not unique receipts.
              </>
            )}
            {(historicalAccountMismatch || guaranteeLedgerMismatch) && (
              <span className="block text-amber-600 dark:text-amber-400" role="status">
                {historicalAccountMismatch && " Payments history does not reconcile to the account balances."}
                {guaranteeLedgerMismatch && " Unit guarantee balances differ from the Tenant Deposits ledger."} No
                accounting entries have been changed.
              </span>
            )}
          </p>
        )}
        {phoneCards ? (
          <ErpMobileSummaryGrid
            className={isPropertiesRental ? "properties-rentals-mobile-stats" : undefined}
            data-testid={`summary-${testIdPrefix}`}
            items={[
              { label: "TOTAL UNITS", value: units.length },
              {
                label: "RENT / MONTH",
                value: `${summaryMoney(totals.totalMonthlyRent)}`,
                valueClassName: "text-blue-600 dark:text-blue-400",
              },
              {
                label: isPropertiesRental ? "TO COLLECT" : "OUTSTANDING",
                value: `${summaryMoney(totals.totalOwed)}`,
                valueClassName: isPropertiesRental
                  ? "text-green-600 dark:text-green-400"
                  : "text-red-600 dark:text-red-400",
              },
              {
                label: isPropertiesRental ? "OWED TO TENANTS" : "CREDIT",
                value: `${summaryMoney(totals.totalCredit)}`,
                valueClassName: isPropertiesRental
                  ? "text-red-600 dark:text-red-400"
                  : "text-green-600 dark:text-green-400",
              },
              {
                label: isPropertiesRental ? "GUARANTEE HELD" : "TOTAL GUARANTEE",
                value: guaranteeValue,
                valueClassName: isPropertiesRental ? "text-red-600 dark:text-red-400" : undefined,
              },
              { label: usesRentExpensePaidBasis ? "TOTAL PAID · LEDGER BASIS" : paidLabel, value: paidValue },
            ]}
          />
        ) : (
          /* Summary tiles: six equal tiles; the former Outstanding/Credit pair overflowed its card at
             tablet widths. */
          <div
            className={
              isPropertiesRental
                ? "properties-rentals-kpis grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6"
                : "grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2"
            }
          >
            <Card className={isPropertiesRental ? "properties-rentals-stat properties-rentals-stat--units" : undefined}>
              <CardHeader className="px-3 pt-3 pb-1">
                {isPropertiesRental && (
                  <span className="properties-rentals-stat-icon" aria-hidden="true">
                    <Boxes className="h-[19px] w-[19px]" />
                  </span>
                )}
                <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">
                  TOTAL UNITS
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3">
                <div className="text-lg font-bold" data-testid={`stat-${testIdPrefix}-total-units`}>
                  {units.length}
                </div>
              </CardContent>
            </Card>
            <Card className={isPropertiesRental ? "properties-rentals-stat properties-rentals-stat--rent" : undefined}>
              <CardHeader className="px-3 pt-3 pb-1">
                {isPropertiesRental && (
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
                  data-testid={`stat-${testIdPrefix}-monthly-rent`}
                >
                  {summaryMoney(totals.totalMonthlyRent)}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">expected from active leases</p>
              </CardContent>
            </Card>
            <Card
              className={isPropertiesRental ? "properties-rentals-stat properties-rentals-stat--guarantee" : undefined}
            >
              <CardHeader className="px-3 pt-3 pb-1">
                {isPropertiesRental && (
                  <span className="properties-rentals-stat-icon" aria-hidden="true">
                    <ShieldCheck className="h-[19px] w-[19px]" />
                  </span>
                )}
                <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">
                  {isPropertiesRental ? "GUARANTEE HELD" : "TOTAL GUARANTEE"}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3">
                <div
                  className={`text-lg font-bold ${isPropertiesRental ? "text-red-600 dark:text-red-400" : ""}`}
                  data-testid={`stat-${testIdPrefix}-total-guarantee`}
                >
                  {guaranteeValue}
                </div>
              </CardContent>
            </Card>
            <Card className={isPropertiesRental ? "properties-rentals-stat properties-rentals-stat--paid" : undefined}>
              <CardHeader className="px-3 pt-3 pb-1">
                {isPropertiesRental && (
                  <span className="properties-rentals-stat-icon" aria-hidden="true">
                    <Layers className="h-[19px] w-[19px]" />
                  </span>
                )}
                <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">
                  {paidLabel}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3">
                <div
                  className={`text-lg font-bold ${summaryPaid > 0 ? "text-green-600 dark:text-green-400" : ""}`}
                  data-testid={`stat-${testIdPrefix}-total-paid`}
                >
                  {paidValue}
                </div>
                {usesRentExpensePaidBasis && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Recognized rent · ledger basis, including accruals
                  </p>
                )}
              </CardContent>
            </Card>
            <Card
              className={isPropertiesRental ? "properties-rentals-stat properties-rentals-stat--collect" : undefined}
            >
              <CardHeader className="px-3 pt-3 pb-1">
                {isPropertiesRental && (
                  <span className="properties-rentals-stat-icon" aria-hidden="true">
                    <Wallet className="h-[19px] w-[19px]" />
                  </span>
                )}
                <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">
                  {isPropertiesRental ? "TO COLLECT" : "OUTSTANDING"}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3">
                <div
                  className={`text-lg font-bold ${isPropertiesRental ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                  data-testid={`stat-${testIdPrefix}-total-outstanding`}
                >
                  {summaryMoney(totals.totalOwed)}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {isPropertiesRental ? "tenants owe you" : "owed by tenants"}
                </p>
              </CardContent>
            </Card>
            <Card className={isPropertiesRental ? "properties-rentals-stat properties-rentals-stat--owed" : undefined}>
              <CardHeader className="px-3 pt-3 pb-1">
                {isPropertiesRental && (
                  <span className="properties-rentals-stat-icon" aria-hidden="true">
                    <UsersRound className="h-[19px] w-[19px]" />
                  </span>
                )}
                <CardTitle className="text-[11px] text-muted-foreground font-normal tracking-wide">
                  {isPropertiesRental ? "OWED TO TENANTS" : "CREDIT"}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3">
                <div
                  className={`text-lg font-bold ${isPropertiesRental ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
                  data-testid={`stat-${testIdPrefix}-total-credit`}
                >
                  {summaryMoney(totals.totalCredit)}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {isPropertiesRental ? "tenant prepayments / overpayments" : "advance / overpaid"}
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {phoneCards ? (
          isLoading ? (
            unitsLoadingState
          ) : grouped.length === 0 ? (
            unitsEmptyState
          ) : (
            <RentalUnitCards
              landlordView={isPropertiesRental}
              grouped={grouped}
              selectedContractIds={selectedContractIds}
              onToggleSelect={(contractId) =>
                toggleSelect(contractId, { stopPropagation: () => {} } as React.MouseEvent<Element, MouseEvent>)
              }
              onOpenUnit={setOpenUnitId}
              onDeleteUnit={setConfirmDeleteUnitId}
              onRenameGroup={isPropertiesRental ? openRenameGroup : undefined}
              canRenameGroup={(groupUnits) => !!editableUnitInGroup(groupUnits)}
            />
          )
        ) : (
          /* Main table */
          <PropertyRentalUnitsTable m={m} unitsLoadingState={unitsLoadingState} unitsEmptyState={unitsEmptyState} />
        )}

        {bulkPayOpen && selectedUnits.length > 0 && (
          <BulkPaymentDialog
            units={selectedUnits}
            cashAccounts={cashAccounts}
            testIdPrefix={testIdPrefix}
            onClose={() => setBulkPayOpen(false)}
            onSuccess={() => setSelectedContractIds(new Set())}
          />
        )}

        {openUnit && (
          <UnitActionDialog
            unit={openUnit}
            cashAccounts={cashAccounts}
            onClose={() => setOpenUnitId(null)}
            unitType={unitType}
            testIdPrefix={testIdPrefix}
          />
        )}

        {createUnitOpen && (
          <CreateUnitDialog unitType={unitType} onClose={() => setCreateUnitOpen(false)} testIdPrefix={testIdPrefix} />
        )}

        {renameGroup && (
          <Dialog open onOpenChange={(open) => !open && !renameLocationGroup.isPending && setRenameGroup(null)}>
            <DialogContent data-testid={`dialog-${testIdPrefix}-rename-group`}>
              <DialogHeader>
                <DialogTitle>Rename location group</DialogTitle>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="rename-rental-location-group">Group name</Label>
                <Input
                  id="rename-rental-location-group"
                  value={newGroupName}
                  maxLength={120}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      newGroupName.trim() &&
                      newGroupName.trim().toUpperCase() !== renameGroup.name.toUpperCase() &&
                      !renameLocationGroup.isPending
                    ) {
                      renameLocationGroup.mutate({
                        unitId: renameGroup.unitId,
                        locationGroup: newGroupName.trim(),
                      });
                    }
                  }}
                  data-testid={`input-${testIdPrefix}-rename-group`}
                />
                <p className="text-xs text-muted-foreground">
                  Renames this location for all its warehouses or shops in this company. Contracts, payments, and
                  accounting records are unchanged.
                </p>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRenameGroup(null)} disabled={renameLocationGroup.isPending}>
                  Cancel
                </Button>
                <Button
                  onClick={() =>
                    renameLocationGroup.mutate({ unitId: renameGroup.unitId, locationGroup: newGroupName.trim() })
                  }
                  disabled={
                    !newGroupName.trim() ||
                    newGroupName.trim().toUpperCase() === renameGroup.name.toUpperCase() ||
                    renameLocationGroup.isPending
                  }
                  data-testid={`button-${testIdPrefix}-save-group`}
                >
                  {renameLocationGroup.isPending ? "Saving…" : `Rename ${renameGroup.count} units`}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {/* Confirm delete unit dialog */}
        {confirmDeleteUnit && (
          <Dialog open onOpenChange={(o) => !o && setConfirmDeleteUnitId(null)}>
            <DialogContent data-testid={`dialog-${testIdPrefix}-confirm-delete`}>
              <DialogHeader>
                <DialogTitle>Delete Unit {confirmDeleteUnit.unitNumber}?</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                This will permanently remove unit{" "}
                <span className="font-semibold text-foreground">{confirmDeleteUnit.unitNumber}</span> from the list.
                {confirmDeleteUnit.contract ? (
                  <span className="block mt-1 text-destructive font-medium">
                    This unit has an active contract — end it first before deleting.
                  </span>
                ) : (
                  <span className="block mt-1">The unit is currently vacant and can be safely deleted.</span>
                )}
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmDeleteUnitId(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => deleteUnit.mutate(confirmDeleteUnit.id)}
                  disabled={deleteUnit.isPending || !!confirmDeleteUnit.contract}
                  data-testid={`button-${testIdPrefix}-confirm-delete-submit`}
                >
                  {deleteUnit.isPending ? "Deleting…" : "Delete Unit"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </ApiBaseCtx.Provider>
  );
}
