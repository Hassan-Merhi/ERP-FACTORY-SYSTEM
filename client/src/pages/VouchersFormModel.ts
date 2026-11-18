// Extracted from ./VouchersModel.ts: voucher form state, currency and intercompany wiring for the Vouchers page.
import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm, useFieldArray, useWatch } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { format } from "date-fns";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useZmwVoucherRate } from "@/hooks/useZmwVoucherRate";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { useAppMode, useModePrefix } from "@/contexts/AppModeContext";
import type { WhatsAppPromptState } from "@/lib/whatsapp-prompt";
import { ALL_VOUCHER_TABS, FACTORY_VOUCHER_HIDDEN_KEYS } from "./vouchersPageSupport";
import type { VoucherTab, VouchersProps } from "./vouchersPageSupport";
import { getApiRequest } from "@/lib/factoryApi";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useFormDraft } from "@/hooks/useFormDraft";
import { useVoucherQueries } from "@/pages/vouchers/useVoucherQueries";
import { useVoucherHydration } from "@/pages/vouchers/useVoucherHydration";
import { buildVoucherSidebarGroups } from "@/pages/vouchers/voucherSidebarGroups";
import { canOpenIntercompanyVoucherTransfer } from "@/pages/vouchers/intercompanyTransferPolicy";
import type { VoucherSidebarGroup } from "@/pages/vouchers/voucherSidebarGroups";
import { voucherFormSchema } from "@/pages/vouchers/voucherTypes";
import type { VoucherFormData } from "@/pages/vouchers/voucherTypes";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { isRetailManualVoucherTabHidden, isRetailManualVoucherTypeHidden } from "@/lib/retailVoucherPolicy";
import { shouldShowFactoryVoucherTab } from "@/pages/vouchers/factoryVoucherPolicy";
import type { ErpFeatureAccess } from "@/app/erpAccess";
import { erpPageAccessQueryOptions } from "@/app/erpAccessQuery";

export function useVouchersFormModel({ posUser }: { posUser: { posUser: VouchersProps["posUser"] }["posUser"] }) {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const isFactoryCompany = selectedCompany?.companyType === "factory";
  const isRetailCompany = selectedCompany?.companyType === "retail";
  const isPropertiesCompany = selectedCompany?.companyType === "properties";
  const canUseIntercompanyVouchers = canOpenIntercompanyVoucherTransfer(
    selectedCompany,
    Boolean(posUser),
    Boolean(new URLSearchParams(window.location.search).get("edit"))
  );
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
  const showOptionalDrafts = !isPOS && (
    (appMode === "factory" && isFactoryCompany) ||
    (appMode === "erp" && !isRetailCompany &&
      (erpPageAccess?.fullAccess === true || erpPageAccess?.pageKeys.includes("optional_vouchers") === true))
  );
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
  const effectiveVoucherTabs = (isFactoryMode || isRetailCompany) && !isPOS ? visibleVoucherTabs : ALL_VOUCHER_TABS;
  const [activeTab, setActiveTab] = useHubQueryState<VoucherTab>({
    key: "tab",
    allowedValues: effectiveVoucherTabs,
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
  const paymentDraftType = activeTab === "receipt" ? "voucher-receipt" : "voucher-payment";
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
    enabled: !voucherIdToEdit && (activeTab === "payment" || activeTab === "receipt"),
  });

  const allFormValues = form.watch();
  useEffect(() => {
    if (voucherIdToEdit || (activeTab !== "payment" && activeTab !== "receipt")) return;
    schedulePaymentSave(allFormValues);
  }, [activeTab, allFormValues, schedulePaymentSave, voucherIdToEdit]);

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

  return {
    toast,
    selectedCompany,
    appMode,
    modeApiRequest,
    isFactoryCompany,
    canUseIntercompanyVouchers,
    isAutoCreating,
    setIsAutoCreating,
    formatAmount,
    selectedCurrency,
    transactionRate,
    setTransactionRate,
    voucherEffectiveDate,
    setVoucherEffectiveDate,
    setLocation,
    printRef,
    isPOS,
    showOptionalDrafts,
    voucherIdToEdit,
    editVoucherId,
    setAccountPickersNeeded,
    isFactoryMode,
    visibleSidebarGroups,
    visibleVoucherTabs,
    canShowVoucherTab,
    activeTab,
    setActiveTab,
    modePrefix,
    sidebarSearchValue,
    setSidebarSearchValue,
    sidebarHighlightedIndex,
    setSidebarHighlightedIndex,
    selectedAccountId,
    setSelectedAccountId,
    selectedAccountType,
    setSelectedAccountType,
    activeRowIndex,
    setActiveRowIndex,
    waPendingPrompt,
    setWaPendingPrompt,
    showCreateAccountModal,
    setShowCreateAccountModal,
    createAccountContext,
    setCreateAccountContext,
    bankAccounts,
    bankAccountsError,
    refetchBankAccounts,
    ledgerAccountsError,
    refetchLedgerAccounts,
    sidebarAccounts,
    sidebarAccountsError,
    refetchSidebarAccounts,
    voucherToEdit,
    allAccounts,
    payFromAccounts,
    setLiveAccountSearch,
    form,
    fieldArray,
    append,
    entries,
    paymentPostingCurrency,
    paymentPostingRate,
    watchedEntries,
    total,
    originalTotal,
    hasPaymentDraft,
    paymentDraftAge,
    paymentDraft,
    discardPaymentDraft,
  };
}
