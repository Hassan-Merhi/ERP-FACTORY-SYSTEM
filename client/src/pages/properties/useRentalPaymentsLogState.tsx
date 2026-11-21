// Extracted from ./RentalPaymentsLog.tsx
import { getRentalModulePolicy } from "@/properties/config/rentalModulePolicy";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { PageHeader } from "@/components/PageHeader";
import { RENTAL_SECTION_DEFINITIONS } from "@/properties/config/rentalSections";
import { RentalPaymentsExportMenu } from "./property-rental/components/RentalPaymentsExportMenu";
import { hasSingleUsdBasis, rentalReportingFigure } from "@/properties/config/rentalReportingPresentation";
import { useMobileCardTable } from "@/components/ui/mobile-card-table";
import { type ReconciliationSnapshot } from "./property-rental/components/PaymentsReconciliation";
import { paymentHistoryTsv, reconciledHistoryTsv, receiptTotals } from "./property-rental/paymentsReceiptMath";
import { hasHassanPropertiesHistoricalReportingPolicy } from "@/properties/config/historicalRentReportingPolicy";
import { useRentalPayments, rentalPaymentsQueryKey } from "@/properties/hooks/useRentalPayments";
import { useRentalPaymentsFilters } from "@/properties/hooks/useRentalPaymentsFilters";
import { type PaymentRow, type Props } from "./RentalPaymentsLogModel";

export function useRentalPaymentsLogState({
  rentalModule,
  testIdPrefix,
}: Pick<Props, "rentalModule" | "testIdPrefix">) {
  const rentalPolicy = getRentalModulePolicy(rentalModule);
  const apiBase = rentalPolicy.apiBase;
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  // Phones restack the payments table as cards in every mode.
  const { tableProps: cardTableProps } = useMobileCardTable();
  const [deleteTarget, setDeleteTarget] = useState<PaymentRow | null>(null);
  const [reconciliation, setReconciliation] = useState<ReconciliationSnapshot | null>(null);

  // Both pages use the same voucher-backed dated rent snapshot. No payment is created.
  const isPropertiesPayments = rentalPolicy.usesPropertiesReconciliation;
  const isHassanProperties = isPropertiesPayments && hasHassanPropertiesHistoricalReportingPolicy(selectedCompany);
  const queryKey = rentalPaymentsQueryKey(apiBase, selectedCompany?.id, isPropertiesPayments);
  const {
    data: payments = [],
    isLoading,
    isError: paymentsError,
  } = useRentalPayments(apiBase, selectedCompany?.id, isPropertiesPayments);
  const {
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
    filtered,
    noFilters,
  } = useRentalPaymentsFilters(payments, isPropertiesPayments, selectedCompany?.id);

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return apiRequest("DELETE", `${apiBase}/payments/${id}`);
    },
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
    reconciliation !== null &&
    reconciliation.companyId === selectedCompany?.id &&
    !reconciliation.loading &&
    reconciliation.accountSum !== null &&
    reconciliation.aliCashLedgerId !== null;
  const total = isPropertiesPayments
    ? paymentTotals.cash / 100
    : filtered.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const clipboardIsUsd = hasSingleUsdBasis(filtered);
  const fullHistoryIsUsd = hasSingleUsdBasis(payments);
  const displayedFigure = rentalReportingFigure(clipboardIsUsd ? total : null, "posted-cash");
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
    if (
      !reconciliationReady ||
      !fullHistoryIsUsd ||
      reconciliation?.aliCashLedgerId == null ||
      reconciliation.accountSum == null
    )
      return;
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

  // One header for every module: title and icon from the shared rental sections; the export
  // menu sits in the header actions (Properties adds its clipboard copies to the same menu).
  const section = RENTAL_SECTION_DEFINITIONS.payments;
  const SectionIcon = section.icon;
  // Full-history export is available only to the verified historical reporting company.
  const copyIsFull = isFullHistory;
  const copyAllowed =
    !isLoading &&
    !paymentsError &&
    filtered.length > 0 &&
    clipboardIsUsd &&
    (!isFullHistory || (reconciliationReady && fullHistoryIsUsd));
  const header = (
    <PageHeader
      title={section.title}
      subtitle="All payment receipts recorded across all units, sorted by date."
      icon={<SectionIcon className="h-6 w-6 text-primary" aria-hidden="true" />}
    >
      {isPropertiesPayments ? (
        <RentalPaymentsExportMenu
          rows={filtered}
          cashOnly
          disabled={isLoading || paymentsError}
          companyName={selectedCompany?.name}
          testIdPrefix={testIdPrefix}
          canCopy={copyAllowed}
          fullHistory={copyIsFull}
          onCopy={() => {
            void (isFullHistory ? copyFullHistory() : copyHistory());
          }}
        />
      ) : (
        <RentalPaymentsExportMenu
          rows={filtered}
          cashOnly={false}
          disabled={isLoading || paymentsError}
          companyName={selectedCompany?.name}
          testIdPrefix={testIdPrefix}
        />
      )}
    </PageHeader>
  );
  return {
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
  };
}
