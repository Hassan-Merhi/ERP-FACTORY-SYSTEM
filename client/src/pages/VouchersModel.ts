// Extracted from ./Vouchers.tsx: state, queries and handlers for Vouchers.
import { useEffect } from "react";
import { format } from "date-fns";
import { useReactToPrint } from "react-to-print";
import type { Account } from "@/components/AccountSidebar";
import { queryClient } from "@/lib/queryClient";
import { useSendWaStatementMutation } from "./vouchersPageSupport";
import type { VouchersProps } from "./vouchersPageSupport";
import { useVoucherFxWalletPayment } from "@/pages/vouchers/useVoucherFxWalletPayment";
import { useVoucherHandlers } from "@/pages/vouchers/useVoucherHandlers";
import { useVoucherSaveMutation } from "@/pages/vouchers/useVoucherSaveMutation";
import { useSidebarSync } from "@/pages/vouchers/useSidebarSync";
import { useAccountBalance } from "@/pages/vouchers/useAccountBalance";
import { useNormalIntercompanyVoucher } from "@/pages/vouchers/useNormalIntercompanyVoucher";
import { exportVoucherHelper } from "@/pages/vouchers/voucherActions";
import type { VoucherFormData } from "@/pages/vouchers/voucherTypes";
import { useVouchersFormModel } from "./VouchersFormModel";

