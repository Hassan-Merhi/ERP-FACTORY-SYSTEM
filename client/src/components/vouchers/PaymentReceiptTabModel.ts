// Extracted from ./PaymentReceiptTab.tsx: state, queries and handlers for PaymentReceiptTab.
import { useState, useMemo, useEffect } from "react";
import { ArrowUpCircle, ArrowDownCircle } from "lucide-react";
import { Account } from "@/components/AccountSidebar";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import type { PaymentReceiptTabProps } from "./PaymentReceiptTab";

export function usePaymentReceiptTabModel({
  form,
  entries,
  total,
  paymentAccountId,
  paymentAccountType,
  accountBalance,
  allAccounts,
  payFromAccounts,
  sidebarAccounts,
  filteredSidebarAccounts,
  sidebarSearchValue,
  setSidebarSearchValue,
  sidebarHighlightedIndex,
  setSidebarHighlightedIndex,
  selectedAccountId,
  selectedAccountType,
  handleSidebarAccountSelect,
  handleExportVoucher,
  activeTab,
  activeRowIndex,
  onCreateAccount,
  isFactoryCompany,
  onAutoCreateAccount,
  isAutoCreating,
  isEditMode,
  originalTotal,
  fxWallet,
  fxWalletsLoading,
  fxPaymentRate,
  fxPayoutCurrency,
  fxSupplierEurBalance,
  fxSupplierBalanceLoading,
  effectiveDate,
}: {
  form: PaymentReceiptTabProps["form"];
  entries: PaymentReceiptTabProps["entries"];
  total: PaymentReceiptTabProps["total"];
  paymentAccountId: PaymentReceiptTabProps["paymentAccountId"];
  paymentAccountType: PaymentReceiptTabProps["paymentAccountType"];
  accountBalance: PaymentReceiptTabProps["accountBalance"];
  allAccounts: PaymentReceiptTabProps["allAccounts"];
  payFromAccounts: PaymentReceiptTabProps["payFromAccounts"];
  sidebarAccounts: PaymentReceiptTabProps["sidebarAccounts"];
  filteredSidebarAccounts: PaymentReceiptTabProps["filteredSidebarAccounts"];
  sidebarSearchValue: PaymentReceiptTabProps["sidebarSearchValue"];
  setSidebarSearchValue: PaymentReceiptTabProps["setSidebarSearchValue"];
  sidebarHighlightedIndex: PaymentReceiptTabProps["sidebarHighlightedIndex"];
  setSidebarHighlightedIndex: PaymentReceiptTabProps["setSidebarHighlightedIndex"];
  selectedAccountId: PaymentReceiptTabProps["selectedAccountId"];
  selectedAccountType: PaymentReceiptTabProps["selectedAccountType"];
  handleSidebarAccountSelect: PaymentReceiptTabProps["handleSidebarAccountSelect"];
  handleExportVoucher: PaymentReceiptTabProps["handleExportVoucher"];
  activeTab: PaymentReceiptTabProps["activeTab"];
  activeRowIndex: PaymentReceiptTabProps["activeRowIndex"];
  onCreateAccount: PaymentReceiptTabProps["onCreateAccount"];
  isFactoryCompany: Exclude<PaymentReceiptTabProps["isFactoryCompany"], undefined>;
  onAutoCreateAccount: PaymentReceiptTabProps["onAutoCreateAccount"];
  isAutoCreating: Exclude<PaymentReceiptTabProps["isAutoCreating"], undefined>;
  isEditMode: Exclude<PaymentReceiptTabProps["isEditMode"], undefined>;
  originalTotal: Exclude<PaymentReceiptTabProps["originalTotal"], undefined>;
  fxWallet: PaymentReceiptTabProps["fxWallet"];
  fxWalletsLoading: Exclude<PaymentReceiptTabProps["fxWalletsLoading"], undefined>;
  fxPaymentRate: Exclude<PaymentReceiptTabProps["fxPaymentRate"], undefined>;
  fxPayoutCurrency: Exclude<PaymentReceiptTabProps["fxPayoutCurrency"], undefined>;
  fxSupplierEurBalance: Exclude<PaymentReceiptTabProps["fxSupplierEurBalance"], undefined>;
  fxSupplierBalanceLoading: Exclude<PaymentReceiptTabProps["fxSupplierBalanceLoading"], undefined>;
  effectiveDate: PaymentReceiptTabProps["effectiveDate"];
}) {
  const { formatAmount } = useCurrencyContext();

  // Notes collapse state — auto-open if there is already a notes value
  const [notesOpen, setNotesOpen] = useState<boolean>(() => {
    const existingNotes = form.getValues("notes");
    return typeof existingNotes === "string" && existingNotes.trim().length > 0;
  });

  // Mobile account drawer (entry rows → AccountSidebar)
  const [sheetOpen, setSheetOpen] = useState(false);

  // Mobile Pay From sheet
  const [payFromSheetOpen, setPayFromSheetOpen] = useState(false);
  const [payFromSearch, setPayFromSearch] = useState("");

  // Track whether the Pay From / Receive Into autocomplete is the active target
  const [payFromActive, setPayFromActive] = useState(false);

  // Effective date is optional and rarely used — it stays behind a toggle until asked for,
  // and reveals itself automatically when the voucher already carries one.
  const [showEffectiveDate, setShowEffectiveDate] = useState<boolean>(Boolean(effectiveDate));

  // Once an account is chosen the picker collapses into a summary card; "Change" reopens it.
  const [editingSource, setEditingSource] = useState(false);

  // Required-field warnings wait for a submit attempt or for the user to leave the field,
  // so an untouched form never opens with an error on it.
  const [payFromTouched, setPayFromTouched] = useState(false);
  const showValidation = form.formState.isSubmitted || payFromTouched;

  const isPayment = activeTab === "payment";
  const isFxPayment = isPayment && !!fxWallet && !isEditMode;
  useEffect(() => {
    if (isFxPayment && form.getValues("optional")) form.setValue("optional", false);
  }, [isFxPayment, form]);
  const fxRateValue = Number(fxPaymentRate);
  const directEurPayment = isFxPayment && fxPayoutCurrency === "EUR";
  const fxEurRequired =
    isFxPayment && total > 0 ? (directEurPayment ? total : fxRateValue > 0 ? total / fxRateValue : 0) : 0;
  const fxUnsupportedEntries =
    isFxPayment &&
    (entries.length !== 1 ||
      !["ledger", "factorySupplier"].includes(entries[0]?.accountType || "") ||
      entries[0]?.accountId === fxWallet?.wallet.ledgerAccountId ||
      (directEurPayment && entries[0]?.accountType !== "factorySupplier"));

  // Tab-specific styling / labels
  const Icon = isPayment ? ArrowUpCircle : ArrowDownCircle;
  const accentColor: "#f59e0b" | "#10b981" = isPayment ? "#f59e0b" : "#10b981";
  const title: "Payment Voucher" | "Receipt Voucher" = isPayment ? "Payment Voucher" : "Receipt Voucher";
  const accountLabel: "Pay From" | "Receive Into" = isPayment ? "Pay From" : "Receive Into";
  const accountPlaceholder: "Pay from..." | "Receive into..." = isPayment ? "Pay from..." : "Receive into...";
  const accountTestId: "input-pay-from" | "input-receive-in" = isPayment ? "input-pay-from" : "input-receive-in";

  // Active target label shown in the account sidebar / drawer
  const activeTargetLabel: string | undefined = payFromActive
    ? accountLabel
    : activeRowIndex !== null
      ? `Row ${activeRowIndex + 1}`
      : undefined;

  // Wrap handleSidebarAccountSelect to also close the mobile drawer
  const handleAccountSelect = (account: Account) => {
    handleSidebarAccountSelect(account);
    setSheetOpen(false);
  };

  // Action guards
  const hasExport = Boolean(handleExportVoucher);
  const hasAnyEntry = entries.some((e) => (e?.accountId ?? 0) > 0);
  const canRunActions = paymentAccountId !== 0;
  const canPrint = canRunActions && hasAnyEntry;
  const canExport = canRunActions && hasAnyEntry && hasExport;

  // Tooltip reason for disabled print/export
  const printDisabledReason = !canRunActions
    ? `Select ${accountLabel} account first`
    : "Add at least one entry with an amount";

  // Validation state for summary warnings
  const validEntryCount = entries.filter((e) => (e?.accountId ?? 0) > 0 && parseFloat(e?.amount || "0") > 0).length;
  const missingAccount = paymentAccountId === 0;
  const missingEntries = validEntryCount === 0;

  // Why Save is disabled, said out loud rather than left to a dead button.
  const saveHint = missingAccount
    ? `Select a ${accountLabel} account to save`
    : total === 0
      ? "Add at least one line with an amount"
      : null;

  // Same conditions as before the shared action bar; only where they are evaluated moved.
  const saveDisabled =
    paymentAccountId === 0 ||
    total === 0 ||
    !!fxWalletsLoading ||
    (isFxPayment &&
      (!fxWallet?.synchronized ||
        fxSupplierBalanceLoading ||
        (!directEurPayment && fxRateValue <= 0) ||
        (directEurPayment &&
          (fxSupplierEurBalance === null || fxSupplierEurBalance <= 0 || total > fxSupplierEurBalance)) ||
        !Number.isFinite(fxEurRequired) ||
        fxEurRequired > Number(fxWallet!.state.eur) ||
        fxUnsupportedEntries));
  // An FX wallet payment pays out in the payout currency, so its total says which one.
  const totalLabel = total > 0 ? (isFxPayment ? `${fxPayoutCurrency} ${total.toFixed(2)}` : formatAmount(total)) : "—";

  // Projected balance after save.
  // Payment edit: undo the original deduction, apply the new one.
  // Receipt edit: undo the original addition, apply the new one.
  const projected = isPayment
    ? isEditMode
      ? accountBalance + originalTotal - total
      : accountBalance - total
    : isEditMode
      ? accountBalance - originalTotal + total
      : accountBalance + total;

  // How much of the source account this voucher consumes, purely as a visual cue.
  // Capped at 100% so a voucher larger than the balance simply fills the bar.
  const meterPct = (() => {
    if (total <= 0) return 0;
    const capacity = Math.max(Math.abs(accountBalance), total);
    return capacity > 0 ? Math.min(100, (total / capacity) * 100) : 0;
  })();

  // When the Pay From / Receive Into field is active, restrict the sidebar and autocomplete to
  // Cash / Bank / Loans ledger accounts + bank accounts only.
  const payFromKeys = useMemo(() => {
    const src = payFromAccounts ?? allAccounts;
    return new Set(src.map((a) => `${a.type}:${a.id}`));
  }, [payFromAccounts, allAccounts]);

  const filteredSidebarForPayFrom = useMemo(
    () => filteredSidebarAccounts.filter((a) => payFromKeys.has(`${a.type}:${a.id}`)),
    [filteredSidebarAccounts, payFromKeys]
  );

  // Shared AccountSidebar props
  const sidebarProps = {
    accounts: sidebarAccounts,
    filteredAccounts: payFromActive ? filteredSidebarForPayFrom : filteredSidebarAccounts,
    onSelectAccount: handleAccountSelect,
    searchValue: sidebarSearchValue,
    onSearchChange: setSidebarSearchValue,
    selectedAccountId,
    selectedAccountType,
    highlightedIndex: sidebarHighlightedIndex,
    onHighlightedIndexChange: setSidebarHighlightedIndex,
    entries,
    mode: activeTab,
    paymentAccountId,
    paymentAccountType,
    voucherTotal: total,
    onCreateAccount: isFactoryCompany ? undefined : onCreateAccount,
    isFactoryCompany,
    onAutoCreateAccount,
    isAutoCreating,
    activeTargetLabel,
  };

  return {
    formatAmount,
    notesOpen,
    setNotesOpen,
    sheetOpen,
    setSheetOpen,
    payFromSheetOpen,
    setPayFromSheetOpen,
    payFromSearch,
    setPayFromSearch,
    setPayFromActive,
    showEffectiveDate,
    setShowEffectiveDate,
    editingSource,
    setEditingSource,
    setPayFromTouched,
    showValidation,
    isPayment,
    isFxPayment,
    fxRateValue,
    directEurPayment,
    fxEurRequired,
    fxUnsupportedEntries,
    Icon,
    accentColor,
    title,
    accountLabel,
    accountPlaceholder,
    accountTestId,
    activeTargetLabel,
    handleAccountSelect,
    hasExport,
    canPrint,
    canExport,
    printDisabledReason,
    validEntryCount,
    missingAccount,
    missingEntries,
    saveHint,
    saveDisabled,
    totalLabel,
    projected,
    meterPct,
    payFromKeys,
    sidebarProps,
  };
}

export type PaymentReceiptTabModel = ReturnType<typeof usePaymentReceiptTabModel>;
