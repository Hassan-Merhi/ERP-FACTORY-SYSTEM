import { searchAny } from "@shared/searchNormalization";
import { isInternalHistoricalSupplierRoutineRow } from "@shared/internalHistoricalSupplierRoutineRow";
/**
 * Controller hook for the legacy Accounts Overview page.
 *
 * Holds the account list and statement queries, the running-balance
 * derivation, the ledger/bank/WhatsApp mutations, the two edit forms and the
 * voucher navigation map. Views render this model and nothing else.
 */
import { useMemo, useEffect } from "react";
import { insertBankAccountSchema, updateLedgerAccountSchema } from "@shared/schema";
import { Account, Transaction, WaRule } from "../accounts/accountTypes";
import { readNotInLedger } from "./NotInLedgerSection";
import { buildAccountStatementTabUrl } from "./accountStatementNavigation";
import { VOUCHER_TAB_MAP } from "./useAccountsLegacyModelConstants";
import { useAccountsLegacyStatementModel } from "./useAccountsLegacyStatementModel";

export const DEFAULT_WA_RULE: WaRule = {
  enabled: false,
  whatsappChatId: "",
  sendOnPayment: true,
  sendOnReceipt: true,
  sendOnJournal: true,
};

export interface GroupOption {
  id: number;
  name: string;
  parentId?: number | null;
  subType?: string | null;
}

interface VoucherNavigationRow {
  voucherId: number;
  voucherType?: string | null;
}

