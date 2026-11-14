import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef, useEffect, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useForm, useFieldArray, useWatch } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { format } from "date-fns";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useZmwVoucherRate } from "@/hooks/useZmwVoucherRate";
import { useReactToPrint } from "react-to-print";
import { Link, useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import type { Account } from "@/components/AccountSidebar";
import { PaymentVoucherTab } from "@/components/vouchers/PaymentVoucherTab";
import { ReceiptVoucherTab } from "@/components/vouchers/ReceiptVoucherTab";
import { CreditNoteTab } from "@/components/vouchers/CreditNoteTab";
import { CreateAccountModal } from "@/components/vouchers/CreateAccountModal";
import { PageHeader } from "@/components/PageHeader";
import { ArrowRightLeft } from "lucide-react";
import "@/pages/vouchers/pos-stock-transfer.css";
import "@/pages/vouchers/voucher-premium.css";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useAppMode, useModePrefix } from "@/contexts/AppModeContext";
import type { WhatsAppPromptState } from "@/lib/whatsapp-prompt";
import { getApiRequest } from "@/lib/factoryApi";
import type { AuthMe, FactoryMyAccess } from "@shared/apiTypes";
import { useFormDraft } from "@/hooks/useFormDraft";
import StockTransferOrder from "@/pages/StockTransferOrder.tsx";
import { PrintTemplate } from "@/components/vouchers/PrintTemplate";
import { StockTransferForm } from "@/pages/vouchers/StockTransferForm";
import { StockAdjustmentForm } from "@/pages/vouchers/StockAdjustmentForm";
import { JournalForm } from "@/pages/vouchers/JournalForm";
import { VoucherMobileTabs, VoucherDesktopNav } from "@/pages/vouchers/VoucherTabNav";
import { useVoucherQueries } from "@/pages/vouchers/useVoucherQueries";
import { useVoucherFxWalletPayment } from "@/pages/vouchers/useVoucherFxWalletPayment";
import { useVoucherHandlers } from "@/pages/vouchers/useVoucherHandlers";
import { useVoucherSaveMutation } from "@/pages/vouchers/useVoucherSaveMutation";
import { useSidebarSync } from "@/pages/vouchers/useSidebarSync";
import { useAccountBalance } from "@/pages/vouchers/useAccountBalance";
import { useVoucherHydration } from "@/pages/vouchers/useVoucherHydration";
import { PaymentDraftAndRateBar } from "@/pages/vouchers/PaymentDraftAndRateBar";
import { buildVoucherSidebarGroups } from "@/pages/vouchers/voucherSidebarGroups";
import type { VoucherSidebarGroup } from "@/pages/vouchers/voucherSidebarGroups";
import { exportVoucherHelper } from "@/pages/vouchers/voucherActions";
import { voucherFormSchema } from "@/pages/vouchers/voucherTypes";
import type { VoucherFormData } from "@/pages/vouchers/voucherTypes";
import { ErrorState } from "@/components/ui/page-state";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { isRetailManualVoucherTabHidden, isRetailManualVoucherTypeHidden } from "@/lib/retailVoucherPolicy";
import { shouldShowFactoryVoucherTab } from "@/pages/vouchers/factoryVoucherPolicy";
import type { ErpFeatureAccess } from "@/app/erpAccess";
import { erpPageAccessQueryOptions } from "@/app/erpAccessQuery";

type VoucherTab = "payment" | "receipt" | "journal" | "transfer" | "transferorder" | "adjustment" | "creditnote";

const FACTORY_VOUCHER_HIDDEN_KEYS: Record<VoucherTab, string> = {
  payment: "hide_tab_vouchers_payment",
  receipt: "hide_tab_vouchers_receipt",
  journal: "hide_tab_vouchers_journal",
  transfer: "hide_tab_vouchers_transfer",
  transferorder: "hide_tab_vouchers_transferorder",
  adjustment: "hide_tab_vouchers_adjustment",
  creditnote: "hide_tab_vouchers_creditnote",
};
const ALL_VOUCHER_TABS: readonly VoucherTab[] = [
  "payment",
  "receipt",
  "journal",
  "transfer",
  "transferorder",
  "adjustment",
  "creditnote",
];

interface VouchersProps {
  posUser?: Pick<AuthMe, "assignedLocationId"> | null;
}

