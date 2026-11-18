import { type KeyboardEvent } from "react";
import type { JournalFormData, JournalFormProps } from "./types";
import { emptyJournal, useJournalFormModelPart1 } from "./useJournalFormModelPart1";
import { useJournalFormModelPart2 } from "./useJournalFormModelPart2";
import { useJournalFormModelPart3 } from "./useJournalFormModelPart3";

export function useJournalFormModel(props: JournalFormProps) {
  const {
    activeJournalRow,
    allAccounts,
    appMode,
    appendJournal,
    bankAccounts,
    bankAccountsFetched,
    convertToUSD,
    customers,
    customersFetched,
    discardJournalDraft,
    employees,
    factorySuppliersList,
    fixedAssets,
    formatAmount,
    hasJournalDraft,
    hydratedVoucherIdRef,
    isPOS,
    journalDraft,
    journalDraftAge,
    journalEffectiveDate,
    journalEntries,
    journalFields,
    journalForm,
    ledgerAccounts,
    ledgerAccountsFetched,
    modeApiRequest,
    modePrefix,
    postingRate,
    removeJournal,
    selectedCompany,
    selectedCurrency,
    setAccountPickersNeeded,
    setActiveJournalRowState,
    setJournalEffectiveDate,
    setLiveAccountSearch,
    setLocation,
    setTransactionRate,
    setWaPendingPrompt,
    sidebarAccounts,
    suppliers,
    suppliersFetched,
    toast,
    totalCredit,
    totalDebit,
    transactionRate,
    voucherIdToEdit,
    voucherToEdit,
    waPendingPrompt,
  } = useJournalFormModelPart1(props);
  const {
    createAccountContext,
    filteredJournalAccounts,
    focusVisibleJournalInput,
    getAccountBalance,
    handleJournalAccountSelect,
    handleJournalTypeChange,
    journalAccountHighlightedIndex,
    journalAccountSearchTerm,
    journalSidebarRef,
    setActiveJournalRow,
    setCreateAccountContext,
    setJournalAccountHighlightedIndex,
    setJournalAccountSearchTerm,
    setJournalAccountSearchTermState,
    setShowAccountSidebar,
    setShowCreateAccountModal,
    showAccountSidebar,
    showCreateAccountModal,
  } = useJournalFormModelPart2({
    activeJournalRow,
    allAccounts,
    bankAccounts,
    bankAccountsFetched,
    customers,
    customersFetched,
    employees,
    factorySuppliersList,
    fixedAssets,
    hydratedVoucherIdRef,
    journalForm,
    ledgerAccounts,
    ledgerAccountsFetched,
    setActiveJournalRowState,
    setJournalEffectiveDate,
    setLiveAccountSearch,
    sidebarAccounts,
    suppliers,
    suppliersFetched,
    voucherToEdit,
  });
  const { handleExportJournalVoucher, journalMutation, onJournalSubmit, sendWaStatementMutation } =
    useJournalFormModelPart3({
      appMode,
      discardJournalDraft,
      formatAmount,
      journalEffectiveDate,
      journalForm,
      modeApiRequest,
      modePrefix,
      postingRate,
      selectedCompany,
      selectedCurrency,
      setLocation,
      setWaPendingPrompt,
      toast,
      totalCredit,
      totalDebit,
      voucherIdToEdit,
    });
  const { handleAccountCreated, handleJournalKeyDown, handleOpenCreateAccountModal, restoreJournalDraft } =
    useJournalFormModelPart4({
      appendJournal,
      createAccountContext,
      discardJournalDraft,
      focusVisibleJournalInput,
      journalDraft,
      journalFields,
      journalForm,
      setActiveJournalRowState,
      setCreateAccountContext,
      setJournalAccountSearchTermState,
      setShowAccountSidebar,
      setShowCreateAccountModal,
    });

  return {
    isPOS,
    voucherIdToEdit,
    selectedCompany,
    modeApiRequest,
    selectedCurrency,
    convertToUSD,
    formatAmount,
    transactionRate: selectedCurrency === "ZMW" ? postingRate : transactionRate,
    setTransactionRate,
    journalEffectiveDate,
    setJournalEffectiveDate,
    voucherToEdit,
    journalForm,
    journalFields,
    appendJournal,
    removeJournal,
    journalEntries,
    totalDebit,
    totalCredit,
    hasJournalDraft,
    journalDraftAge,
    discardJournalDraft,
    restoreJournalDraft,
    activeJournalRow,
    setActiveJournalRow,
    showAccountSidebar,
    setShowAccountSidebar,
    journalAccountSearchTerm,
    setJournalAccountSearchTerm,
    journalAccountHighlightedIndex,
    setJournalAccountHighlightedIndex,
    journalSidebarRef,
    filteredJournalAccounts,
    handleJournalAccountSelect,
    getAccountBalance,
    handleJournalTypeChange,
    handleJournalKeyDown,
    onJournalSubmit,
    journalMutation,
    handleExportJournalVoucher,
    setAccountPickersNeeded,
    showCreateAccountModal,
    setShowCreateAccountModal,
    createAccountContext,
    setCreateAccountContext,
    handleOpenCreateAccountModal,
    handleAccountCreated,
    waPendingPrompt,
    setWaPendingPrompt,
    sendWaStatementMutation,
  };
}

