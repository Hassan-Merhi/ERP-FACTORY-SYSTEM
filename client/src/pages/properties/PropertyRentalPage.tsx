import type { ClientErrorLike } from "@/lib/clientError";
import { Fragment, useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  ChevronRight,
  RefreshCw,
  Trash2,
  ClipboardList,
  CreditCard,
  BookCheck,
  MapPin,
  Building2,
  UserRound,
  CalendarDays,
  Pencil,
  Boxes,
  Coins,
  ShieldCheck,
  Layers,
  Wallet,
  UsersRound,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format } from "date-fns";
import { PageHeader } from "@/components/PageHeader";
import { useAppMode } from "@/contexts/AppModeContext";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import "./property-rental/propertiesRentalsPremium.css";

import type { Props, Unit } from "./property-rental/types";
import { useRentalUnits, useRentalCashAccounts } from "@/properties/hooks/useRentalUnits";
import { useRentalReconciliationPayments } from "@/properties/hooks/useRentalPayments";
import { useRentalOverview, useGroupedRentalUnits } from "@/properties/hooks/useRentalOverview";
import { getRentalModulePolicy } from "@/properties/config/rentalModulePolicy";
import { fmtMoneyCurrency } from "./property-rental/utils";
import { formatMoneyDisplay } from "@/lib/moneyDisplay";
import { hasHassanPropertiesHistoricalReportingPolicy } from "@/properties/config/historicalRentReportingPolicy";
import { ApiBaseCtx } from "./property-rental/shared";
import { NoteCell } from "./property-rental/components/NoteCell";
import { CreateUnitDialog } from "./property-rental/components/CreateUnitDialog";
import { UnitActionDialog } from "./property-rental/components/UnitActionDialog";
import { BulkPaymentDialog } from "./property-rental/components/BulkPaymentDialog";
import { RentalUnitCards } from "./property-rental/components/RentalUnitCards";
import { ErpMobileActionsMenu, ErpMobileSummaryGrid } from "@/components/ui/erp-mobile-records";
import {
  PaymentsReconciliation,
  type ReconciliationSnapshot,
} from "./property-rental/components/PaymentsReconciliation";
export default function PropertyRentalPage({
  rentalModule,
  unitType,
  pageTitle,
  pageIcon,
  testIdPrefix,
  paymentsLogUrl,
}: Props) {
  const { selectedCompany } = useCompany();
  const rentalPolicy = getRentalModulePolicy(rentalModule);
  const apiBase = rentalPolicy.apiBase;
  const isPropertiesRental = rentalPolicy.usesPropertiesReconciliation;
  const { toast } = useToast();
  const appMode = useAppMode();
  const [, navigate] = useLocation();
  const [openUnitId, setOpenUnitId] = useState<number | null>(null);
  const [createUnitOpen, setCreateUnitOpen] = useState(false);
  const [confirmDeleteUnitId, setConfirmDeleteUnitId] = useState<number | null>(null);
  const [renameGroup, setRenameGroup] = useState<{ name: string; unitId: number; count: number } | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [historyReconciliation, setHistoryReconciliation] = useState<ReconciliationSnapshot | null>(null);

  const { data: units = [], isLoading } = useRentalUnits(apiBase, selectedCompany?.id, unitType);

  // Read-only accounting presentation shared with the Payments Log.
  // The historical cutoff alone excludes the later ALI cash ledger balance.
  const showHistoricalPaid =
    isPropertiesRental &&
    unitType === "WAREHOUSE" &&
    hasHassanPropertiesHistoricalReportingPolicy(selectedCompany);
  const {
    data: historicalPayments = [],
    isLoading: historicalLoading,
    isError: historicalError,
  } = useRentalReconciliationPayments(apiBase, selectedCompany?.id, showHistoricalPaid);

  const { data: cashAccounts = [] } = useRentalCashAccounts(apiBase, selectedCompany?.id);

  const grouped = useGroupedRentalUnits(units);
  const totals = useRentalOverview(units);

  const reconciledAccountTotalsReady =
    showHistoricalPaid &&
    !historicalLoading &&
    !historicalError &&
    historyReconciliation?.companyId === selectedCompany?.id &&
    !historyReconciliation.loading &&
    historyReconciliation.rentAndCashBalance !== null &&
    historyReconciliation.depositBalance !== null &&
    historyReconciliation.accountSum !== null;
  // For HASSAN PROPERTIES, the Payments Log uses an account-balance total:
  // withdrawal through 26 Oct + ALI cash + optional Properties cashbox + tenant deposits.
  // Cash accounts may include guarantee deposits, so this is NOT rent-only.
  const summaryPaid = showHistoricalPaid
    ? reconciledAccountTotalsReady
      ? historyReconciliation!.rentAndCashBalance! / 100
      : 0
    : totals.totalPaid;
  const summaryGuarantee = showHistoricalPaid
    ? reconciledAccountTotalsReady
      ? historyReconciliation!.depositBalance! / 100
      : 0
    : totals.totalGuarantee;
  const paidLabel = showHistoricalPaid ? "RENT + CASH BALANCES" : "TOTAL PAID";
  // Aggregated summary figures historically use USD; this is presentation only, never FX conversion.
  const summaryMoney = (amount: number) => formatMoneyDisplay(amount, { currency: "USD" });
  const paidValue = !showHistoricalPaid || reconciledAccountTotalsReady ? summaryMoney(summaryPaid) : "Unavailable";
  const guaranteeValue =
    !showHistoricalPaid || reconciledAccountTotalsReady ? summaryMoney(summaryGuarantee) : "Unavailable";
  const historicalAccountMismatch =
    reconciledAccountTotalsReady &&
    historyReconciliation!.reconciled !== null &&
    historyReconciliation!.difference !== null &&
    Math.abs(historyReconciliation!.difference) > 1;
  const guaranteeLedgerMismatch =
    reconciledAccountTotalsReady &&
    Math.abs(historyReconciliation!.depositBalance! - Math.round(totals.totalGuarantee * 100)) > 1;

  const runMonthly = useMutation({
    mutationFn: () => apiRequest("POST", apiBase + "/run-monthly"),
    onSuccess: () => {
      toast({ title: "Monthly ledger updated" });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
    },
  });

  // Wave 18 A: the units page no longer posts on load. Due scheduled payments and
  // accruals post from the daily job; Admin/Owner can post them now (same code
  // path, dated by the company's business date, audited).
  const { data: currentUser } = useQuery(authenticatedUserQueryOptions());
  const currentRole = currentUser?.currentRole ?? currentUser?.role ?? "";
  const canPostDue = currentRole === "Admin" || currentRole === "Owner" || currentRole === "Developer";
  const postDue = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", apiBase + "/accruals/post-due");
      return (await res.json()) as { accrued: number; scheduledPaymentsPosted: number; skipped: unknown[] };
    },
    onSuccess: (result) => {
      toast({
        title: "Due rent posted",
        description: `Rows accrued: ${result.accrued}; scheduled payments posted: ${result.scheduledPaymentsPosted}; skipped (closed period): ${result.skipped.length}`,
      });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Could not post due accruals", description: e.message, variant: "destructive" });
    },
  });

  const deleteUnit = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `${apiBase}/units/${id}`),
    onSuccess: () => {
      toast({ title: "Unit deleted" });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      setConfirmDeleteUnitId(null);
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Cannot delete", description: e.message, variant: "destructive" });
      setConfirmDeleteUnitId(null);
    },
  });

  const renameLocationGroup = useMutation({
    mutationFn: ({ unitId, locationGroup }: { unitId: number; locationGroup: string }) =>
      apiRequest("PATCH", `${apiBase}/units/${unitId}`, { renameGroup: true, locationGroup }),
    onSuccess: () => {
      toast({ title: "Location group renamed" });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      setRenameGroup(null);
    },
    onError: (e: ClientErrorLike) =>
      toast({ title: "Could not rename location group", description: e.message, variant: "destructive" }),
  });

  const editableUnitInGroup = (groupUnits: Unit[]) =>
    groupUnits.find((u) => u.unitType === unitType && !u.isShared && !u.isInternalLeaseProjection);
  const openRenameGroup = (name: string, groupUnits: Unit[]) => {
    const unit = editableUnitInGroup(groupUnits);
    if (!isPropertiesRental || !unit) return;
    setRenameGroup({
      name,
      unitId: unit.id,
      count: groupUnits.filter((u) => u.unitType === unitType && !u.isShared && !u.isInternalLeaseProjection).length,
    });
    setNewGroupName(name);
  };

  const openUnit = units.find((u) => u.id === openUnitId) ?? null;
  const confirmDeleteUnit = confirmDeleteUnitId ? (units.find((u) => u.id === confirmDeleteUnitId) ?? null) : null;

  // ── Bulk payment selection state ──────────────────────────
  const [selectedContractIds, setSelectedContractIds] = useState<Set<number>>(new Set());
  const [bulkPayOpen, setBulkPayOpen] = useState(false);

  const contractedUnits = useMemo(
    () => units.filter((u) => u.contract && !u.isShared && !u.isInternalLeaseProjection),
    [units]
  );

  const toggleSelect = (contractId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedContractIds((prev) => {
      const next = new Set(prev);
      if (next.has(contractId)) next.delete(contractId);
      else next.add(contractId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedContractIds.size === contractedUnits.length) {
      setSelectedContractIds(new Set());
    } else {
      setSelectedContractIds(new Set(contractedUnits.map((u) => u.contract!.id)));
    }
  };

  const selectedUnits = useMemo(
    () => units.filter((u) => u.contract && selectedContractIds.has(u.contract.id)),
    [units, selectedContractIds]
  );

  // ERP and Properties render the shared page-header contract; Factory keeps its hub strip.
  const isErp = appMode === "erp" || appMode === "properties";
  const isFactoryShopTable = testIdPrefix === "factory-rental-shops";
  const isPhoneLayout = useErpPhoneLayout();
  // Phones in every mode: cards instead of the twelve-column table, and one primary action plus
  // a menu.
  const phoneCards = isPhoneLayout;
  const phoneHeaderActions = (
    <>
      {selectedContractIds.size > 0 && (
        <Button onClick={() => setBulkPayOpen(true)} data-testid={`button-${testIdPrefix}-bulk-pay`}>
          <CreditCard className="h-4 w-4 me-1" />
          Pay Selected ({selectedContractIds.size})
        </Button>
      )}
      <Button onClick={() => setCreateUnitOpen(true)} data-testid={`button-${testIdPrefix}-add-unit`}>
        <Plus className="h-4 w-4 me-1" />
        {unitType === "WAREHOUSE" ? "Add Warehouse" : "Add Shop"}
      </Button>
      <ErpMobileActionsMenu
        data-testid={`button-${testIdPrefix}-actions`}
        actions={[
          !!paymentsLogUrl &&
            !isPropertiesRental && {
              label: "Payments Log",
              icon: ClipboardList,
              onSelect: () => navigate(paymentsLogUrl),
              testId: `button-${testIdPrefix}-payments-log`,
            },
          {
            label: "Run Monthly Update",
            icon: RefreshCw,
            onSelect: () => runMonthly.mutate(),
            disabled: runMonthly.isPending,
            testId: `button-${testIdPrefix}-run-monthly`,
          },
          canPostDue &&
            !isPropertiesRental && {
              label: "Post due accruals now",
              icon: BookCheck,
              onSelect: () => postDue.mutate(),
              disabled: postDue.isPending,
              testId: `button-${testIdPrefix}-post-due`,
            },
          contractedUnits.length > 0 && {
            label: selectedContractIds.size === contractedUnits.length ? "Clear selection" : "Select all",
            onSelect: toggleSelectAll,
            separated: true,
            testId: `checkbox-${testIdPrefix}-select-all`,
          },
        ]}
      />
    </>
  );
  const headerActions = (
    <>
      {selectedContractIds.size > 0 && (
        <Button size="sm" onClick={() => setBulkPayOpen(true)} data-testid={`button-${testIdPrefix}-bulk-pay`}>
          <CreditCard className="h-4 w-4 mr-1" />
          Pay Selected ({selectedContractIds.size})
        </Button>
      )}
      {paymentsLogUrl && !isPropertiesRental && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(paymentsLogUrl)}
          data-testid={`button-${testIdPrefix}-payments-log`}
        >
          <ClipboardList className="h-4 w-4 mr-1" />
          Payments Log
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => runMonthly.mutate()}
        disabled={runMonthly.isPending}
        data-testid={`button-${testIdPrefix}-run-monthly`}
      >
        <RefreshCw className={`h-4 w-4 mr-1 ${runMonthly.isPending ? "animate-spin" : ""}`} />
        Run Monthly Update
      </Button>
      {canPostDue && !isPropertiesRental && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => postDue.mutate()}
          disabled={postDue.isPending}
          data-testid={`button-${testIdPrefix}-post-due`}
        >
          <BookCheck className="h-4 w-4 mr-1" />
          Post due accruals now
        </Button>
      )}
      <Button onClick={() => setCreateUnitOpen(true)} size="sm" data-testid={`button-${testIdPrefix}-add-unit`}>
        <Plus className="h-4 w-4 mr-1" />
        {unitType === "WAREHOUSE" ? "Add Warehouse" : "Add Shop"}
      </Button>
    </>
  );

  return (
    <ApiBaseCtx.Provider value={apiBase}>
      <div
        className={
          isPropertiesRental ? "properties-rentals-premium space-y-5" : isErp ? "space-y-4 sm:p-4" : "p-4 space-y-4"
        }
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
        {isPropertiesRental ? (
          <section className="properties-rentals-hero" aria-label="Warehouse rentals overview">
            <div className="properties-rentals-hero-copy">
              <span className="properties-rentals-hero-icon" aria-hidden="true">
                <Building2 className="h-7 w-7" />
              </span>
              <div className="properties-rentals-hero-text">
                <span className="properties-rentals-eyebrow">PROPERTIES</span>
                <h1 className="properties-rentals-heading" data-testid="text-page-title">
                  {pageTitle.replace(/^Properties\s*[—-]\s*/, "")}
                </h1>
                <p className="properties-rentals-subheading">
                  Manage warehouse units, payments, rents, guarantees, and contracts in one place.
                </p>
              </div>
            </div>
            <div className="properties-rentals-hero-actions">{phoneCards ? phoneHeaderActions : headerActions}</div>
          </section>
        ) : isErp ? (
          <PageHeader
            title={pageTitle}
            subtitle="Click any unit to manage payments, modify rent, post guarantee, or end the contract."
            icon={pageIcon}
          >
            {phoneCards ? phoneHeaderActions : headerActions}
          </PageHeader>
        ) : (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              {pageIcon}
              <div>
                <PageHeader
                  title={pageTitle}
                  subtitle="Click any unit to manage payments, modify rent, post guarantee, or end the contract."
                />
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">{phoneCards ? phoneHeaderActions : headerActions}</div>
          </div>
        )}

        {isPropertiesRental && units.some((unit) => unit.isInternalLeaseProjection) && (
          <p className="text-xs text-muted-foreground" data-testid="properties-factory-internal-lease-note">
            Internal ERP/Factory leases appear for reference only. They are excluded from Properties rent and balance
            totals; manage payments and accounting from the originating rental module.
          </p>
        )}
        {showHistoricalPaid && reconciledAccountTotalsReady && (
          <p className="text-xs text-muted-foreground" data-testid="properties-rent-account-balance-explanation">
            Combined account balances:{" "}
            <span className="font-semibold tabular-nums">
              {summaryMoney(historyReconciliation!.accountSum! / 100)}
            </span>{" "}
            (rent withdrawal, ALI cash, Properties cashbox if present, and tenant deposits).
            {historyReconciliation!.guaranteeCashOverlap != null && historyReconciliation!.guaranteeCashOverlap > 0 && (
              <>
                {" "}
                Guarantee cash of {summaryMoney(historyReconciliation!.guaranteeCashOverlap / 100)} appears in both a cash account and the
                deposit liability; these are not unique receipts.
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
              { label: paidLabel, value: paidValue },
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
            <div className="p-8 text-center text-muted-foreground">Loading units…</div>
          ) : grouped.length === 0 ? (
            <div className="rounded-lg border p-8 text-center text-muted-foreground">
              {unitType === "WAREHOUSE"
                ? "No warehouses yet. Add your first unit above."
                : "No shops yet. Add your first unit above."}
            </div>
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
          <Card
            className={
              isFactoryShopTable
                ? "factory-rentals-table-shell"
                : isPropertiesRental
                  ? "properties-rentals-table-shell"
                  : undefined
            }
          >
            <CardContent className={isFactoryShopTable ? "p-2 sm:p-3" : isPropertiesRental ? "p-2 sm:p-4" : "p-0"}>
              <div data-horizontal-scroll="true" className="overflow-x-auto">
                {isLoading ? (
                  <div className="p-8 text-center text-muted-foreground">Loading units…</div>
                ) : grouped.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground">
                    {unitType === "WAREHOUSE"
                      ? "No warehouses yet. Add your first unit above."
                      : "No shops yet. Add your first unit above."}
                  </div>
                ) : (
                  <table
                    className={
                      isFactoryShopTable
                        ? "factory-rentals-table w-full text-sm"
                        : isPropertiesRental
                          ? "properties-rentals-data-table w-full min-w-[1170px] text-sm"
                          : "w-full text-sm"
                    }
                  >
                    <thead
                      className={
                        isPropertiesRental
                          ? "properties-rentals-table-head sticky top-0 z-30"
                          : "bg-muted border-b sticky top-0 z-30"
                      }
                    >
                      <tr>
                        <th className="px-3 py-2 w-8" onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={contractedUnits.length > 0 && selectedContractIds.size === contractedUnits.length}
                            onCheckedChange={toggleSelectAll}
                            data-testid={`checkbox-${testIdPrefix}-select-all`}
                            aria-label="Select all"
                          />
                        </th>
                        <th className="text-left px-3 py-2 font-semibold">Unit</th>
                        <th className="text-left px-3 py-2 font-semibold">Dimensions</th>
                        <th className="text-left px-3 py-2 font-semibold">Tenant</th>
                        <th className="text-left px-3 py-2 font-semibold">Note</th>
                        <th className="text-right px-3 py-2 font-semibold">Monthly Rent</th>
                        <th className="text-right px-3 py-2 font-semibold">Guarantee</th>
                        <th className="text-right px-3 py-2 font-semibold">
                          {isPropertiesRental ? "Tenant Balance" : "Outstanding"}
                        </th>
                        <th className="text-right px-3 py-2 font-semibold text-muted-foreground">Scheduled</th>
                        <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Next Billing</th>
                        <th className="text-left px-3 py-2 font-semibold">Start</th>
                        <th className="px-2 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {grouped.map(([group, groupUnits], gIdx) => {
                        const GROUP_PALETTE = [
                          { headerBg: "#1d4ed8", headerText: "#fff", r: 29, g: 78, b: 216 },
                          { headerBg: "#047857", headerText: "#fff", r: 4, g: 120, b: 87 },
                          { headerBg: "#7c3aed", headerText: "#fff", r: 124, g: 58, b: 237 },
                          { headerBg: "#b45309", headerText: "#fff", r: 180, g: 83, b: 9 },
                          { headerBg: "#be123c", headerText: "#fff", r: 190, g: 18, b: 60 },
                          { headerBg: "#0e7490", headerText: "#fff", r: 14, g: 116, b: 144 },
                          { headerBg: "#c2410c", headerText: "#fff", r: 194, g: 65, b: 12 },
                          { headerBg: "#4d7c0f", headerText: "#fff", r: 77, g: 124, b: 15 },
                        ];
                        const p = GROUP_PALETTE[gIdx % GROUP_PALETTE.length];
                        const rowBgEven = `rgba(${p.r},${p.g},${p.b},0.06)`;
                        const rowBgOdd = `rgba(${p.r},${p.g},${p.b},0.12)`;
                        const unitNumBg = `rgba(${p.r},${p.g},${p.b},0.18)`;
                        const unitNumColor = p.headerBg;
                        return (
                          <Fragment key={group}>
                            <tr
                              key={`grp-${group}`}
                              className={
                                isFactoryShopTable
                                  ? "factory-rentals-location-row"
                                  : isPropertiesRental
                                    ? "properties-rentals-group-row"
                                    : "border-t"
                              }
                            >
                              <td
                                colSpan={12}
                                className={
                                  isFactoryShopTable
                                    ? "factory-rentals-location-cell"
                                    : isPropertiesRental
                                      ? "properties-rentals-group-cell px-4 py-3 text-xs font-bold uppercase tracking-wider"
                                      : "px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-center"
                                }
                                style={
                                  isFactoryShopTable || isPropertiesRental
                                    ? undefined
                                    : { backgroundColor: p.headerBg, color: p.headerText }
                                }
                              >
                                {isFactoryShopTable ? (
                                  <div
                                    className="factory-rentals-location-bar"
                                    style={{ background: `linear-gradient(110deg, ${p.headerBg}, ${p.headerBg}df)` }}
                                  >
                                    <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
                                    <span>{group}</span>
                                    <span className="factory-rentals-location-count">
                                      {groupUnits.length} {groupUnits.length === 1 ? "unit" : "units"}
                                    </span>
                                  </div>
                                ) : (
                                  <span className="inline-flex items-center gap-2">
                                    {isPropertiesRental && <Building2 className="h-4 w-4" aria-hidden="true" />}
                                    <span>{group}</span>
                                    {isPropertiesRental && editableUnitInGroup(groupUnits) && (
                                      <button
                                        type="button"
                                        className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          openRenameGroup(group, groupUnits);
                                        }}
                                        title={`Rename ${group}`}
                                        aria-label={`Rename location group ${group}`}
                                        data-testid={`button-${testIdPrefix}-rename-group-${gIdx}`}
                                      >
                                        <Pencil className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                  </span>
                                )}
                              </td>
                            </tr>
                            {groupUnits.map((u, uIdx) => (
                              <tr
                                key={u.id}
                                className={
                                  isFactoryShopTable
                                    ? `factory-rentals-unit-row cursor-pointer${u.contract && selectedContractIds.has(u.contract.id) ? " factory-rentals-unit-row-selected" : ""}`
                                    : isPropertiesRental
                                      ? "properties-rentals-unit-row cursor-pointer transition-colors"
                                      : "border-t cursor-pointer transition-colors"
                                }
                                style={
                                  isFactoryShopTable
                                    ? ({ "--factory-rentals-rgb": `${p.r}, ${p.g}, ${p.b}` } as React.CSSProperties)
                                    : isPropertiesRental
                                      ? undefined
                                      : { backgroundColor: uIdx % 2 === 0 ? rowBgEven : rowBgOdd }
                                }
                                onMouseEnter={(e) => {
                                  if (!isFactoryShopTable && !isPropertiesRental)
                                    e.currentTarget.style.filter = "brightness(0.93)";
                                }}
                                onMouseLeave={(e) => {
                                  if (!isFactoryShopTable && !isPropertiesRental) e.currentTarget.style.filter = "";
                                }}
                                onClick={() => setOpenUnitId(u.id)}
                                data-testid={`row-unit-${u.id}`}
                              >
                                <td className="px-3 py-2 w-8" onClick={(e) => e.stopPropagation()}>
                                  {u.contract && !u.isShared && !u.isInternalLeaseProjection && (
                                    <Checkbox
                                      checked={selectedContractIds.has(u.contract.id)}
                                      onCheckedChange={() =>
                                        toggleSelect(u.contract!.id, { stopPropagation: () => {} } as React.MouseEvent<
                                          Element,
                                          MouseEvent
                                        >)
                                      }
                                      onClick={(e) => e.stopPropagation()}
                                      data-testid={`checkbox-unit-${u.id}`}
                                      aria-label={`Select ${u.unitNumber}`}
                                    />
                                  )}
                                </td>
                                <td
                                  className={isFactoryShopTable ? "px-3 py-2" : "px-3 py-2 font-mono text-xs font-bold"}
                                  style={
                                    isFactoryShopTable || isPropertiesRental
                                      ? undefined
                                      : { backgroundColor: unitNumBg, color: unitNumColor }
                                  }
                                >
                                  {isFactoryShopTable || isPropertiesRental ? (
                                    <span
                                      className={
                                        isPropertiesRental
                                          ? "properties-rentals-unit-pill"
                                          : "factory-rentals-unit-pill"
                                      }
                                      style={
                                        isFactoryShopTable
                                          ? { color: p.headerBg, backgroundColor: `rgba(${p.r},${p.g},${p.b},0.15)` }
                                          : undefined
                                      }
                                    >
                                      <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                      {u.unitNumber}
                                    </span>
                                  ) : (
                                    u.unitNumber
                                  )}
                                </td>
                                <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                                  {u.dimensions ? (
                                    <span className="font-medium text-foreground">{u.dimensions}</span>
                                  ) : u.size ? (
                                    <span>{u.size}</span>
                                  ) : (
                                    <span>—</span>
                                  )}
                                </td>
                                <td className="px-3 py-2">
                                  {u.contract ? (
                                    <span className="font-medium flex items-center gap-1.5 flex-wrap">
                                      {isFactoryShopTable && (
                                        <UserRound
                                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                                          aria-hidden="true"
                                        />
                                      )}
                                      {u.contract.tenantName}
                                      {u.contract.isInternal && (
                                        <Badge className="text-xs bg-violet-600 text-white">Internal</Badge>
                                      )}
                                      {u.isInternalLeaseProjection && (
                                        <Badge className="text-xs bg-violet-600 text-white">
                                          {u.sourceModule === "ERP" ? "ERP reference" : "Factory reference"}
                                        </Badge>
                                      )}
                                      {u.isShared && !u.isInternalLeaseProjection && (
                                        <Badge
                                          className="text-xs bg-sky-600 text-white"
                                          title={u.ownerCompanyName ? `From: ${u.ownerCompanyName}` : undefined}
                                        >
                                          Shared
                                        </Badge>
                                      )}
                                    </span>
                                  ) : (
                                    <Badge variant="secondary" className="text-xs">
                                      Vacant
                                    </Badge>
                                  )}
                                </td>
                                <td className="px-3 py-2">
                                  {u.contract ? (
                                    u.isInternalLeaseProjection ? (
                                      <span className="text-xs text-muted-foreground">{u.contract.notes || "—"}</span>
                                    ) : (
                                      <NoteCell
                                        contractId={u.contract.id}
                                        note={u.contract.notes}
                                        testId={`unit-${u.id}`}
                                      />
                                    )
                                  ) : (
                                    <span className="text-xs text-muted-foreground">—</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  <span className={isPropertiesRental ? "properties-rentals-money-pill" : undefined}>
                                    {u.contract ? fmtMoneyCurrency(u.contract.rentalAmount, u.contract.currency) : "—"}
                                  </span>
                                </td>
                                <td
                                  className={`px-3 py-2 text-right tabular-nums font-semibold ${
                                    u.contract && Number(u.contract.guaranteeAmount) > 0
                                      ? u.contract.guaranteePostedToStatement
                                        ? isPropertiesRental
                                          ? "text-red-600 dark:text-red-400"
                                          : "text-green-600 dark:text-green-400"
                                        : isPropertiesRental
                                          ? "text-amber-600 dark:text-amber-400"
                                          : "text-red-600 dark:text-red-400"
                                      : "text-muted-foreground"
                                  }`}
                                >
                                  <span
                                    className={
                                      isFactoryShopTable
                                        ? "factory-rentals-money-pill"
                                        : isPropertiesRental
                                          ? "properties-rentals-money-pill"
                                          : undefined
                                    }
                                  >
                                    {u.contract
                                      ? fmtMoneyCurrency(
                                          (
                                            u as unknown as Unit & {
                                              guaranteeRemaining: string | number | null | undefined;
                                            }
                                          ).guaranteeRemaining ?? u.contract.guaranteeAmount,
                                          u.contract.currency
                                        )
                                      : "—"}
                                  </span>
                                </td>
                                <td
                                  className={`px-3 py-2 text-right tabular-nums font-semibold ${(u.outstanding ?? 0) > 0 ? (isPropertiesRental ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400") : (u.prepaidCredit ?? 0) > 0 ? (isPropertiesRental ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400") : "text-muted-foreground"}`}
                                >
                                  <span
                                    className={
                                      isFactoryShopTable
                                        ? "factory-rentals-money-pill"
                                        : isPropertiesRental
                                          ? "properties-rentals-money-pill"
                                          : undefined
                                    }
                                  >
                                    {u.outstanding !== null
                                      ? fmtMoneyCurrency(
                                          (u.outstanding ?? 0) > 0
                                            ? u.outstanding!
                                            : (u as { prepaidCredit: 0 }).prepaidCredit > 0
                                              ? u.prepaidCredit
                                              : 0,
                                          u.contract?.currency
                                        )
                                      : "—"}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground text-xs">
                                  {(u as { scheduledAmount: 0 }).scheduledAmount > 0
                                    ? fmtMoneyCurrency(u.scheduledAmount, u.contract?.currency)
                                    : "—"}
                                </td>
                                <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                                  <span
                                    className={isPropertiesRental ? "properties-rentals-date" : "factory-rentals-date"}
                                  >
                                    {(isFactoryShopTable || isPropertiesRental) && (
                                      <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                    )}
                                    {u.nextBillingDate
                                      ? format(new Date(u.nextBillingDate + "T00:00:00Z"), "dd MMM")
                                      : "—"}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-xs text-muted-foreground">
                                  <span
                                    className={isPropertiesRental ? "properties-rentals-date" : "factory-rentals-date"}
                                  >
                                    {(isFactoryShopTable || isPropertiesRental) && (
                                      <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                    )}
                                    {u.contract ? format(new Date(u.contract.startDate), "dd MMM yyyy") : "—"}
                                  </span>
                                </td>
                                <td className="px-2 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                                  <div className="flex items-center justify-end gap-1">
                                    {!u.isShared && !u.isInternalLeaseProjection && (
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="text-muted-foreground hover:text-destructive"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setConfirmDeleteUnitId(u.id);
                                        }}
                                        data-testid={`button-delete-unit-${u.id}`}
                                      >
                                        <Trash2 className="h-4 w-4" />
                                      </Button>
                                    )}
                                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </CardContent>
          </Card>
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
                      renameLocationGroup.mutate({ unitId: renameGroup.unitId, locationGroup: newGroupName.trim() });
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