export function useVouchersModel({ posUser }: { posUser: VouchersProps["posUser"] }) {
  const f = useVouchersFormModel({ posUser });

  const paymentAccountType = f.form.watch("paymentAccountType");
  const paymentAccountId = f.form.watch("paymentAccountId");
  const paymentAccountName = f.form.watch("paymentAccountName");
  // Normal Payment/Receipt detects only verified intercompany account IDs.
  // Any paired posting uses the existing atomic, two-company service.
  const normalIntercompany = useNormalIntercompanyVoucher({
    companyId: f.selectedCompany?.id ?? 0,
    enabled:
      f.canUseIntercompanyVouchers &&
      !f.isPOS &&
      !f.voucherIdToEdit &&
      (f.activeTab === "payment" || f.activeTab === "receipt"),
    voucherType: f.activeTab === "receipt" ? "Receipt" : "Payment",
    paymentAccountType,
    paymentAccountId,
    entries: f.entries,
  });

  const { filteredSidebarAccounts, selectedAccount } = useSidebarSync({
    sidebarAccounts: f.sidebarAccounts,
    sidebarSearchValue: f.sidebarSearchValue,
    paymentAccountId,
    paymentAccountType,
    sidebarHighlightedIndex: f.sidebarHighlightedIndex,
    setSidebarHighlightedIndex: f.setSidebarHighlightedIndex,
    entries: f.entries,
    activeRowIndex: f.activeRowIndex,
    allAccounts: f.allAccounts,
  });

  const { accountBalance, accountCurrencyBalances } = useAccountBalance({
    paymentAccountType,
    paymentAccountId,
    bankAccounts: f.bankAccounts,
    selectedAccountOpeningBalance: selectedAccount?.openingBalance,
    sidebarAccounts: f.sidebarAccounts,
  });

  const { handleSidebarAccountSelect, handleAmountCommit, handleAutoCreateAccount } = useVoucherHandlers({
    form: f.form,
    append: f.append,
    activeRowIndex: f.activeRowIndex,
    setActiveRowIndex: f.setActiveRowIndex,
    sidebarAccounts: f.sidebarAccounts,
    selectedCompany: f.selectedCompany,
    setIsAutoCreating: f.setIsAutoCreating,
    queryClient,
    toast: f.toast,
    setSelectedAccountId: f.setSelectedAccountId,
    setSelectedAccountType: f.setSelectedAccountType,
    setSidebarSearchValue: f.setSidebarSearchValue,
    setSidebarHighlightedIndex: f.setSidebarHighlightedIndex,
  });

  const {
    fxWalletsLoading,
    selectedFxWallet,
    isWalletPayment,
    fxPaymentRate,
    setFxPaymentRate,
    fxPayoutCurrency,
    fxSupplierId,
    fxSupplierEurBalance,
    fxSupplierEurBasis,
    fxSupplierBalanceLoading,
    changeFxPayoutCurrency,
    paymentPayFromAccounts,
    postWalletPayment,
    confirmWalletPayment,
    resetWalletPayment,
  } = useVoucherFxWalletPayment({
    selectedCompany: f.selectedCompany,
    isFactoryMode: f.isFactoryMode,
    isFactoryCompany: f.isFactoryCompany,
    isPOS: f.isPOS,
    activeTab: f.activeTab,
    voucherIdToEdit: f.voucherIdToEdit,
    paymentAccountType,
    paymentAccountId,
    entries: f.entries,
    form: f.form,
    payFromAccounts: f.payFromAccounts,
  });

  const saveMutation = useVoucherSaveMutation({
    activeTab: f.activeTab,
    voucherIdToEdit: f.voucherIdToEdit,
    isWalletPayment,
    postWalletPayment,
    resetWalletPayment,
    selectedCurrency: f.selectedCurrency,
    voucherEffectiveDate: f.voucherEffectiveDate,
    modeApiRequest: f.modeApiRequest,
    paymentPostingCurrency: f.paymentPostingCurrency,
    paymentPostingRate: f.paymentPostingRate,
    paymentAccountType,
    paymentAccountId,
    selectedCompany: f.selectedCompany,
    modePrefix: f.modePrefix,
    setLocation: f.setLocation,
    form: f.form,
    toast: f.toast,
    setWaPendingPrompt: f.setWaPendingPrompt,
    discardPaymentDraft: f.discardPaymentDraft,
  });

  const sendWaStatementMutation = useSendWaStatementMutation({
    appMode: f.appMode,
    modeApiRequest: f.modeApiRequest,
    toast: f.toast,
    setWaPendingPrompt: f.setWaPendingPrompt,
  });

  const handleOpenCreateAccountModal = (tab: "payment" | "receipt" | "journal", rowIndex?: number) => {
    f.setCreateAccountContext({ tab, rowIndex });
    f.setShowCreateAccountModal(true);
  };

  const handleAccountCreated = async (account: { id: number; name: string; type: string }) => {
    if (!f.createAccountContext) return;
    if (f.createAccountContext.tab === "payment" || f.createAccountContext.tab === "receipt") {
      const accountObj: Account = {
        id: account.id,
        name: account.name,
        type: account.type as
          "customer" | "ledger" | "bank" | "supplier" | "employee" | "fixedAsset" | "factorySupplier",
        code: "",
      };
      handleSidebarAccountSelect(accountObj);
    }
    f.setCreateAccountContext(null);
  };

  const { activeRowIndex, watchedEntries, setSidebarSearchValue, setSidebarHighlightedIndex } = f;
  useEffect(() => {
    if (activeRowIndex !== null) {
      const activeEntry = watchedEntries[activeRowIndex];
      if (activeEntry) {
        setSidebarSearchValue(activeEntry.accountName || "");
        setSidebarHighlightedIndex(0);
      }
    }
  }, [watchedEntries, activeRowIndex, setSidebarSearchValue, setSidebarHighlightedIndex]);

  const restorePaymentDraft = () => {
    if (f.paymentDraft?.data) {
      const d = f.paymentDraft.data as unknown as object & { voucherDate: unknown } & {
        voucherDate: string | number | Date;
      };
      f.form.reset({ ...d, voucherDate: d.voucherDate ? new Date(d.voucherDate) : new Date() });
    }
    f.discardPaymentDraft();
  };

  const handlePrint = useReactToPrint({
    contentRef: f.printRef,
    documentTitle: `${f.activeTab === "payment" ? "Payment" : "Receipt"}-Voucher-${format(f.form.watch("voucherDate"), "yyyy-MM-dd")}`,
  });

  const handleExportVoucher = (detailed: boolean) =>
    exportVoucherHelper({ formData: f.form.getValues(), activeTab: f.activeTab, toast: f.toast, detailed });

  const onSubmit = async (data: VoucherFormData) => {
    if (f.paymentPostingCurrency === "ZMW" && (!f.paymentPostingRate || f.paymentPostingRate <= 0)) {
      f.toast({
        title: "Approved USD/ZMW rate required",
        description: "Enter a company exchange rate effective on the voucher date before posting.",
        variant: "destructive",
      });
      return;
    }
    const validEntries = data.entries.filter((entry) => entry.accountId > 0 && parseFloat(entry.amount || "0") > 0);
    if (validEntries.length === 0) {
      f.toast({
        title: "Validation Error",
        description: "Please add at least one entry with an account and a positive amount.",
        variant: "destructive",
      });
      return;
    }
    const totalDebits = validEntries.reduce((sum, entry) => {
      const amount = parseFloat(entry.amount);
      return sum + (isNaN(amount) ? 0 : amount);
    }, 0);
    if (isNaN(totalDebits) || totalDebits <= 0) {
      f.toast({
        title: "Validation Error",
        description: "Invalid amounts detected. Please check your entries.",
        variant: "destructive",
      });
      return;
    }
    let intercompanyMirror;
    try {
      intercompanyMirror = normalIntercompany.buildMirror();
    } catch (error) {
      f.toast({
        title: "Verify linked company transfer",
        description: error instanceof Error ? error.message : "Verify the actual bank/cash accounts.",
        variant: "destructive",
      });
      return;
    }
    if (intercompanyMirror && isWalletPayment) {
      f.toast({
        title: "Choose a normal bank/cash account",
        description: "FX wallet settlement cannot also post a paired intercompany cash transfer.",
        variant: "destructive",
      });
      return;
    }
    if (isWalletPayment && !(await confirmWalletPayment(validEntries, f.toast))) return;
    saveMutation.mutate({
      ...data,
      entries: validEntries,
      ...(intercompanyMirror ? { intercompanyMirror } : {}),
    });
  };

  return {
    selectedCompany: f.selectedCompany,
    modeApiRequest: f.modeApiRequest,
    isFactoryCompany: f.isFactoryCompany,
    isAutoCreating: f.isAutoCreating,
    formatAmount: f.formatAmount,
    selectedCurrency: f.selectedCurrency,
    transactionRate: f.transactionRate,
    setTransactionRate: f.setTransactionRate,
    voucherEffectiveDate: f.voucherEffectiveDate,
    setVoucherEffectiveDate: f.setVoucherEffectiveDate,
    setLocation: f.setLocation,
    printRef: f.printRef,
    isPOS: f.isPOS,
    showOptionalDrafts: f.showOptionalDrafts,
    voucherIdToEdit: f.voucherIdToEdit,
    editVoucherId: f.editVoucherId,
    setAccountPickersNeeded: f.setAccountPickersNeeded,
    isFactoryMode: f.isFactoryMode,
    visibleSidebarGroups: f.visibleSidebarGroups,
    visibleVoucherTabs: f.visibleVoucherTabs,
    canShowVoucherTab: f.canShowVoucherTab,
    activeTab: f.activeTab,
    setActiveTab: f.setActiveTab,
    sidebarSearchValue: f.sidebarSearchValue,
    setSidebarSearchValue: f.setSidebarSearchValue,
    sidebarHighlightedIndex: f.sidebarHighlightedIndex,
    setSidebarHighlightedIndex: f.setSidebarHighlightedIndex,
    selectedAccountId: f.selectedAccountId,
    selectedAccountType: f.selectedAccountType,
    activeRowIndex: f.activeRowIndex,
    setActiveRowIndex: f.setActiveRowIndex,
    waPendingPrompt: f.waPendingPrompt,
    setWaPendingPrompt: f.setWaPendingPrompt,
    showCreateAccountModal: f.showCreateAccountModal,
    setShowCreateAccountModal: f.setShowCreateAccountModal,
    setCreateAccountContext: f.setCreateAccountContext,
    bankAccountsError: f.bankAccountsError,
    refetchBankAccounts: f.refetchBankAccounts,
    ledgerAccountsError: f.ledgerAccountsError,
    refetchLedgerAccounts: f.refetchLedgerAccounts,
    sidebarAccounts: f.sidebarAccounts,
    sidebarAccountsError: f.sidebarAccountsError,
    refetchSidebarAccounts: f.refetchSidebarAccounts,
    voucherToEdit: f.voucherToEdit,
    allAccounts: f.allAccounts,
    payFromAccounts: f.payFromAccounts,
    setLiveAccountSearch: f.setLiveAccountSearch,
    form: f.form,
    fieldArray: f.fieldArray,
    entries: f.entries,
    paymentPostingCurrency: f.paymentPostingCurrency,
    paymentPostingRate: f.paymentPostingRate,
    total: f.total,
    originalTotal: f.originalTotal,
    hasPaymentDraft: f.hasPaymentDraft,
    paymentDraftAge: f.paymentDraftAge,
    discardPaymentDraft: f.discardPaymentDraft,
    paymentAccountType,
    paymentAccountId,
    paymentAccountName,
    normalIntercompany,
    filteredSidebarAccounts,
    accountBalance,
    accountCurrencyBalances,
    handleSidebarAccountSelect,
    handleAmountCommit,
    handleAutoCreateAccount,
    fxWalletsLoading,
    selectedFxWallet,
    fxPaymentRate,
    setFxPaymentRate,
    fxPayoutCurrency,
    fxSupplierId,
    fxSupplierEurBalance,
    fxSupplierEurBasis,
    fxSupplierBalanceLoading,
    changeFxPayoutCurrency,
    paymentPayFromAccounts,
    saveMutation,
    sendWaStatementMutation,
    handleOpenCreateAccountModal,
    handleAccountCreated,
    restorePaymentDraft,
    handlePrint,
    handleExportVoucher,
    onSubmit,
  };
}

export type VouchersModel = ReturnType<typeof useVouchersModel>;
