// Extracted from ./useAccountStatementViewState.tsx
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fxEurStatementUrl } from "./FxAgentEurStatement";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useToast } from "@/hooks/use-toast";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import { shouldShowFactoryCustomerDestination } from "./customerDestinationVisibility";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { AccountStatementPageMetadata, AccountStatementViewProps } from "./AccountStatementViewTypes";

export function useAccountStatementViewStatePart1({
  selectedAccount,
  periodFilter,
  vouchersWithBalance,
  statementCustomerId,
  closingBalance,
  selectedVoucherIds,
  appMode,
  toggleVoucherSelection,
}: Pick<
  AccountStatementViewProps,
  | "selectedAccount"
  | "periodFilter"
  | "vouchersWithBalance"
  | "statementCustomerId"
  | "closingBalance"
  | "selectedVoucherIds"
  | "appMode"
  | "toggleVoucherSelection"
>) {
  // View Only and Create Only cannot delete existing vouchers (server-enforced too).
  const { allowed: canChangeExistingRecords } = useExistingRecordChangeAccess();
  const { formatTransactionAmount } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const { language } = useApplicationLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isFactorySupplierAccount = selectedAccount?.type === "factorySupplier";
  const [pdfLang, setPdfLang] = useState<"en" | "fr" | "ar">("en");
  const isPhone = useErpPhoneLayout();
  const ledgerCompanyLabel = appMode === "properties" ? "Properties" : appMode === "factory" ? "Factory" : "ERP";
  const nativeWallet = selectedAccount.fxWallet;
  const fxWalletId = nativeWallet?.wallet?.id;
  const [fxTabChoice, setFxTabChoice] = useState<{ accountId: number; tab: "eur" | "usd" } | null>(null);
  const hasFxTabs = selectedAccount.type === "ledger" && !!fxWalletId;
  const activeFxTab =
    fxTabChoice?.accountId === selectedAccount.accountId
      ? fxTabChoice.tab
      : Number(nativeWallet?.state.eur || 0) > 0
        ? "eur"
        : "usd";
  const isEurTab = hasFxTabs && activeFxTab === "eur";

  const statementMetadata = queryClient.getQueryData<AccountStatementPageMetadata>([
    "account-statement",
    selectedCompany?.id,
    selectedAccount.type,
    selectedAccount.accountId,
    periodFilter.fromDate || null,
    periodFilter.toDate || null,
  ]);
  // Linked Factory customer accounts still appear as type "ledger". Use the
  // current statement's reactive customer identity, not a non-subscribed React
  // Query cache snapshot. Keep the column visible if returned customer rows
  // already carry destination metadata during query/cache transitions.
  const showCustomerDestination = shouldShowFactoryCustomerDestination({
    appMode,
    accountType: selectedAccount.type,
    statementCustomerId,
    destinations: vouchersWithBalance.map((row) => row.destination),
  });
  const [destinationFilter, setDestinationFilter] = useState("all");
  useEffect(() => {
    setDestinationFilter("all");
  }, [selectedCompany?.id, selectedAccount.type, selectedAccount.accountId]);
  const destinationOptions = useMemo(
    () =>
      [...new Set(vouchersWithBalance.map((row) => row.destination?.trim()).filter((s): s is string => !!s))].sort(
        (a, b) => a.localeCompare(b)
      ),
    [vouchersWithBalance]
  );
  const filteredCount =
    !showCustomerDestination || destinationFilter === "all"
      ? vouchersWithBalance.length
      : vouchersWithBalance.filter((row) =>
          destinationFilter === "__none__" ? !row.destination?.trim() : row.destination?.trim() === destinationFilter
        ).length;
  const destinationSelect = showCustomerDestination ? (
    <Select
      value={destinationFilter}
      onValueChange={(value) => {
        // A new filter must not retain bulk-delete selections from hidden rows.
        for (const voucherId of selectedVoucherIds) toggleVoucherSelection(voucherId);
        setDestinationFilter(value);
      }}
    >
      <SelectTrigger
        className="w-[190px] h-9"
        aria-label="Filter customer ledger by destination"
        data-testid="filter-customer-destination"
      >
        <SelectValue placeholder="All destinations" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All destinations</SelectItem>
        {destinationOptions.map((destination) => (
          <SelectItem key={destination} value={destination}>
            {destination}
          </SelectItem>
        ))}
        <SelectItem value="__none__">No destination</SelectItem>
      </SelectContent>
    </Select>
  ) : null;
  const rawOpeningBalance = Number.parseFloat(String(selectedAccount.openingBalance ?? 0)) || 0;
  const signedStoredOpening = selectedAccount.openingBalanceSide === "Cr" ? -rawOpeningBalance : rawOpeningBalance;
  const hasServerClosing = Number.isFinite(statementMetadata?.closingNetBalance);
  const isGoldenCoastFreshStart =
    selectedCompany?.companyType === "supplier_partner" && selectedAccount.subType === "gc_partner_capital";
  // Golden Coast Fresh Start is intentionally projected to Net Position in AccountsLegacy.
  // Every other paginated account uses the explicit server period aggregate carried by the
  // same React Query response, so financial totals no longer depend on the global pagination snapshot.
  const displayClosingBalance =
    !isGoldenCoastFreshStart && hasServerClosing
      ? signedStoredOpening +
        Number(statementMetadata?.closingNetBalance) +
        (Number(
          (
            statementMetadata as AccountStatementPageMetadata & {
              notInLedger?: { total?: string; prePeriodTotal?: string };
            }
          )?.notInLedger?.total ?? 0
        ) || 0) +
        (Number(
          (
            statementMetadata as AccountStatementPageMetadata & {
              notInLedger?: { total?: string; prePeriodTotal?: string };
            }
          )?.notInLedger?.prePeriodTotal ?? 0
        ) || 0)
      : closingBalance;

  const pdfTypeMap: Record<string, string> = {
    ledger: "ledger",
    bank: "bank",
    "bank-account": "bank",
    supplier: "supplier",
    employee: "employee",
    customer: "customer",
    "fixed-asset": "fixed-asset",
  };

  const buildPdfUrl = (lang: "en" | "fr" | "ar" = pdfLang) => {
    if (!selectedAccount) return null;
    if (isEurTab && fxWalletId) return fxEurStatementUrl(fxWalletId, periodFilter, ".pdf");
    const serverType = pdfTypeMap[selectedAccount.type] || "ledger";
    const params = new URLSearchParams({ lang });
    if (periodFilter?.fromDate) params.set("startDate", periodFilter.fromDate);
    if (periodFilter?.toDate) params.set("endDate", periodFilter.toDate);
    return `/api/accounts/${serverType}/${selectedAccount.accountId}/statement-pdf?${params.toString()}`;
  };

  const canExportExcel = ["ledger", "bank-account", "bank", "supplier", "employee"].includes(selectedAccount.type);
  const downloadStatementExcel = async (url: string, subject: string) => {
    try {
      await downloadFromUrl(url, {
        fileName: exportFileName(subject, "xlsx", { from: periodFilter?.fromDate, to: periodFilter?.toDate }),
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };
  return {
    canChangeExistingRecords,
    formatTransactionAmount,
    language,
    isFactorySupplierAccount,
    pdfLang,
    setPdfLang,
    isPhone,
    ledgerCompanyLabel,
    nativeWallet,
    fxWalletId,
    setFxTabChoice,
    hasFxTabs,
    isEurTab,
    statementMetadata,
    showCustomerDestination,
    destinationFilter,
    filteredCount,
    destinationSelect,
    displayClosingBalance,
    buildPdfUrl,
    canExportExcel,
    downloadStatementExcel,
  };
}
