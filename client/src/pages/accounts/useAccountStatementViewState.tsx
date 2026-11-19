// Extracted from ./AccountStatementView.tsx to keep that module under the source-size cap.
import { useMemo } from "react";
import { fxEurStatementUrl } from "./FxAgentEurStatement";
import type { AccountStatementViewProps } from "./AccountStatementViewTypes";
import { useAccountStatementViewStatePart1 } from "./useAccountStatementViewStatePart1";

export function useAccountStatementViewState({
  selectedAccount,
  onClose,
  periodFilter,
  setPeriodFilter,
  vouchersWithBalance,
  statementCustomerId,
  closingBalance,
  openingBalance,
  transactionsLoading,
  selectedVoucherIds,
  toggleSelectAll,
  setShowBulkDeleteConfirm,
  showDeletedVouchers,
  setShowDeletedVouchers,
  formatAmount,
  hideBalances,
  printRef,
  appMode,
  formatDisplayDate,
  toggleVoucherSelection,
  handleOpenVoucher,
  openWaRuleDialog,
  waRule,
  sendWaStatementMutation,
  isBrokerSupplier,
  factoryStatementLoading,
  brokerStatementLoading,
  transactionError,
}: AccountStatementViewProps) {
  const {
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
  } = useAccountStatementViewStatePart1({
    selectedAccount,
    periodFilter,
    vouchersWithBalance,
    statementCustomerId,
    closingBalance,
    selectedVoucherIds,
    appMode,
    toggleVoucherSelection,
  });
  const exportExcel = () => {
    if (isEurTab && fxWalletId) {
      void downloadStatementExcel(
        fxEurStatementUrl(fxWalletId, periodFilter, ".xlsx"),
        `account statement EUR ${selectedAccount.name}`
      );
      return;
    }
    const typeMap: Record<string, string> = {
      ledger: "ledger",
      bank: "bank",
      "bank-account": "bank",
      supplier: "supplier",
      employee: "employee",
    };
    const serverType = typeMap[selectedAccount.type] || "ledger";
    const params = new URLSearchParams({
      accountType: serverType,
      accountId: String(selectedAccount.accountId),
    });
    if (periodFilter?.fromDate) params.set("startDate", periodFilter.fromDate);
    if (periodFilter?.toDate) params.set("endDate", periodFilter.toDate);
    void downloadStatementExcel(
      `/api/accounts/statement/export-excel?${params.toString()}`,
      `account statement ${selectedAccount.name}`
    );
  };
  const sendWaStatement = () => {
    const month = periodFilter?.toDate ? periodFilter.toDate.substring(0, 7) : new Date().toISOString().substring(0, 7);
    sendWaStatementMutation.mutate({ accountId: selectedAccount.accountId, month });
  };
  const openPdf = (lang: "en" | "fr" | "ar") => {
    const url = buildPdfUrl(lang);
    if (url) window.open(url, "_blank");
  };
  // Rule changes and statement sends are business writes; read-only roles do not see them.
  const showWhatsApp = canChangeExistingRecords && (appMode === "factory" || appMode === "erp");
  // The phone header's one-tap PDF follows the interface language; other languages stay in the menu.
  const phonePdfLanguage: "en" | "fr" | "ar" = language === "ar" || language === "fr" ? language : "en";

  const totalDebit = useMemo(
    () =>
      Number.isFinite(statementMetadata?.periodDebitTotal)
        ? Number(statementMetadata?.periodDebitTotal)
        : vouchersWithBalance.reduce((s, v) => s + (v.totalDebit || 0), 0),
    [statementMetadata?.periodDebitTotal, vouchersWithBalance]
  );
  const totalCredit = useMemo(
    () =>
      Number.isFinite(statementMetadata?.periodCreditTotal)
        ? Number(statementMetadata?.periodCreditTotal)
        : vouchersWithBalance.reduce((s, v) => s + (v.totalCredit || 0), 0),
    [statementMetadata?.periodCreditTotal, vouchersWithBalance]
  );
  const transactionCount = Number.isFinite(statementMetadata?.total)
    ? Number(statementMetadata?.total)
    : vouchersWithBalance.length;

  const balSide = (val: number) => (val >= 0 ? "Dr" : "Cr");
  const openingSide =
    selectedAccount.type === "supplier" ? (openingBalance > 0 ? "Cr" : "Dr") : balSide(openingBalance);
  const showNativeBalance = !!nativeWallet?.synchronized;
  return {
    appMode,
    balSide,
    brokerStatementLoading,
    buildPdfUrl,
    canChangeExistingRecords,
    canExportExcel,
    destinationFilter,
    destinationSelect,
    displayClosingBalance,
    exportExcel,
    factoryStatementLoading,
    filteredCount,
    formatAmount,
    formatDisplayDate,
    formatTransactionAmount,
    fxWalletId,
    handleOpenVoucher,
    hasFxTabs,
    hideBalances,
    isBrokerSupplier,
    isEurTab,
    isFactorySupplierAccount,
    isPhone,
    ledgerCompanyLabel,
    nativeWallet,
    onClose,
    openPdf,
    openWaRuleDialog,
    openingBalance,
    openingSide,
    pdfLang,
    periodFilter,
    phonePdfLanguage,
    printRef,
    selectedAccount,
    selectedVoucherIds,
    sendWaStatement,
    sendWaStatementMutation,
    setFxTabChoice,
    setPdfLang,
    setPeriodFilter,
    setShowBulkDeleteConfirm,
    setShowDeletedVouchers,
    showCustomerDestination,
    showDeletedVouchers,
    showNativeBalance,
    showWhatsApp,
    toggleSelectAll,
    toggleVoucherSelection,
    totalCredit,
    totalDebit,
    transactionCount,
    transactionError,
    transactionsLoading,
    vouchersWithBalance,
    waRule,
  };
}