export function useAccountsLegacyModel() {
  const st = useAccountsLegacyStatementModel();

  // Unwrap response — when a startDate filter is active the backend returns
  // { transactions, preNetBalance } so we can compute the correct opening balance.
  const transactions: Transaction[] = useMemo(() => {
    if (!st.rawTransactionData) return [];
    if (Array.isArray(st.rawTransactionData)) return st.rawTransactionData;
    const posted: Transaction[] = st.rawTransactionData.transactions ?? [];
    // Historical factory invoices already affect Parties balances. Present their
    // operational amounts as dated statement rows, never as new GL postings.
    const memo = readNotInLedger(st.rawTransactionData);
    if (!memo) return posted;
    const historical: Transaction[] = memo.rows
      .filter((row) => row.amountUsd !== null && row.amountUsd !== undefined)
      .map((row, index) => ({
        entryId: -1000000 - index,
        voucherId: -1000000 - index,
        voucherNumber: row.voucherNumber,
        voucherType: "Historical Factory Invoice",
        voucherDate: row.voucherDate,
        voucherDescription: row.voucherDescription,
        narration: row.voucherDescription,
        destination: row.destination ?? null,
        debitAmount: row.debitAmount,
        creditAmount: row.creditAmount,
      }));
    return [...posted, ...historical].sort(
      (a, b) => a.voucherDate.localeCompare(b.voucherDate) || a.entryId - b.entryId
    );
  }, [st.rawTransactionData]);

  // The continuous statement chunk also carries these optional fields.
  const statementPayload = st.rawTransactionData as
    | (NonNullable<typeof st.rawTransactionData> & {
        customerId?: number | null;
        notInLedger?: { prePeriodTotal?: unknown } | null;
      })
    | undefined;

  // Expose customer ownership from the active statement query reactively. A linked
  // Factory customer account has type "ledger", so name/type alone cannot
  // reliably identify it. Passing this value as a prop avoids reading a
  // non-subscribed query-cache snapshot in AccountStatementView.
  const statementCustomerId: number | null =
    statementPayload &&
    !Array.isArray(statementPayload) &&
    Number.isSafeInteger(statementPayload.customerId) &&
    (statementPayload.customerId ?? 0) > 0
      ? (statementPayload.customerId ?? null)
      : null;

  // broughtForwardBalance = stored account opening balance + net of all entries before the period start.
  // openingBalance from the API is always an unsigned positive number; openingBalanceSide carries the sign.
  // Cr opening balances must be negated (convention: positive = Dr, negative = Cr).
  const broughtForwardBalance = useMemo(() => {
    const rawOB = parseFloat(String(st.d.selectedAccount?.openingBalance ?? 0)) || 0;
    const obSide = st.d.selectedAccount?.openingBalanceSide || "Dr";
    const storedOB = obSide === "Cr" ? -rawOB : rawOB;
    if (!statementPayload || Array.isArray(statementPayload)) return storedOB;
    const memoPrePeriod = Number(statementPayload.notInLedger?.prePeriodTotal ?? 0);
    return storedOB + (statementPayload.preNetBalance ?? 0) + (Number.isFinite(memoPrePeriod) ? memoPrePeriod : 0);
  }, [statementPayload, st.d.selectedAccount]);

  // Calculate ALL original posted lines first. The archived historical
  // supplier batch must continue to affect running and closing balances.
  // Only its routine table/card rows are removed from the interactive list.
  const allVouchersWithBalance = useMemo(() => {
    if (!transactions.length) return [];
    let runBal = broughtForwardBalance;
    return transactions.map((t) => {
      const dr = parseFloat(t.debitAmount) || 0;
      const cr = parseFloat(t.creditAmount) || 0;
      runBal += dr - cr;
      return { ...t, totalDebit: dr, totalCredit: cr, runningBalance: runBal };
    });
  }, [transactions, broughtForwardBalance]);

  const vouchersWithBalance = useMemo(
    () =>
      allVouchersWithBalance.filter(
        (row) =>
          !isInternalHistoricalSupplierRoutineRow({
            companyId: row.companyId ?? st.d.selectedCompany?.id,
            voucherId: row.voucherId,
            voucherDate: row.voucherDate,
            voucherNumber: row.voucherNumber,
            voucherDescription: row.voucherDescription,
            createdAt: row.createdAt,
          })
      ),
    [allVouchersWithBalance, st.d.selectedCompany?.id]
  );

  const closingBalance = useMemo(() => {
    if (allVouchersWithBalance.length > 0) {
      return allVouchersWithBalance[allVouchersWithBalance.length - 1].runningBalance;
    }
    return broughtForwardBalance;
  }, [allVouchersWithBalance, broughtForwardBalance]);

  const filteredAccounts = useMemo(() => {
    return st.allAccounts.filter((a) => searchAny(st.d.searchTerm, a.name, a.code));
  }, [st.allAccounts, st.d.searchTerm]);

  // Handlers
  const toggleParent = (id: string) => {
    st.d.setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAccountChange = (id: string) => {
    const acc = st.allAccounts.find((a) => a.id === id);
    if (!acc) return;

    // Keep the overview (including expansion, search and scroll position) intact.
    // The existing accountId/accountType deep link opens the statement in the new tab.
    const statementUrl = buildAccountStatementTabUrl(window.location.href, acc, st.d.periodFilter);
    window.open(statementUrl, "_blank", "noopener,noreferrer");
  };

  const toggleVoucherSelection = (voucherId: number) => {
    st.d.setSelectedVoucherIds((prev) => {
      const next = new Set(prev);
      if (next.has(voucherId)) next.delete(voucherId);
      else next.add(voucherId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (st.d.selectedVoucherIds.size === vouchersWithBalance.length) st.d.setSelectedVoucherIds(new Set());
    else st.d.setSelectedVoucherIds(new Set(vouchersWithBalance.map((v) => v.voucherId)));
  };

  const handleOpenVoucher = (v: VoucherNavigationRow) => {
    const id = v.voucherId;
    const rawType = (v.voucherType || "").toLowerCase().replace(/\s+/g, "");

    // POS / Sales → open in the POS edit page
    if (rawType === "sales" || rawType === "pos") {
      st.d.navigate(`${st.d.modePrefix.replace(/^\/erp/, "")}/pos/edit/${id}`);
      return;
    }

    // Purchase → try to resolve the container; fall back to vouchers page
    if (rawType === "purchase") {
      fetch(`/api/vouchers/${id}/view-entries`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          const po = data && !Array.isArray(data) ? data.purchaseOrder : null;
          if (po?.containerId) {
            st.d.navigate(`${st.d.modePrefix}/containers/${po.containerId}`);
          } else {
            st.d.navigate(`${st.d.modePrefix}/vouchers?edit=${id}&tab=purchase`);
          }
        })
        .catch(() => st.d.navigate(`${st.d.modePrefix}/vouchers?edit=${id}&tab=purchase`));
      return;
    }

    // All other voucher types → map to the correct Vouchers tab
    const tab = VOUCHER_TAB_MAP[rawType] ?? "journal";
    st.d.navigate(`${st.d.modePrefix}/vouchers?edit=${id}&tab=${tab}`);
  };

  // Populate bank form fields whenever a bank account is selected for editing.
  useEffect(() => {
    if (st.d.bankToEdit) {
      const openingBalanceSide = insertBankAccountSchema.shape.openingBalanceSide.safeParse(
        st.d.bankToEdit.openingBalanceSide ?? "Dr"
      );
      st.d.bankForm.reset({
        code: st.d.bankToEdit.code ?? "",
        name: st.d.bankToEdit.name ?? "",
        bankName: st.d.bankToEdit.bankName ?? "",
        accountNumber: st.d.bankToEdit.accountNumber ?? "",
        routingCode: st.d.bankToEdit.routingCode ?? "",
        openingBalance: st.d.bankToEdit.openingBalance ?? "0",
        openingBalanceSide: openingBalanceSide.success ? openingBalanceSide.data : "Dr",
      });
    } else {
      st.d.bankForm.reset();
    }
  }, [st.d.bankForm, st.d.bankToEdit]);
  const alterAccountType = st.d.editForm.watch("accountType") as string | undefined;

  /** Opens the alter/edit dialog pre-filled from an account table row. */
  const openEditAccountDialog = (account: Account) => {
    if (!st.d.recordChanges.allowed) return;
    st.d.setAlterSelectedAccount(account);
    const accountType = updateLedgerAccountSchema.shape.accountType.safeParse(account.accountType || account.type);
    st.d.editForm.reset({
      code: account.code,
      name: account.name,
      accountType: accountType.success ? accountType.data : undefined,
      subType: account.subType || "",
      openingBalance: String(Math.abs(account.openingBalance || 0)),
      openingBalanceSide: (account.openingBalanceSide as "Dr" | "Cr") || "Dr",
      active: account.active !== false,
      parentId: account.parentId ?? undefined,
    });
    st.d.setEditDialogOpen(true);
  };

  const closeEditAccountDialog = () => {
    st.d.setEditDialogOpen(false);
    st.d.setAlterSelectedAccount(null);
    st.d.editForm.reset();
  };

  return {
    // context / formatting
    selectedCompany: st.d.selectedCompany,
    appMode: st.d.appMode,
    modePrefix: st.d.modePrefix,
    modeApiRequest: st.d.modeApiRequest,
    navigate: st.d.navigate,
    currentUser: st.currentUser,
    formatAmount: st.d.formatAmount,
    formatAmountForAccount: st.d.formatAmountForAccount,
    formatDisplayDate: st.d.formatDisplayDate,
    isMultiCurrency: st.d.isMultiCurrency,
    hideBalances: st.d.hideBalances,
    // account list + statement
    accountsLoading: st.accountsLoading,
    accountsError: st.accountsError,
    accountsQueryError: st.accountsQueryError,
    refetchAccounts: st.refetchAccounts,
    allAccounts: st.allAccounts,
    filteredAccounts,
    searchTerm: st.d.searchTerm,
    setSearchTerm: st.d.setSearchTerm,
    selectedAccount: st.d.selectedAccount,
    setSelectedAccount: st.d.setSelectedAccount,
    handleAccountChange,
    expandedParents: st.d.expandedParents,
    toggleParent,
    periodFilter: st.d.periodFilter,
    setPeriodFilter: st.d.setPeriodFilter,
    vouchersWithBalance,
    statementCustomerId,
    notInLedger: readNotInLedger(st.rawTransactionData),
    broughtForwardBalance,
    closingBalance,
    transactionsLoading: st.transactionsLoading,
    transactionsQueryError: st.transactionsQueryError,
    filterCurrency: st.filterCurrency,
    setFilterCurrency: st.setFilterCurrency,
    showDeletedVouchers: st.d.showDeletedVouchers,
    setShowDeletedVouchers: st.d.setShowDeletedVouchers,
    selectedVoucherIds: st.d.selectedVoucherIds,
    toggleVoucherSelection,
    toggleSelectAll,
    handleOpenVoucher,
    printRef: st.printRef,
    handlePrint: st.handlePrint,
    exportLang: st.exportLang,
    setExportLang: st.setExportLang,
    // find voucher tab
    findQuery: st.d.findQuery,
    setFindQuery: st.d.setFindQuery,
    debouncedFindQuery: st.d.debouncedFindQuery,
    voucherSearchResults: st.d.voucherSearchResults,
    voucherSearchLoading: st.d.voucherSearchLoading,
    // dialogs / forms
    accountToEdit: st.d.accountToEdit,
    setAccountToEdit: st.d.setAccountToEdit,
    supplierToEdit: st.d.supplierToEdit,
    setSupplierToEdit: st.d.setSupplierToEdit,
    customerToEdit: st.d.customerToEdit,
    setCustomerToEdit: st.d.setCustomerToEdit,
    employeeToEdit: st.d.employeeToEdit,
    setEmployeeToEdit: st.d.setEmployeeToEdit,
    bankToEdit: st.d.bankToEdit,
    setBankToEdit: st.d.setBankToEdit,
    bankForm: st.d.bankForm,
    onBankSubmit: st.onBankSubmit,
    handleDeleteBankAccount: st.handleDeleteBankAccount,
    pendingDelete: st.d.pendingDelete,
    setPendingDelete: st.d.setPendingDelete,
    editForm: st.d.editForm,
    alterAccountType,
    alterSelectedAccount: st.d.alterSelectedAccount,
    editDialogOpen: st.d.editDialogOpen,
    setEditDialogOpen: st.d.setEditDialogOpen,
    openEditAccountDialog,
    closeEditAccountDialog,
    groupOptions: st.groupOptions,
    parentGroupOpen: st.d.parentGroupOpen,
    setParentGroupOpen: st.d.setParentGroupOpen,
    showDeleteAccountConfirm: st.d.showDeleteAccountConfirm,
    setShowDeleteAccountConfirm: st.d.setShowDeleteAccountConfirm,
    showBulkDeleteConfirm: st.d.showBulkDeleteConfirm,
    setShowBulkDeleteConfirm: st.d.setShowBulkDeleteConfirm,
    // whatsapp
    waRule: st.waRule,
    waRuleDialogOpen: st.waRuleDialogOpen,
    setWaRuleDialogOpen: st.setWaRuleDialogOpen,
    waRuleDraft: st.waRuleDraft,
    setWaRuleDraft: st.setWaRuleDraft,
    waChatSearch: st.waChatSearch,
    setWaChatSearch: st.setWaChatSearch,
    filteredWaChats: st.filteredWaChats,
    waChatsLoading: st.waChatsLoading,
    selectedAccountIsLedger: st.selectedAccountIsLedger,
    openWaRuleDialog: st.openWaRuleDialog,
    // mutations
    bulkDeleteMutation: st.d.bulkDeleteMutation,
    deleteLedgerMutation: st.d.deleteLedgerMutation,
    updateLedgerMutation: st.d.updateLedgerMutation,
    updateBankMutation: st.d.updateBankMutation,
    deleteBankMutation: st.d.deleteBankMutation,
    createBankMutation: st.d.createBankMutation,
    saveWaRuleMutation: st.saveWaRuleMutation,
    sendWaStatementMutation: st.sendWaStatementMutation,
    canChangeExistingRecords: st.d.recordChanges.allowed,
    canCreateBankAccount: st.d.canCreateBankAccount,
  };
}

export type AccountsLegacyModel = ReturnType<typeof useAccountsLegacyModel>;
