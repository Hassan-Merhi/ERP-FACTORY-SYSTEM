// Extracted from ./VoucherEntriesTable.tsx to keep that module under the source-size cap.
import { useEffect, useRef, useState } from "react";
import type { Account } from "@/components/AccountSidebar";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { focusScopedTestId } from "@/lib/scopedFocus";
import type { VoucherEntriesTableProps } from "./VoucherEntriesTableTypes";

export function useVoucherEntriesTableState({
  form,
  fieldArray,
  entries,
  total,
  amountCurrencyOverride,
  mode,
  onAmountCommit,
  activeRow,
  filteredSidebarAccounts,
  sidebarHighlightedIndex,
  setSidebarHighlightedIndex,
  setSidebarSearchValue,
  handleSidebarAccountSelect,
  sidebarAccounts = [],
  onRowFocus,
  onRowBlur,
  isFactoryCompany = false,
  onAutoCreateAccount,
}: VoucherEntriesTableProps) {
  const { fields, append, remove } = fieldArray;
  const { formatAmount, selectedCurrency, convertToUSD } = useCurrencyContext();
  const formatEntryAmount = (value: number) =>
    amountCurrencyOverride === "EUR" ? `EUR ${value.toFixed(2)}` : formatAmount(value);

  const [mobileEditIndex, setMobileEditIndex] = useState<number | null>(null);
  const [mobileEditOpen, setMobileEditOpen] = useState(false);
  const [mobileSearch, setMobileSearch] = useState("");
  const [mobileAmountStr, setMobileAmountStr] = useState("");
  const [mobileNarration, setMobileNarration] = useState("");
  const mobileAmountInputRef = useRef<HTMLInputElement>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);
  const initializedMobileEditIndexRef = useRef<number | null>(null);

  useEffect(() => {
    if (!mobileEditOpen || mobileEditIndex === null) {
      initializedMobileEditIndexRef.current = null;
      return;
    }

    // PaymentReceiptTab passes onRowFocus inline, so its identity changes whenever
    // sidebar search state changes. Do not re-initialize this sheet on those
    // rerenders or every keystroke in the mobile search box gets cleared.
    if (initializedMobileEditIndexRef.current === mobileEditIndex) return;
    initializedMobileEditIndexRef.current = mobileEditIndex;

    const current = form.getValues(`entries.${mobileEditIndex}.amount`) || "";
    setMobileAmountStr(current);
    setMobileNarration(form.getValues(`entries.${mobileEditIndex}.narration`) || "");
    onRowFocus(mobileEditIndex, "account");
    setSidebarSearchValue("");
    setMobileSearch("");
    const timer = setTimeout(() => mobileSearchInputRef.current?.focus(), 150);
    return () => clearTimeout(timer);
  }, [mobileEditOpen, mobileEditIndex, form, onRowFocus, setSidebarSearchValue]);

  const openMobileEdit = (index: number) => {
    setMobileEditIndex(index);
    setMobileEditOpen(true);
  };

  const handleMobileAddRow = () => {
    const newIndex = fields.length;
    append({ accountType: "ledger", accountId: 0, accountName: "", amount: "" });
    setTimeout(() => {
      setMobileEditIndex(newIndex);
      setMobileEditOpen(true);
    }, 50);
  };

  const handleMobileAccountSelect = (account: Account) => {
    handleSidebarAccountSelect(account);
    setMobileSearch("");
    setSidebarSearchValue("");
    setTimeout(() => mobileAmountInputRef.current?.focus(), 120);
  };

  const handleMobileDone = () => {
    if (mobileEditIndex !== null) {
      const numVal = parseFloat(mobileAmountStr);
      const isPositive = !isNaN(numVal) && numVal > 0;
      const finalAmount = isPositive
        ? selectedCurrency !== "USD" && !amountCurrencyOverride
          ? convertToUSD(numVal).toFixed(2)
          : numVal.toFixed(2)
        : "";
      form.setValue(`entries.${mobileEditIndex}.amount`, finalAmount);
      form.setValue(`entries.${mobileEditIndex}.narration`, mobileNarration);
      if (isPositive && onAmountCommit) onAmountCommit(mobileEditIndex);
    }
    setMobileEditOpen(false);
  };

  const getEntryBalance = (index: number): number | null => {
    const entry = entries[index];
    if (!entry || !entry.accountId || !sidebarAccounts.length) return null;
    const found = sidebarAccounts.find((account) => {
      if (account.type !== entry.accountType) return false;
      if (entry.accountType === "employee") {
        return (account as unknown as Account & { accountId: number }).accountId === entry.accountId;
      }
      return account.id === entry.accountId;
    });
    if (!found || found.balance == null) return null;
    return typeof found.balance === "string" ? parseFloat(found.balance) : found.balance;
  };

  const handleAddRow = () => {
    append({ accountType: "ledger", accountId: 0, accountName: "", amount: "" });
  };

  const focusField = (
    field: "account" | "amount",
    index: number,
    select = true,
    anchor?: Element | null,
    delay = 0
  ) => {
    focusScopedTestId(`input-${field}-${index}`, { select, anchor, delay });
  };

  const handleAccountKeyDown = async (e: React.KeyboardEvent, index: number) => {
    const anchor = e.currentTarget as Element;
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const hasAccount = (entries[index]?.accountId ?? 0) > 0;
      if (!hasAccount && filteredSidebarAccounts.length > 0 && sidebarHighlightedIndex >= 0) {
        const highlighted = filteredSidebarAccounts[sidebarHighlightedIndex];
        if (highlighted) handleSidebarAccountSelect(highlighted);
      }
      focusField("amount", index, true, anchor);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filteredSidebarAccounts.length === 0) return;
      setSidebarHighlightedIndex(
        Math.min(sidebarHighlightedIndex < 0 ? 0 : sidebarHighlightedIndex + 1, filteredSidebarAccounts.length - 1)
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filteredSidebarAccounts.length === 0) return;
      setSidebarHighlightedIndex(Math.max(sidebarHighlightedIndex - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const currentName = form.getValues(`entries.${index}.accountName`)?.trim() || "";
      if (isFactoryCompany && onAutoCreateAccount && currentName) {
        const exactMatch = filteredSidebarAccounts.find(
          (account) => account.name.toLowerCase() === currentName.toLowerCase()
        );
        if (exactMatch) handleSidebarAccountSelect(exactMatch);
        else {
          const newAccount = await onAutoCreateAccount(currentName);
          if (newAccount) handleSidebarAccountSelect(newAccount);
        }
      } else if (filteredSidebarAccounts.length > 0 && sidebarHighlightedIndex >= 0) {
        const highlightedAccount = filteredSidebarAccounts[sidebarHighlightedIndex];
        if (highlightedAccount) handleSidebarAccountSelect(highlightedAccount);
      }
    }
  };

  const handleAmountKeyDown = (e: React.KeyboardEvent, index: number) => {
    const anchor = e.currentTarget as Element;
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const amount = Number(entries[index]?.amount);
      if (!isNaN(amount) && amount > 0 && onAmountCommit) onAmountCommit(index);
      const isLastRow = index === fields.length - 1;
      const rowHasContent = (entries[index]?.accountId ?? 0) > 0 || (!isNaN(amount) && amount > 0);
      if (isLastRow) {
        if (!rowHasContent) return;
        handleAddRow();
      }
      focusField("account", index + 1, false, anchor);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusField("account", index, false, anchor);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (index < fields.length - 1) focusField("account", index + 1, false, anchor);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const amount = Number(entries[index]?.amount);
      if (!isNaN(amount) && amount > 0) {
        if (onAmountCommit) onAmountCommit(index);
        handleAddRow();
        focusField("account", entries.length, true, anchor);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (index > 0) focusField("amount", index - 1, true, anchor);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (index < entries.length - 1) focusField("amount", index + 1, true, anchor);
    }
  };

  const handleAmountBlur = (e: React.FocusEvent<HTMLInputElement>, index: number) => {
    const enteredAmount = Number(e.target.value);
    if (!isNaN(enteredAmount) && enteredAmount > 0) {
      if (selectedCurrency !== "USD" && !amountCurrencyOverride) {
        const usdAmount = convertToUSD(enteredAmount);
        form.setValue(`entries.${index}.amount`, usdAmount.toFixed(2));
      }
      if (onAmountCommit) onAmountCommit(index);
    }
  };

  const renderBalanceLine = (index: number) => {
    const balance = getEntryBalance(index);
    if (balance == null) return null;
    return (
      <p
        className={`text-[11px] font-mono tabular-nums mt-0.5 ${
          balance < 0
            ? "text-red-500 dark:text-red-400"
            : balance > 0
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground"
        }`}
      >
        bal {formatAmount(balance)}
      </p>
    );
  };

  const runningTotals: number[] = [];
  let running = 0;
  for (let index = 0; index < fields.length; index++) {
    const value = parseFloat(entries[index]?.amount || "0");
    if (!isNaN(value) && value > 0) running += value;
    runningTotals.push(running);
  }
  const hasAnyAmount = runningTotals.length > 0 && runningTotals[runningTotals.length - 1] > 0;
  return {
    activeRow,
    amountCurrencyOverride,
    entries,
    fields,
    filteredSidebarAccounts,
    form,
    formatAmount,
    formatEntryAmount,
    handleAccountKeyDown,
    handleAddRow,
    handleAmountBlur,
    handleAmountKeyDown,
    handleMobileAccountSelect,
    handleMobileAddRow,
    handleMobileDone,
    hasAnyAmount,
    mobileAmountInputRef,
    mobileAmountStr,
    mobileEditIndex,
    mobileEditOpen,
    mobileNarration,
    mobileSearch,
    mobileSearchInputRef,
    mode,
    onRowBlur,
    onRowFocus,
    openMobileEdit,
    remove,
    renderBalanceLine,
    runningTotals,
    setMobileAmountStr,
    setMobileEditOpen,
    setMobileNarration,
    setMobileSearch,
    setSidebarSearchValue,
    total,
  };
}
