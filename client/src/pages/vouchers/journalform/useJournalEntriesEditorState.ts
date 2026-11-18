// Extracted from ./JournalEntriesEditor.tsx to keep that module under the source-size cap.
import { useEffect, useRef } from "react";
import type { useJournalFormModel } from "./useJournalFormModel";

export type Model = ReturnType<typeof useJournalFormModel>;

export function focusInput(selector: string, select = false, delay = 50) {
  setTimeout(() => {
    if (typeof document === "undefined") return;
    const element = document.querySelector(selector) as HTMLInputElement | null;
    element?.focus();
    if (select) element?.select();
  }, delay);
}

export function useJournalEntriesEditorState({ model }: { model: Model }) {
  const {
    journalForm,
    journalFields,
    journalEntries,
    appendJournal,
    removeJournal,
    getAccountBalance,
    handleJournalTypeChange,
    activeJournalRow,
    setActiveJournalRow,
    journalAccountSearchTerm,
    setJournalAccountSearchTerm,
    setJournalAccountHighlightedIndex,
    filteredJournalAccounts,
    handleJournalAccountSelect,
    setShowAccountSidebar,
    setAccountPickersNeeded,
    journalAccountHighlightedIndex,
    handleJournalKeyDown,
    selectedCurrency,
    convertToUSD,
    formatAmount,
    totalDebit,
    totalCredit,
    handleExportJournalVoucher,
    journalMutation,
    voucherIdToEdit,
  } = model;
  const isBalanced = Math.abs(totalDebit - totalCredit) <= 0.01;

  const pendingBlurTimeouts = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(
    () => () => {
      for (const timeout of pendingBlurTimeouts.current) clearTimeout(timeout);
      pendingBlurTimeouts.current.clear();
    },
    []
  );

  const scheduleAccountBlur = (index: number) => {
    const timeout = setTimeout(() => {
      pendingBlurTimeouts.current.delete(timeout);
      if (activeJournalRow === index) {
        setJournalAccountSearchTerm("");
        setActiveJournalRow(null);
      }
    }, 200);
    pendingBlurTimeouts.current.add(timeout);
  };
  return {
    activeJournalRow,
    appendJournal,
    convertToUSD,
    filteredJournalAccounts,
    formatAmount,
    getAccountBalance,
    handleExportJournalVoucher,
    handleJournalAccountSelect,
    handleJournalKeyDown,
    handleJournalTypeChange,
    isBalanced,
    journalAccountHighlightedIndex,
    journalAccountSearchTerm,
    journalEntries,
    journalFields,
    journalForm,
    journalMutation,
    model,
    removeJournal,
    scheduleAccountBlur,
    selectedCurrency,
    setAccountPickersNeeded,
    setActiveJournalRow,
    setJournalAccountHighlightedIndex,
    setJournalAccountSearchTerm,
    setShowAccountSidebar,
    totalCredit,
    totalDebit,
    voucherIdToEdit,
  };
}
