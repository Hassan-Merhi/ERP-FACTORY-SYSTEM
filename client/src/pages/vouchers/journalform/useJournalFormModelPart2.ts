// Extracted from ./useJournalFormModel.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseDateLocal } from "@/components/vouchers/PrintTemplate";
import type { CombinedAccount } from "@/components/AccountAutocomplete";
import { formatNumber } from "@/lib/formatNumber";
import type { JournalFormData, JournalVoucherEntry } from "./types";
import { emptyJournal, useJournalFormModelPart1 } from "./useJournalFormModelPart1";

export function useJournalFormModelPart2({
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
}: Pick<
  Awaited<ReturnType<typeof useJournalFormModelPart1>>,
  | "activeJournalRow"
  | "allAccounts"
  | "bankAccounts"
  | "bankAccountsFetched"
  | "customers"
  | "customersFetched"
  | "employees"
  | "factorySuppliersList"
  | "fixedAssets"
  | "hydratedVoucherIdRef"
  | "journalForm"
  | "ledgerAccounts"
  | "ledgerAccountsFetched"
  | "setActiveJournalRowState"
  | "setJournalEffectiveDate"
  | "setLiveAccountSearch"
  | "sidebarAccounts"
  | "suppliers"
  | "suppliersFetched"
  | "voucherToEdit"
>) {
  const [showAccountSidebar, setShowAccountSidebar] = useState(false);
  const [journalAccountSearchTerm, setJournalAccountSearchTermState] = useState("");
  const [journalAccountHighlightedIndex, setJournalAccountHighlightedIndex] = useState(0);
  const journalSidebarRef = useRef<HTMLDivElement>(null);
  const [showCreateAccountModal, setShowCreateAccountModal] = useState(false);
  const [createAccountContext, setCreateAccountContext] = useState<{
    tab: "payment" | "receipt" | "journal";
    rowIndex?: number;
  } | null>(null);

  const isJournalAccountSearchFocused = () => {
    if (typeof document === "undefined") return false;
    const activeElement = document.activeElement as HTMLElement | null;
    const testId = activeElement?.getAttribute("data-testid") || "";
    return (
      testId === "input-journal-sidebar-search" ||
      testId.startsWith("input-journal-account-") ||
      testId.startsWith("input-journal-account-mobile-")
    );
  };

  // Journal row inputs still have legacy delayed blur callbacks. Guard the shared state
  // so an old 200ms blur cannot clear a newly focused row/sidebar search.
  const setActiveJournalRow = (nextRow: number | null) => {
    if (nextRow === null && isJournalAccountSearchFocused()) return;
    if (nextRow !== null) {
      setJournalAccountSearchTermState("");
      setJournalAccountHighlightedIndex(0);
    }
    setActiveJournalRowState(nextRow);
  };

  const setJournalAccountSearchTerm = (nextTerm: string) => {
    if (nextTerm === "" && isJournalAccountSearchFocused()) return;
    setJournalAccountSearchTermState(nextTerm);
  };

  useEffect(() => setLiveAccountSearch(journalAccountSearchTerm), [journalAccountSearchTerm, setLiveAccountSearch]);
  const filteredJournalAccounts = useMemo(() => {
    if (!journalAccountSearchTerm.trim()) return allAccounts;
    return allAccounts.filter((account) => searchAny(journalAccountSearchTerm, account.name, account.code));
  }, [allAccounts, journalAccountSearchTerm]);

  useEffect(() => {
    setJournalAccountHighlightedIndex((previous) => {
      if (filteredJournalAccounts.length === 0) return 0;
      return Math.min(previous, filteredJournalAccounts.length - 1);
    });
  }, [filteredJournalAccounts.length]);

  useEffect(() => {
    const sidebar = journalSidebarRef.current;
    if (!sidebar || activeJournalRow === null || filteredJournalAccounts.length === 0) return;
    const option = sidebar.querySelector(
      `[data-testid="journal-account-option-${journalAccountHighlightedIndex}"]`
    ) as HTMLElement | null;
    if (!option) return;

    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;
    const visibleTop = sidebar.scrollTop;
    const visibleBottom = visibleTop + sidebar.clientHeight;
    if (optionTop < visibleTop) sidebar.scrollTop = optionTop;
    else if (optionBottom > visibleBottom) sidebar.scrollTop = optionBottom - sidebar.clientHeight;
  }, [journalAccountHighlightedIndex, filteredJournalAccounts.length, activeJournalRow]);

  const focusVisibleJournalInput = (testIds: string[], select = false, delay = 50) => {
    setTimeout(() => {
      if (typeof document === "undefined") return;
      const candidates = testIds.flatMap(
        (testId) => Array.from(document.querySelectorAll(`[data-testid="${testId}"]`)) as HTMLInputElement[]
      );
      const input = candidates.find((candidate) => candidate.offsetParent !== null) || candidates[0];
      input?.focus();
      if (select) input?.select();
    }, delay);
  };

  const handleJournalAccountSelect = (account: CombinedAccount) => {
    if (activeJournalRow === null) return;
    const rowIndex = activeJournalRow;
    journalForm.setValue(`entries.${rowIndex}.accountType`, account.type);
    journalForm.setValue(`entries.${rowIndex}.accountId`, account.id);
    journalForm.setValue(`entries.${rowIndex}.accountName`, account.name);
    setJournalAccountSearchTermState("");
    setJournalAccountHighlightedIndex(0);
    setShowAccountSidebar(false);
    setActiveJournalRowState(null);
    focusVisibleJournalInput([`input-journal-amount-${rowIndex}`, `input-journal-amount-mobile-${rowIndex}`], true);
  };

  const getAccountBalance = (accountType: string, accountId: number): number =>
    sidebarAccounts.find((account) => account.type === accountType && account.id === accountId)?.balance ?? 0;

  const handleJournalTypeChange = (index: number, newType: "DR" | "CR") => {
    const currentEntries = journalForm.getValues("entries");
    const currentAmount = parseFloat(currentEntries[index]?.amount || "0");
    journalForm.setValue(`entries.${index}.type`, newType);
    if (newType === "CR") {
      const updated = currentEntries.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, type: newType } : entry
      );
      const debits = updated.reduce((sum, entry) => sum + (entry.type === "DR" ? parseFloat(entry.amount) || 0 : 0), 0);
      const otherCredits = updated.reduce(
        (sum, entry, entryIndex) =>
          entryIndex !== index && entry.type === "CR" ? sum + (parseFloat(entry.amount) || 0) : sum,
        0
      );
      const remaining = debits - otherCredits;
      if (currentAmount === 0 && remaining > 0) {
        journalForm.setValue(`entries.${index}.amount`, formatNumber(remaining));
      }
    }
    focusVisibleJournalInput([`input-journal-account-${index}`, `input-journal-account-mobile-${index}`], false);
  };

  useEffect(() => {
    const entries =
      voucherToEdit?.currency === "ZMW"
        ? voucherToEdit?.entries?.filter(
            (entry) => !(entry.transactionCurrency === "USD" && entry.narration === "Base currency rounding difference")
          )
        : voucherToEdit?.entries;
    if (!voucherToEdit || voucherToEdit.voucherType !== "Journal" || !entries?.length) return;
    if (hydratedVoucherIdRef.current === voucherToEdit.id) return;
    if (!ledgerAccountsFetched || !bankAccountsFetched) return;
    if (entries.some((entry) => entry.factorySupplierId) && factorySuppliersList.length === 0) return;
    if (entries.some((entry) => entry.supplierId) && !suppliersFetched) return;
    if (entries.some((entry) => entry.customerId) && !customersFetched) return;

    const formEntries: JournalFormData["entries"] = entries.map((entry: JournalVoucherEntry) => {
      let accountType: JournalFormData["entries"][number]["accountType"] = "ledger";
      let accountId = 0;
      let accountName = "";
      if (entry.bankAccountId) {
        accountType = "bank";
        accountId = entry.bankAccountId;
        accountName = bankAccounts.find((account) => account.id === accountId)?.bankName || "";
      } else if (entry.ledgerAccountId) {
        accountId = entry.ledgerAccountId;
        accountName = ledgerAccounts.find((account) => account.id === accountId)?.name || "";
      } else if (entry.supplierId) {
        accountType = "supplier";
        accountId = entry.supplierId;
        accountName = suppliers.find((supplier) => supplier.id === accountId)?.legalName || "";
      } else if (entry.factorySupplierId) {
        accountType = "factorySupplier";
        accountId = entry.factorySupplierId;
        accountName = factorySuppliersList.find((supplier) => supplier.id === accountId)?.name || "";
      } else if (entry.employeeId) {
        accountType = "employee";
        accountId = entry.employeeId;
        const employee = employees.find((candidate) => candidate.id === accountId);
        accountName = employee ? `${employee.firstName} ${employee.lastName}` : "";
      } else if (entry.fixedAssetId) {
        accountType = "fixedAsset";
        accountId = entry.fixedAssetId;
        accountName = fixedAssets.find((asset) => asset.id === accountId)?.name || "";
      } else if (entry.customerId) {
        accountType = "customer";
        accountId = entry.customerId;
        accountName = customers.find((customer) => customer.id === accountId)?.legalName || "";
      }
      const usesLockedZmw = voucherToEdit.currency === "ZMW";
      const debit = parseFloat(String((usesLockedZmw ? entry.transactionDebitAmount : entry.debitAmount) || "0"));
      const credit = parseFloat(String((usesLockedZmw ? entry.transactionCreditAmount : entry.creditAmount) || "0"));
      return {
        type: debit > 0 ? "DR" : "CR",
        accountType,
        accountId,
        accountName,
        amount: String(debit > 0 ? debit : credit),
        narration: entry.narration || "",
      };
    });
    if (formEntries.some((entry) => entry.accountId > 0 && entry.accountName === "")) return;

    journalForm.reset({
      voucherDate: parseDateLocal(voucherToEdit.voucherDate),
      entries: formEntries.length ? formEntries : emptyJournal().entries,
      notes: voucherToEdit.description ?? voucherToEdit.notes ?? "",
      optional: voucherToEdit.optional || false,
    });
    setJournalEffectiveDate(voucherToEdit.effectiveDate || "");
    hydratedVoucherIdRef.current = voucherToEdit.id;
  }, [
    voucherToEdit,
    allAccounts,
    bankAccounts,
    bankAccountsFetched,
    ledgerAccounts,
    ledgerAccountsFetched,
    suppliers,
    suppliersFetched,
    employees,
    fixedAssets,
    customers,
    customersFetched,
    factorySuppliersList,
    journalForm,
    hydratedVoucherIdRef,
    setJournalEffectiveDate,
  ]);
  return {
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
  };
}