function useJournalFormModelPart4({
  appendJournal,
  createAccountContext,
  discardJournalDraft,
  focusVisibleJournalInput,
  journalDraft,
  journalFields,
  journalForm,
  setActiveJournalRowState,
  setCreateAccountContext,
  setJournalAccountSearchTermState,
  setShowAccountSidebar,
  setShowCreateAccountModal,
}: Pick<
  Awaited<ReturnType<typeof useJournalFormModelPart1>> & Awaited<ReturnType<typeof useJournalFormModelPart2>>,
  | "appendJournal"
  | "createAccountContext"
  | "discardJournalDraft"
  | "focusVisibleJournalInput"
  | "journalDraft"
  | "journalFields"
  | "journalForm"
  | "setActiveJournalRowState"
  | "setCreateAccountContext"
  | "setJournalAccountSearchTermState"
  | "setShowAccountSidebar"
  | "setShowCreateAccountModal"
>) {
  const handleJournalKeyDown = (event: KeyboardEvent, rowIndex: number, fieldName: "type" | "account" | "amount") => {
    const isLastRow = rowIndex === journalFields.length - 1;
    const focus = (selector: string, select = false, delay = 50) =>
      setTimeout(() => {
        const element = document.querySelector(selector) as HTMLInputElement | null;
        element?.focus();
        if (select) element?.select();
      }, delay);
    if (fieldName === "amount") {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (rowIndex > 0) focus(`[data-testid="input-journal-amount-${rowIndex - 1}"]`, true);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (rowIndex < journalFields.length - 1) focus(`[data-testid="input-journal-amount-${rowIndex + 1}"]`, true);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        focus(`[data-testid="input-journal-account-${rowIndex}"]`);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (rowIndex < journalFields.length - 1) focus(`[data-testid="input-journal-type-${rowIndex + 1}"]`);
        return;
      }
    }
    if (fieldName === "amount" && event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      if (isLastRow)
        appendJournal({ type: "DR", accountType: "ledger", accountId: 0, accountName: "", amount: "", narration: "" });
      focus(`[data-testid="input-journal-type-${rowIndex + 1}"]`, false, 100);
    }
    if (fieldName === "amount" && event.key === "Enter") {
      event.preventDefault();
      if (isLastRow) {
        appendJournal({ type: "DR", accountType: "ledger", accountId: 0, accountName: "", amount: "", narration: "" });
        focus(`[data-testid="input-journal-type-${rowIndex + 1}"]`, false, 100);
      } else focus(`[data-testid="input-journal-type-${rowIndex + 1}"]`);
    }
  };

  const handleOpenCreateAccountModal = (tab: "payment" | "receipt" | "journal", rowIndex?: number) => {
    setCreateAccountContext({ tab, rowIndex });
    setShowCreateAccountModal(true);
  };
  const handleAccountCreated = (account: { id: number; name: string; type: string }) => {
    if (!createAccountContext) return;
    if (createAccountContext.tab === "journal" && createAccountContext.rowIndex !== undefined) {
      const rowIndex = createAccountContext.rowIndex;
      journalForm.setValue(`entries.${rowIndex}.accountType`, "ledger");
      journalForm.setValue(`entries.${rowIndex}.accountId`, account.id);
      journalForm.setValue(`entries.${rowIndex}.accountName`, account.name);
      setJournalAccountSearchTermState("");
      setActiveJournalRowState(null);
      setShowAccountSidebar(false);
      focusVisibleJournalInput(
        [`input-journal-amount-${rowIndex}`, `input-journal-amount-mobile-${rowIndex}`],
        true,
        0
      );
    }
    setCreateAccountContext(null);
  };

  const restoreJournalDraft = () => {
    const data = journalDraft?.data;
    if (typeof data === "object" && data !== null) {
      const draft = data as Partial<JournalFormData> & { voucherDate?: string | Date };
      const rawDate = draft.voucherDate;
      const voucherDate = rawDate instanceof Date ? rawDate : rawDate ? new Date(rawDate) : new Date();
      journalForm.reset({ ...emptyJournal(), ...draft, voucherDate });
    }
    discardJournalDraft();
  };
  return { handleAccountCreated, handleJournalKeyDown, handleOpenCreateAccountModal, restoreJournalDraft };
}