export default function Vouchers({ posUser }: VouchersProps = {}) {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const isFactoryCompany = selectedCompany?.companyType === "factory";
  const isRetailCompany = selectedCompany?.companyType === "retail";
  const isPropertiesCompany = selectedCompany?.companyType === "properties";
  const [isAutoCreating, setIsAutoCreating] = useState(false);
  const {
    formatHistoricalBaseAmount: formatAmount,
    selectedCurrency,
    exchangeRate: dailyExchangeRate,
  } = useCurrencyContext();
  const [transactionRate, setTransactionRate] = useState<number | null>(null);
  const exchangeRate = transactionRate || dailyExchangeRate;
  const [voucherEffectiveDate, setVoucherEffectiveDate] = useState<string>("");
  const [, setLocation] = useLocation();
  const printRef = useRef<HTMLDivElement>(null);
  const isPOS = !!posUser;
  const { data: erpPageAccess } = useQuery<ErpFeatureAccess>({
    ...erpPageAccessQueryOptions(selectedCompany?.id, !isPOS && appMode === "erp"),
  });
  const showOptionalDrafts =
    !isPOS &&
    appMode === "erp" &&
    !isRetailCompany &&
    (erpPageAccess?.fullAccess === true || erpPageAccess?.pageKeys.includes("optional_vouchers") === true);
  const posLocationId = posUser?.assignedLocationId;

  const sidebarGroups: VoucherSidebarGroup[] = buildVoucherSidebarGroups();

  const searchParams = new URLSearchParams(window.location.search);
  const editParam = searchParams.get("edit");
  const voucherIdToEdit = editParam ? parseInt(editParam) : null;

  const [editVoucherId, setEditVoucherId] = useState<number | null>(null);
  const [accountPickersNeeded, setAccountPickersNeeded] = useState(() => !!voucherIdToEdit);

  const isFactoryMode = appMode === "factory";
  const { data: factoryAccess } = useQuery<FactoryMyAccess>({
    queryKey: ["/api/factory/my-access"],
    staleTime: 5 * 60000,
    enabled: isFactoryMode && !isPOS,
  });
  const factoryHiddenTabs = factoryAccess?.hiddenCostFields ?? [];
  // Retail is an ERP company: only hide manual entry types, not posted journals,
  // receipt/payment vouchers, stock movements, or automatic Retail accounting.
  // Filtering the source groups updates both mobile and desktop navigation.
  const visibleSidebarGroups = sidebarGroups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          (!isFactoryMode ||
            shouldShowFactoryVoucherTab(
              item.key,
              factoryHiddenTabs,
              FACTORY_VOUCHER_HIDDEN_KEYS[item.key as VoucherTab]
            )) &&
          (!isRetailCompany || !isRetailManualVoucherTabHidden(item.key))
      ),
    }))
    .filter((group) => group.items.length > 0);
  const visibleVoucherTabs = visibleSidebarGroups.flatMap((group) => group.items.map((item) => item.key as VoucherTab));
  const fallbackVoucherTab = visibleVoucherTabs[0] ?? null;
  const canShowVoucherTab = (tab: VoucherTab) =>
    isPOS || (!isFactoryMode && !isRetailCompany) || visibleVoucherTabs.includes(tab);
  const allowedVoucherTabs = (isFactoryMode || isRetailCompany) && !isPOS ? visibleVoucherTabs : ALL_VOUCHER_TABS;
  const [activeTab, setActiveTab] = useHubQueryState<VoucherTab>({
    key: "tab",
    allowedValues: allowedVoucherTabs,
    knownValues: ALL_VOUCHER_TABS,
    defaultValue: fallbackVoucherTab ?? "payment",
  });
  const modePrefix = useModePrefix();

  const [sidebarSearchValue, setSidebarSearchValue] = useState("");
  const [sidebarHighlightedIndex, setSidebarHighlightedIndex] = useState(0);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [selectedAccountType, setSelectedAccountType] = useState<string | null>(null);
  const [activeRowIndex, setActiveRowIndex] = useState<number | null>(null);
  const [waPendingPrompt, setWaPendingPrompt] = useState<WhatsAppPromptState>(null);
  const [showCreateAccountModal, setShowCreateAccountModal] = useState(false);
  const [createAccountContext, setCreateAccountContext] = useState<{
    tab: "payment" | "receipt" | "journal";
    rowIndex?: number;
  } | null>(null);

  const {
    bankAccounts,
    bankAccountsFetched,
    bankAccountsError,
    refetchBankAccounts,
    ledgerAccounts,
    ledgerAccountsFetched,
    ledgerAccountsError,
    refetchLedgerAccounts,
    suppliers,
    suppliersFetched,
    customers,
    customersFetched,
    employees,
    fixedAssets,
    factorySuppliersList,
    sidebarAccounts,
    sidebarAccountsError,
    refetchSidebarAccounts,
    voucherToEdit,
    allAccounts,
    payFromAccounts,
    setLiveAccountSearch,
  } = useVoucherQueries({
    selectedCompany,
    isFactoryCompany,
    isPropertiesCompany,
    voucherIdToEdit,
    accountPickersNeeded,
    activeTab,
    isPOS,
    posLocationId,
  });

  // Stale Daybook "edit" deep links must not reopen system-generated Retail
  // journals/credit notes in a generic write dialog. Keep the audit detail
  // available instead.
  useEffect(() => {
    if (
      isRetailCompany &&
      voucherIdToEdit &&
      voucherToEdit &&
      isRetailManualVoucherTypeHidden(voucherToEdit.voucherType)
    ) {
      setEditVoucherId(null);
      setLocation(`/voucher-detail/${voucherIdToEdit}`);
    }
  }, [isRetailCompany, voucherIdToEdit, voucherToEdit, setLocation]);

  useEffect(() => {
    if (voucherIdToEdit) setAccountPickersNeeded(true);
  }, [voucherIdToEdit]);
  useEffect(() => {
    if (activeRowIndex !== null) setAccountPickersNeeded(true);
  }, [activeRowIndex]);
  useEffect(() => {
    if (sidebarSearchValue !== "") setAccountPickersNeeded(true);
  }, [sidebarSearchValue]);

  const form = useForm<VoucherFormData>({
    resolver: zodResolver(voucherFormSchema),
    defaultValues: {
      paymentAccountType: "bank",
      paymentAccountId: 0,
      paymentAccountName: "",
      voucherDate: new Date(),
      entries: [{ accountType: "ledger", accountId: 0, accountName: "", amount: "" }],
      paymentAccountNarration: "",
      notes: "",
      optional: false,
    },
  });

  const fieldArray = useFieldArray({ control: form.control, name: "entries" });
  const { append } = fieldArray;
  const entries = form.watch("entries");
  const paymentVoucherDate = format(form.watch("voucherDate") ?? new Date(), "yyyy-MM-dd");
  const { rate: dateSpecificZmwRate } = useZmwVoucherRate(paymentVoucherDate);
  const priorZmwRate = Number(voucherToEdit?.exchangeRate);
  const isEditingZmw = !!voucherIdToEdit && voucherToEdit?.currency === "ZMW";
  // Editing a historical document keeps its original native currency,
  // independently of the current user's currency-toggle preference.
  const paymentPostingCurrency =
    voucherIdToEdit &&
    (voucherToEdit?.currency === "ZMW" || voucherToEdit?.currency === "CFA" || voucherToEdit?.currency === "USD")
      ? voucherToEdit.currency
      : selectedCurrency;
  const paymentPostingRate =
    paymentPostingCurrency === "ZMW"
      ? isEditingZmw
        ? Number.isFinite(priorZmwRate) && priorZmwRate > 0
          ? priorZmwRate
          : null
        : dateSpecificZmwRate
      : exchangeRate;
  const watchedEntries = useWatch({ control: form.control, name: "entries" });
  const total = entries.reduce((sum, entry) => sum + (parseFloat(entry.amount) || 0), 0);

  const originalTotal = useMemo(() => {
    if (!voucherIdToEdit || !voucherToEdit) return 0;
    const parsed = parseFloat(String(voucherToEdit?.totalAmount ?? "0"));
    return isNaN(parsed) ? 0 : parsed;
  }, [voucherIdToEdit, voucherToEdit]);

  const paymentDraftMode = isFactoryMode ? "factory" : "erp";
  const paymentDraftType = activeTab === "payment" ? "voucher-payment" : "voucher-receipt";
  const {
    hasDraft: hasPaymentDraft,
    draftAge: paymentDraftAge,
    draft: paymentDraft,
    scheduleSave: schedulePaymentSave,
    discardDraft: discardPaymentDraft,
  } = useFormDraft({
    entityType: paymentDraftType,
    mode: paymentDraftMode,
    companyId: selectedCompany?.id ?? null,
    enabled: !voucherIdToEdit,
  });

  const allFormValues = form.watch();
  useEffect(() => {
    if (voucherIdToEdit) return;
    schedulePaymentSave(allFormValues);
  }, [allFormValues, schedulePaymentSave, voucherIdToEdit]);

  const { hydratedVoucherIdRef } = useVoucherHydration({
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
    form,
    setTransactionRate,
    setVoucherEffectiveDate,
  });

  useEffect(() => {
    if (voucherIdToEdit) {
      setEditVoucherId(voucherIdToEdit);
    } else {
      setEditVoucherId(null);
      hydratedVoucherIdRef.current = null;
    }
  }, [hydratedVoucherIdRef, voucherIdToEdit]);

  const paymentAccountType = form.watch("paymentAccountType");
  const paymentAccountId = form.watch("paymentAccountId");
  const paymentAccountName = form.watch("paymentAccountName");

  const { filteredSidebarAccounts, selectedAccount } = useSidebarSync({
    sidebarAccounts,
    sidebarSearchValue,
    paymentAccountId,
    paymentAccountType,
    sidebarHighlightedIndex,
    setSidebarHighlightedIndex,
    entries,
    activeRowIndex,
    allAccounts,
  });

  const { accountBalance, accountCurrencyBalances } = useAccountBalance({
    paymentAccountType,
    paymentAccountId,
    bankAccounts,
    selectedAccountOpeningBalance: selectedAccount?.openingBalance,
    sidebarAccounts,
  });

  const { handleSidebarAccountSelect, handleAmountCommit, handleAutoCreateAccount } = useVoucherHandlers({
    form,
    append,
    activeRowIndex,
    setActiveRowIndex,
    sidebarAccounts,
    selectedCompany,
    setIsAutoCreating,
    queryClient,
    toast,
    setSelectedAccountId,
    setSelectedAccountType,
    setSidebarSearchValue,
    setSidebarHighlightedIndex,
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
    selectedCompany,
    isFactoryMode,
    isFactoryCompany,
    isPOS,
    activeTab,
    voucherIdToEdit,
    paymentAccountType,
    paymentAccountId,
    entries,
    form,
    payFromAccounts,
  });

  const saveMutation = useVoucherSaveMutation({
    activeTab,
    voucherIdToEdit,
    isWalletPayment,
    postWalletPayment,
    resetWalletPayment,
    selectedCurrency,
    voucherEffectiveDate,
    modeApiRequest,
    paymentPostingCurrency,
    paymentPostingRate,
    paymentAccountType,
    paymentAccountId,
    selectedCompany,
    modePrefix,
    setLocation,
    form,
    toast,
    setWaPendingPrompt,
    discardPaymentDraft,
  });

  const sendWaStatementMutation = useMutation({
    mutationFn: async ({ accountId, month }: { accountId: number; month: string }) => {
      const url =
        appMode === "factory"
          ? `/api/factory/accounts/${accountId}/send-statement-whatsapp`
          : `/api/accounts/${accountId}/send-statement-whatsapp`;
      const res = await modeApiRequest("POST", url, { month });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || "Failed to send WhatsApp");
      return json;
    },
    onSuccess: () => {
      toast({ title: "Statement sent to WhatsApp" });
      setWaPendingPrompt(null);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "WhatsApp send failed", description: error.message, variant: "destructive" });
      setWaPendingPrompt(null);
    },
  });

  const handleOpenCreateAccountModal = (tab: "payment" | "receipt" | "journal", rowIndex?: number) => {
    setCreateAccountContext({ tab, rowIndex });
    setShowCreateAccountModal(true);
  };

  const handleAccountCreated = async (account: { id: number; name: string; type: string }) => {
    if (!createAccountContext) return;
    if (createAccountContext.tab === "payment" || createAccountContext.tab === "receipt") {
      const accountObj: Account = {
        id: account.id,
        name: account.name,
        type: account.type as
          "customer" | "ledger" | "bank" | "supplier" | "employee" | "fixedAsset" | "factorySupplier",
        code: "",
      };
      handleSidebarAccountSelect(accountObj);
    }
    setCreateAccountContext(null);
  };

  useEffect(() => {
    if (activeRowIndex !== null) {
      const activeEntry = watchedEntries[activeRowIndex];
      if (activeEntry) {
        setSidebarSearchValue(activeEntry.accountName || "");
        setSidebarHighlightedIndex(0);
      }
    }
  }, [watchedEntries, activeRowIndex]);

  const restorePaymentDraft = () => {
    if (paymentDraft?.data) {
      const d = paymentDraft.data as unknown as object & { voucherDate: unknown } & {
        voucherDate: string | number | Date;
      };
      form.reset({ ...d, voucherDate: d.voucherDate ? new Date(d.voucherDate) : new Date() });
    }
    discardPaymentDraft();
  };

  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: `${activeTab === "payment" ? "Payment" : "Receipt"}-Voucher-${format(form.watch("voucherDate"), "yyyy-MM-dd")}`,
  });

  const handleExportVoucher = (detailed: boolean) =>
    exportVoucherHelper({ formData: form.getValues(), activeTab, toast, detailed });

  const onSubmit = async (data: VoucherFormData) => {
    if (paymentPostingCurrency === "ZMW" && (!paymentPostingRate || paymentPostingRate <= 0)) {
      toast({
        title: "Approved USD/ZMW rate required",
        description: "Enter a company exchange rate effective on the voucher date before posting.",
        variant: "destructive",
      });
      return;
    }
    const validEntries = data.entries.filter((entry) => entry.accountId > 0 && parseFloat(entry.amount || "0") > 0);
    if (validEntries.length === 0) {
      toast({
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
      toast({
        title: "Validation Error",
        description: "Invalid amounts detected. Please check your entries.",
        variant: "destructive",
      });
      return;
    }
    if (isWalletPayment && !(await confirmWalletPayment(validEntries, toast))) return;
    saveMutation.mutate({ ...data, entries: validEntries });
  };

  return (
    <div
      className={`space-y-4 md:space-y-5 ${isPOS ? "pos-stock-transfer-page" : ""} ${!isPOS && (activeTab === "payment" || activeTab === "receipt" || activeTab === "journal") ? `voucher-workspace voucher-workspace--${activeTab}` : ""}`}
    >
      {isPOS ? (
        <PageHeader
          title="Stock Transfer"
          subtitle="Transfer stock between locations"
          icon={<ArrowRightLeft className="h-6 w-6" aria-hidden="true" />}
        />
      ) : (
        // One header for ERP, Factory and Properties; the drafts link is ERP-only via showOptionalDrafts.
        <PageHeader title="Vouchers" subtitle="Create and manage payment, receipt, and journal entries">
          {showOptionalDrafts && (
            <Link
              href="/optional-vouchers"
              className="inline-flex min-h-10 items-center rounded-lg border bg-card px-3 text-sm font-medium hover:bg-muted"
              data-testid="link-vouchers-optional-drafts"
            >
              Optional voucher drafts
            </Link>
          )}
        </PageHeader>
      )}

      {!isPOS && (
        <div className="hidden">
          <div ref={printRef}>
            <PrintTemplate
              voucherType={activeTab === "payment" ? "Payment" : "Receipt"}
              paymentAccountName={paymentAccountName}
              date={form.watch("voucherDate")}
              entries={entries.filter((e) => e.accountId > 0 && e.amount)}
              notes={form.watch("notes") || ""}
              total={total}
              formatAmount={formatAmount}
              companyName={selectedCompany?.name || ""}
            />
          </div>
        </div>
      )}

      {bankAccountsError || ledgerAccountsError || sidebarAccountsError ? (
        <ErrorState
          title="Voucher accounts unavailable"
          description="Some account choices could not be loaded. Retry before entering a voucher."
          actionLabel="Retry account data"
          onAction={() => {
            void refetchBankAccounts();
            void refetchLedgerAccounts();
            void refetchSidebarAccounts();
          }}
          className="border-destructive/30"
        />
      ) : null}

      {!isPOS && (
        <VoucherMobileTabs
          visibleSidebarGroups={visibleSidebarGroups}
          activeTab={activeTab}
          setActiveTab={(tab) => setActiveTab(tab as typeof activeTab)}
        />
      )}

      <div className="flex gap-5">
        {!isPOS && (
          <VoucherDesktopNav
            visibleSidebarGroups={visibleSidebarGroups}
            activeTab={activeTab}
            setActiveTab={(tab) => setActiveTab(tab as typeof activeTab)}
          />
        )}

        <div className="flex-1 min-w-0">
          {!isPOS && isFactoryMode && visibleVoucherTabs.length === 0 && (
            <div className="rounded-md border p-6 text-sm text-muted-foreground">
              No Voucher tabs are available for this user.
            </div>
          )}
          {!isPOS && canShowVoucherTab("payment") && activeTab === "payment" && (
            <div className="space-y-4">
              <PaymentDraftAndRateBar
                draftAge={hasPaymentDraft && !voucherIdToEdit ? paymentDraftAge : null}
                draftLabel="Unsaved payment draft found"
                onRestoreDraft={restorePaymentDraft}
                onDiscardDraft={discardPaymentDraft}
                selectedCurrency={paymentPostingCurrency}
                transactionRate={paymentPostingCurrency === "ZMW" ? paymentPostingRate : transactionRate}
                setTransactionRate={setTransactionRate}
              />
              <PaymentVoucherTab
                form={form}
                fieldArray={fieldArray}
                entries={entries}
                total={total}
                paymentAccountId={paymentAccountId}
                paymentAccountType={paymentAccountType}
                paymentAccountName={paymentAccountName}
                accountBalance={accountBalance}
                accountCurrencyBalances={accountCurrencyBalances}
                allAccounts={allAccounts}
                payFromAccounts={paymentPayFromAccounts}
                sidebarAccounts={sidebarAccounts}
                isEditMode={!!voucherIdToEdit}
                filteredSidebarAccounts={filteredSidebarAccounts}
                sidebarSearchValue={sidebarSearchValue}
                setSidebarSearchValue={setSidebarSearchValue}
                sidebarHighlightedIndex={sidebarHighlightedIndex}
                setSidebarHighlightedIndex={setSidebarHighlightedIndex}
                selectedAccountId={selectedAccountId}
                selectedAccountType={selectedAccountType}
                handleSidebarAccountSelect={handleSidebarAccountSelect}
                handleAmountCommit={handleAmountCommit}
                handlePrint={handlePrint}
                handleExportVoucher={handleExportVoucher}
                onSubmit={onSubmit}
                activeTab="payment"
                activeRowIndex={activeRowIndex}
                setActiveRowIndex={setActiveRowIndex}
                onCreateAccount={() => handleOpenCreateAccountModal("payment", activeRowIndex ?? undefined)}
                isFactoryCompany={isFactoryCompany}
                onAutoCreateAccount={handleAutoCreateAccount}
                isAutoCreating={isAutoCreating}
                originalTotal={originalTotal}
                isPending={saveMutation.isPending}
                fxWallet={selectedFxWallet}
                fxWalletsLoading={fxWalletsLoading && isFactoryMode}
                fxPaymentRate={fxPaymentRate}
                onFxPaymentRateChange={setFxPaymentRate}
                fxPayoutCurrency={fxPayoutCurrency}
                fxSupplierEurBalance={fxSupplierId ? fxSupplierEurBalance : null}
                fxSupplierEurBasis={fxSupplierEurBasis}
                fxSupplierBalanceLoading={fxSupplierBalanceLoading}
                onFxPayoutCurrencyChange={changeFxPayoutCurrency}
                voucherNumber={voucherToEdit?.voucherNumber}
                onAccountPickerOpen={() => setAccountPickersNeeded(true)}
                onAccountSearchChange={setLiveAccountSearch}
                effectiveDate={voucherEffectiveDate}
                onEffectiveDateChange={setVoucherEffectiveDate}
              />
            </div>
          )}

          {!isPOS && canShowVoucherTab("receipt") && activeTab === "receipt" && (
            <div className="space-y-4">
              <PaymentDraftAndRateBar
                draftAge={hasPaymentDraft && !voucherIdToEdit ? paymentDraftAge : null}
                draftLabel="Unsaved receipt draft found"
                onRestoreDraft={restorePaymentDraft}
                onDiscardDraft={discardPaymentDraft}
                selectedCurrency={selectedCurrency}
                transactionRate={transactionRate}
                setTransactionRate={setTransactionRate}
              />
              <ReceiptVoucherTab
                form={form}
                fieldArray={fieldArray}
                entries={entries}
                total={total}
                paymentAccountId={paymentAccountId}
                paymentAccountType={paymentAccountType}
                paymentAccountName={paymentAccountName}
                accountBalance={accountBalance}
                accountCurrencyBalances={accountCurrencyBalances}
                allAccounts={allAccounts}
                payFromAccounts={payFromAccounts}
                sidebarAccounts={sidebarAccounts}
                isEditMode={!!voucherIdToEdit}
                filteredSidebarAccounts={filteredSidebarAccounts}
                sidebarSearchValue={sidebarSearchValue}
                setSidebarSearchValue={setSidebarSearchValue}
                sidebarHighlightedIndex={sidebarHighlightedIndex}
                setSidebarHighlightedIndex={setSidebarHighlightedIndex}
                selectedAccountId={selectedAccountId}
                selectedAccountType={selectedAccountType}
                handleSidebarAccountSelect={handleSidebarAccountSelect}
                handleAmountCommit={handleAmountCommit}
                handlePrint={handlePrint}
                handleExportVoucher={handleExportVoucher}
                onSubmit={onSubmit}
                activeTab="receipt"
                activeRowIndex={activeRowIndex}
                setActiveRowIndex={setActiveRowIndex}
                onCreateAccount={() => handleOpenCreateAccountModal("receipt", activeRowIndex ?? undefined)}
                isFactoryCompany={isFactoryCompany}
                onAutoCreateAccount={handleAutoCreateAccount}
                isAutoCreating={isAutoCreating}
                originalTotal={originalTotal}
                isPending={saveMutation.isPending}
                voucherNumber={voucherToEdit?.voucherNumber}
                onAccountPickerOpen={() => setAccountPickersNeeded(true)}
                onAccountSearchChange={setLiveAccountSearch}
                effectiveDate={voucherEffectiveDate}
                onEffectiveDateChange={setVoucherEffectiveDate}
              />
            </div>
          )}

          {!isPOS && canShowVoucherTab("journal") && activeTab === "journal" && (
            <JournalForm voucherIdToEdit={voucherIdToEdit} isPOS={isPOS} />
          )}

          {(isPOS || (canShowVoucherTab("transfer") && activeTab === "transfer")) && (
            <StockTransferForm voucherIdToEdit={voucherIdToEdit} isPOS={isPOS} posUser={posUser ?? undefined} />
          )}

          {!isPOS && canShowVoucherTab("adjustment") && activeTab === "adjustment" && (
            <StockAdjustmentForm voucherIdToEdit={voucherIdToEdit} isPOS={isPOS} />
          )}

          {!isPOS && canShowVoucherTab("creditnote") && activeTab === "creditnote" && (
            <div className="space-y-4">
              <CreditNoteTab
                allAccounts={allAccounts}
                editVoucherId={activeTab === "creditnote" ? editVoucherId : null}
              />
            </div>
          )}

          {!isPOS && canShowVoucherTab("transferorder") && activeTab === "transferorder" && (
            <StockTransferOrder
              onSwitchToNormalView={() => {
                setActiveTab("transfer");
                if (voucherIdToEdit) {
                  setLocation(`/vouchers?edit=${voucherIdToEdit}&tab=transfer`);
                }
              }}
            />
          )}
        </div>
      </div>

      <CreateAccountModal
        open={showCreateAccountModal}
        onClose={() => {
          setShowCreateAccountModal(false);
          setCreateAccountContext(null);
        }}
        companyId={selectedCompany?.id || 0}
        onAccountCreated={handleAccountCreated}
        apiRequestFn={modeApiRequest}
      />

      <AlertDialog
        open={!!waPendingPrompt}
        onOpenChange={(open) => {
          if (!open) setWaPendingPrompt(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-whatsapp-prompt">
          <AlertDialogHeader>
            <AlertDialogTitle>Send Statement via WhatsApp?</AlertDialogTitle>
            <AlertDialogDescription>
              A WhatsApp statement is configured for this account. Would you like to send the{" "}
              <strong>{waPendingPrompt?.month}</strong> statement now, or skip and send it manually later?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-whatsapp-skip" onClick={() => setWaPendingPrompt(null)}>
              Skip for Now
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-whatsapp-send"
              disabled={sendWaStatementMutation.isPending}
              onClick={() => waPendingPrompt && sendWaStatementMutation.mutate(waPendingPrompt)}
            >
              {sendWaStatementMutation.isPending ? "Sending..." : "Send Now"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
