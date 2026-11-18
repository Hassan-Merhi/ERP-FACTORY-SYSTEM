// Extracted from ./PropertyRentalPage.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, getAppDate, queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { BookCheck, ClipboardList, CreditCard, Plus, RefreshCw } from "lucide-react";
import { rentalSectionHref } from "@/properties/config/rentalSections";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import type { Props, Unit } from "./property-rental/types";
import { useRentalCashAccounts, useRentalUnits } from "@/properties/hooks/useRentalUnits";
import { useRentalReconciliationPayments } from "@/properties/hooks/useRentalPayments";
import { useGroupedRentalUnits, useRentalOverview } from "@/properties/hooks/useRentalOverview";
import { getRentalModulePolicy } from "@/properties/config/rentalModulePolicy";
import { formatMoneyDisplay } from "@/lib/moneyDisplay";
import { hasSingleUsdBasis, rentalReportingFigure } from "@/properties/config/rentalReportingPresentation";
import { hasHassanPropertiesHistoricalReportingPolicy } from "@/properties/config/historicalRentReportingPolicy";
import { ErpMobileActionsMenu } from "@/components/ui/erp-mobile-records";
import type { ReconciliationSnapshot } from "./property-rental/components/PaymentsReconciliation";

export function usePropertyRentalPageState({ rentalModule, unitType, testIdPrefix }: Props) {
  const { selectedCompany } = useCompany();
  const rentalPolicy = getRentalModulePolicy(rentalModule);
  const apiBase = rentalPolicy.apiBase;
  const isPropertiesRental = rentalPolicy.usesPropertiesReconciliation;
  const { toast } = useToast();
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
    isPropertiesRental && unitType === "WAREHOUSE" && hasHassanPropertiesHistoricalReportingPolicy(selectedCompany);
  const {
    data: historicalPayments = [],
    isLoading: historicalLoading,
    isError: historicalError,
  } = useRentalReconciliationPayments(apiBase, selectedCompany?.id, showHistoricalPaid);

  const { data: cashAccounts = [] } = useRentalCashAccounts(apiBase, selectedCompany?.id);

  const grouped = useGroupedRentalUnits(units);
  const totals = useRentalOverview(units);

  // HADI L'SHI ERP Shop Rentals: the owner wants the Total Paid tile to equal
  // the recognized Rent Expense ledger, not the active-contract receipts subtotal.
  // This is presentation ONLY: no rent payments, vouchers or cash balances change.
  // Read the same account/date basis as the existing monthly ledger report.
  const usesRentExpensePaidBasis = rentalModule === "ERP" && unitType === "SHOP" && selectedCompany?.id === 1;
  const rentalBusinessDay = getAppDate();
  const { data: rentExpenseSummary } = useQuery<{ grandTotal: { closingBalance: number } }>({
    queryKey: [
      "/api/reports/ledger-monthly-summary",
      1007,
      selectedCompany?.id,
      rentalBusinessDay,
      "shop-rental-paid-kpi",
    ],
    queryFn: async () => {
      const response = await fetch(
        `/api/reports/ledger-monthly-summary/1007?startDate=${rentalBusinessDay.slice(0, 4)}-01-01&endDate=${rentalBusinessDay}`,
        { credentials: "include" }
      );
      if (!response.ok) throw new Error("Failed to load posted rent expense");
      return response.json();
    },
    enabled: usesRentExpensePaidBasis,
  });
  // Monthly ledger closingBalance is CREDIT-positive; expense debit is negative.
  // Never fall back to contract receipts on query failure: that would show a
  // misleading mismatched Total Paid value on this specific page.
  const postedRentExpensePaid =
    usesRentExpensePaidBasis &&
    typeof rentExpenseSummary?.grandTotal?.closingBalance === "number" &&
    Number.isFinite(rentExpenseSummary.grandTotal.closingBalance)
      ? -rentExpenseSummary.grandTotal.closingBalance
      : null;

  // Contracts carry their own recorded currency. Never label an unconverted
  // mixture as USD merely because the historical summary defaulted to dollars.
  const contractTotalsAreUsd = hasSingleUsdBasis(
    units
      .filter((unit) => unit.contract && !unit.isInternalLeaseProjection)
      .map((unit) => ({ currency: unit.contract?.currency }))
  );

  const reconciledAccountTotalsReady =
    showHistoricalPaid &&
    !historicalLoading &&
    !historicalError &&
    historyReconciliation !== null &&
    historyReconciliation.companyId === selectedCompany?.id &&
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
    : usesRentExpensePaidBasis
      ? (postedRentExpensePaid ?? 0)
      : totals.totalPaid;
  const summaryGuarantee = showHistoricalPaid
    ? reconciledAccountTotalsReady
      ? historyReconciliation!.depositBalance! / 100
      : 0
    : totals.totalGuarantee;
  const paidLabel = showHistoricalPaid ? "RENT + CASH BALANCES" : "TOTAL PAID";
  const paidFigure = rentalReportingFigure(
    showHistoricalPaid
      ? reconciledAccountTotalsReady
        ? summaryPaid
        : null
      : usesRentExpensePaidBasis
        ? postedRentExpensePaid
        : contractTotalsAreUsd
          ? summaryPaid
          : null,
    showHistoricalPaid
      ? "reconciled-account-balances"
      : usesRentExpensePaidBasis
        ? "posted-ledger-expense"
        : "contract-paid",
    usesRentExpensePaidBasis ? rentalBusinessDay : null
  );
  const ledgerUsdMoney = (amount: number) => formatMoneyDisplay(amount, { currency: "USD" });
  const summaryMoney = (amount: number) =>
    contractTotalsAreUsd ? ledgerUsdMoney(amount) : "Non-USD or unverified currencies — see contracts";
  const paidValue =
    paidFigure.amount === null
      ? showHistoricalPaid || usesRentExpensePaidBasis
        ? "Unavailable"
        : "Non-USD or unverified currencies — see contracts"
      : formatMoneyDisplay(paidFigure.amount, { currency: paidFigure.currency });
  const guaranteeValue = showHistoricalPaid
    ? reconciledAccountTotalsReady
      ? formatMoneyDisplay(summaryGuarantee, { currency: "USD" })
      : "Unavailable"
    : summaryMoney(summaryGuarantee);
  const historicalAccountMismatch =
    reconciledAccountTotalsReady &&
    historyReconciliation!.reconciled !== null &&
    historyReconciliation!.difference !== null &&
    Math.abs(historyReconciliation!.difference) > 1;
  const guaranteeLedgerMismatch =
    contractTotalsAreUsd &&
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
  const paymentsLogUrl = rentalSectionHref(rentalModule, "payments");
  // Factory Payments Log is an admin page. Do not show a link that the
  // central Factory route guard will immediately reject for other roles.
  const showPaymentsLog = Boolean(
    !isPropertiesRental && (rentalModule !== "FACTORY" || currentRole === "Admin" || currentRole === "Developer")
  );
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
          showPaymentsLog && {
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
      {showPaymentsLog && (
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

  const headerSubtitle = "Click any unit to manage payments, modify rent, post guarantee, or end the contract.";
  const headerActionsForWidth = phoneCards ? phoneHeaderActions : headerActions;
  return {
    apiBase,
    bulkPayOpen,
    cashAccounts,
    confirmDeleteUnit,
    contractTotalsAreUsd,
    contractedUnits,
    createUnitOpen,
    currentRole,
    deleteUnit,
    editableUnitInGroup,
    grouped,
    guaranteeLedgerMismatch,
    guaranteeValue,
    headerActionsForWidth,
    headerSubtitle,
    historicalAccountMismatch,
    historicalError,
    historicalLoading,
    historicalPayments,
    historyReconciliation,
    isFactoryShopTable,
    isLoading,
    isPropertiesRental,
    ledgerUsdMoney,
    newGroupName,
    openRenameGroup,
    openUnit,
    paidLabel,
    paidValue,
    phoneCards,
    reconciledAccountTotalsReady,
    renameGroup,
    renameLocationGroup,
    selectedCompany,
    selectedContractIds,
    selectedUnits,
    setBulkPayOpen,
    setConfirmDeleteUnitId,
    setCreateUnitOpen,
    setHistoryReconciliation,
    setNewGroupName,
    setOpenUnitId,
    setRenameGroup,
    setSelectedContractIds,
    showHistoricalPaid,
    summaryMoney,
    summaryPaid,
    testIdPrefix,
    toggleSelect,
    toggleSelectAll,
    totals,
    unitType,
    units,
    usesRentExpensePaidBasis,
  };
}
