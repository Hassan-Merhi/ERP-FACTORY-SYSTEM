import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef, useEffect, useMemo } from "react";
import Decimal from "decimal.js";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useForm, useFieldArray, useWatch } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { format } from "date-fns";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { ExchangeRateInput } from "@/components/ExchangeRateInput";
import { useReactToPrint } from "react-to-print";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { VoucherEditDialog } from "@/components/VoucherEditDialog";
import type { Account } from "@/components/AccountSidebar";
import { PaymentVoucherTab } from "@/components/vouchers/PaymentVoucherTab";
import { ReceiptVoucherTab } from "@/components/vouchers/ReceiptVoucherTab";
import { CreditNoteTab } from "@/components/vouchers/CreditNoteTab";
import { CreateAccountModal } from "@/components/vouchers/CreateAccountModal";
import { PageHeader } from "@/components/PageHeader";
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
import { queryClient, invalidateContainerLandedCostQueries } from "@/lib/queryClient";
import { useAppMode, useModePrefix } from "@/contexts/AppModeContext";
import { resolveWhatsAppPrompt } from "@/lib/whatsapp-prompt";
import type { WhatsAppPromptState } from "@/lib/whatsapp-prompt";
import { getApiRequest } from "@/lib/factoryApi";
import type { AuthMe, FactoryMyAccess } from "@shared/apiTypes";
import { useFormDraft } from "@/hooks/useFormDraft";
import { DraftRestorePrompt } from "@/components/DraftRestorePrompt";
import {
  ArrowDownCircle,
  ArrowUpCircle,
  BookOpen,
  ArrowLeftRight,
  SlidersHorizontal,
  FileText,
  ClipboardList,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import StockTransferOrder from "@/pages/StockTransferOrder.tsx";
import { PrintTemplate } from "@/components/vouchers/PrintTemplate";
import { StockTransferForm } from "@/pages/vouchers/StockTransferForm";
import { StockAdjustmentForm } from "@/pages/vouchers/StockAdjustmentForm";
import { JournalForm } from "@/pages/vouchers/JournalForm";
import { VoucherMobileTabs, VoucherDesktopNav } from "@/pages/vouchers/VoucherTabNav";
import { useVoucherQueries } from "@/pages/vouchers/useVoucherQueries";
import { useVoucherHandlers } from "@/pages/vouchers/useVoucherHandlers";
import { useSidebarSync } from "@/pages/vouchers/useSidebarSync";
import { useAccountBalance } from "@/pages/vouchers/useAccountBalance";
import { useVoucherHydration } from "@/pages/vouchers/useVoucherHydration";
import { exportVoucherHelper } from "@/pages/vouchers/voucherActions";
import { voucherFormSchema } from "@/pages/vouchers/voucherTypes";
import type { VoucherFormData } from "@/pages/vouchers/voucherTypes";
import { ErrorState } from "@/components/ui/page-state";
import { useHubQueryState } from "@/hooks/use-hub-query-state";

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
  const [fxPaymentRate, setFxPaymentRate] = useState("");
  const [fxCurrencyOverride, setFxCurrencyOverride] = useState<{
    beneficiary: string; currency: "EUR" | "USD";
  } | null>(null);
  const fxPaymentRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const [, setLocation] = useLocation();
  const printRef = useRef<HTMLDivElement>(null);
  const isPOS = !!posUser;
  const posLocationId = posUser?.assignedLocationId;

  const sidebarGroups: { label: string; color: string; items: { key: string; label: string; icon: LucideIcon }[] }[] = [
    {
      label: "Financial",
      color: "#3b82f6",
      items: [
        { key: "payment", label: "Payment", icon: ArrowDownCircle },
        { key: "receipt", label: "Receipt", icon: ArrowUpCircle },
        { key: "journal", label: "Journal", icon: BookOpen },
      ],
    },
    {
      label: "Adjustments",
      color: "#f59e0b",
      items: [
        { key: "transfer", label: "Stock Transfer", icon: ArrowLeftRight },
        { key: "transferorder", label: "Transfer Order", icon: ClipboardList },
        { key: "adjustment", label: "Adjustment", icon: SlidersHorizontal },
        { key: "creditnote", label: "Credit Note", icon: FileText },
      ],
    },
  ];

  const searchParams = new URLSearchParams(window.location.search);
  const editParam = searchParams.get("edit");
  const voucherIdToEdit = editParam ? parseInt(editParam) : null;

  const [editVoucherId, setEditVoucherId] = useState<number | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [accountPickersNeeded, setAccountPickersNeeded] = useState(() => !!voucherIdToEdit);

  const isFactoryMode = appMode === "factory";
  const { data: factoryAccess } = useQuery<FactoryMyAccess>({
    queryKey: ["/api/factory/my-access"],
    staleTime: 5 * 60000,
    enabled: isFactoryMode && !isPOS,
  });
  const factoryHiddenTabs = factoryAccess?.hiddenCostFields ?? [];
  const visibleSidebarGroups = isFactoryMode
    ? sidebarGroups
        .map((group) => ({
          ...group,
          items: group.items.filter(
            (item) => !factoryHiddenTabs.includes(FACTORY_VOUCHER_HIDDEN_KEYS[item.key as VoucherTab])
          ),
        }))
        .filter((group) => group.items.length > 0)
    : sidebarGroups;
  const visibleVoucherTabs = visibleSidebarGroups.flatMap((group) => group.items.map((item) => item.key as VoucherTab));
  const fallbackVoucherTab = visibleVoucherTabs[0] ?? null;
  const canShowVoucherTab = (tab: VoucherTab) => !isFactoryMode || visibleVoucherTabs.includes(tab);
  const allowedVoucherTabs = isFactoryMode && !isPOS ? visibleVoucherTabs : ALL_VOUCHER_TABS;
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

  // Pay From can be an FX agent ledger. Wallet balances are native EUR,
  // while regular account balances are only historical USD book values.
  const { data: fxWallets, isLoading: fxWalletsLoading } = useQuery<{
    wallets: Array<{
      wallet: { id: number; ledgerAccountId: number; accountName: string };
      state: { eur: string; usd: string; totalBookUsd: string };
      synchronized: boolean;
    }>;
  }>({
    queryKey: ["/api/factory/fx-agent-wallets", selectedCompany?.id, "payment"],
    queryFn: async () => {
      const res = await fetch("/api/factory/fx-agent-wallets", { credentials: "include" });
      if (!res.ok) throw new Error("Unable to load FX agent wallet balances");
      return res.json();
    },
    enabled: isFactoryMode && isFactoryCompany && !isPOS,
    staleTime: 15_000,
  });
  const selectedFxWallet = activeTab === "payment" && !voucherIdToEdit &&
    paymentAccountType === "ledger"
    ? fxWallets?.wallets?.find((w) => w.wallet.ledgerAccountId === paymentAccountId)
    : undefined;

  // A broker's EUR payable is its Parties settlement pool, NOT its GL EUR lines.
  // Other suppliers still use their posted native EUR ledger payable.
  const fxSelectedBeneficiary = entries[0];
  const fxSupplierId = selectedFxWallet && fxSelectedBeneficiary?.accountType === "factorySupplier"
    ? fxSelectedBeneficiary.accountId : 0;
  const {
    data: fxSupplierBalance,
    isPending: fxSupplierBalancePending,
    isError: fxSupplierBalanceError,
  } = useQuery<{
    fxEurPayable?: { balance: string; basis: "broker-statement" | "native-ledger"; includeOtw: boolean; eligible: boolean };
  }>({
    queryKey: ["/api/factory/suppliers", selectedCompany?.id, fxSupplierId, "balance", "fx-payment"],
    queryFn: async () => {
      const response = await fetch(`/api/factory/suppliers/${fxSupplierId}/balance?fxEurPayout=true`, { credentials: "include" });
      if (!response.ok) throw new Error("Unable to load supplier currency balance");
      return response.json();
    },
    enabled: !!fxSupplierId && isFactoryMode && !isPOS,
    staleTime: 15_000,
  });
  const fxSupplierEurBalance = fxSupplierBalance?.fxEurPayable?.eligible
    ? Math.max(0, Number(fxSupplierBalance.fxEurPayable.balance))
    : 0;
  const fxSupplierEurBasis = fxSupplierBalance?.fxEurPayable?.basis ?? null;
  const fxBeneficiaryKey = `${selectedCompany?.id}:${fxSelectedBeneficiary?.accountType}:${fxSelectedBeneficiary?.accountId}`;
  const fxPayoutCurrency: "EUR" | "USD" =
    fxCurrencyOverride?.beneficiary === fxBeneficiaryKey
      ? fxCurrencyOverride.currency
      : fxSupplierId && fxSupplierEurBalance > 0 ? "EUR" : "USD";
  const fxSupplierBalanceLoading = !!fxSupplierId && (fxSupplierBalancePending || fxSupplierBalanceError);
  // When an async currency lookup changes the payout from USD to EUR, never
  // silently reinterpret an amount typed while the lookup was loading.
  useEffect(() => {
    if (!fxSupplierId || !fxSupplierBalance?.fxEurPayable ||
        fxCurrencyOverride?.beneficiary === fxBeneficiaryKey) return;
    if (Number(form.getValues("entries.0.amount") || 0) > 0) {
      form.setValue("entries.0.amount", "");
    }
    setFxCurrencyOverride({
      beneficiary: fxBeneficiaryKey,
      currency: fxSupplierBalance.fxEurPayable.eligible ? "EUR" : "USD",
    });
  }, [fxSupplierId, fxSupplierBalance?.fxEurPayable, fxBeneficiaryKey, fxCurrencyOverride, form]);
  const changeFxPayoutCurrency = (currency: "EUR" | "USD") => {
    if (currency === fxPayoutCurrency) return;
    setFxCurrencyOverride({ beneficiary: fxBeneficiaryKey, currency });
    // Never reuse a USD number as EUR (or vice versa).
    form.setValue("entries.0.amount", "");
  };

  // Most source pickers offer Cash/Bank only. Add active FX agent ledgers so
  // they are selectable directly in Pay From without editing their account.
  const paymentPayFromAccounts = useMemo(() => {
    const walletAccounts = (fxWallets?.wallets || []).map((w) => ({
      type: "ledger" as const, id: w.wallet.ledgerAccountId,
      name: w.wallet.accountName + " (FX EUR)", code: "FX",
    }));
    const present = new Set(payFromAccounts.map((account) => account.type + ":" + account.id));
    return [...payFromAccounts, ...walletAccounts.filter((a) => !present.has("ledger:" + a.id))]
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [payFromAccounts, fxWallets?.wallets]);

  const saveMutation = useMutation({
    mutationFn: async (formData: VoucherFormData) => {
      // One atomic FX settlement creates a Payment voucher and a native EUR
      // wallet movement. Do not also submit to the generic USD voucher path.
      if (selectedFxWallet && activeTab === "payment" && !voucherIdToEdit) {
        if (!navigator.onLine) throw new Error("FX payments must be posted online");
        if (!selectedFxWallet.synchronized) throw new Error("FX agent ledger needs reconciliation");
        if (fxSupplierBalanceLoading) throw new Error("Wait until the supplier's currency balance has loaded");
        if (fxPayoutCurrency === "USD" && selectedCurrency !== "USD") {
          throw new Error("Select USD as the display currency before entering a USD payout");
        }
        if (formData.optional) throw new Error("FX payments cannot be optional vouchers");
        if (fxPayoutCurrency === "USD" &&
            (!/^\d+(?:\.\d{1,10})?$/.test(fxPaymentRate) || Number(fxPaymentRate) <= 0)) {
          throw new Error("Enter the negotiated USD per EUR payment rate");
        }
        if (formData.entries.length !== 1) {
          throw new Error("FX agent payment supports one beneficiary per voucher");
        }
        const [beneficiary] = formData.entries;
        if (!["ledger", "factorySupplier"].includes(beneficiary.accountType)) {
          throw new Error("Choose a factory supplier or ledger account as the beneficiary");
        }
        if (beneficiary.accountType === "ledger" && beneficiary.accountId === selectedFxWallet.wallet.ledgerAccountId) {
          throw new Error("FX agent cannot pay itself");
        }
        if (!/^\d+(?:\.\d{1,2})?$/.test(beneficiary.amount)) {
          throw new Error("Payment must be positive with at most 2 decimal places");
        }
        const amount = new Decimal(beneficiary.amount);
        if (amount.lte(0)) throw new Error("Payment must be positive");
        if (fxPayoutCurrency === "EUR" &&
            (beneficiary.accountType !== "factorySupplier" || fxSupplierEurBalance <= 0 ||
              amount.gt(fxSupplierEurBalance))) {
          throw new Error("Choose a supplier with an outstanding EUR payable and do not exceed its EUR balance");
        }
        const eurNeeded = fxPayoutCurrency === "EUR"
          ? amount
          : amount.div(new Decimal(fxPaymentRate)).toDecimalPlaces(6);
        if (eurNeeded.lte(0) || eurNeeded.gt(new Decimal(selectedFxWallet.state.eur))) {
          throw new Error("FX agent has insufficient EUR for this USD payment");
        }
        if (fxPayoutCurrency === "USD" &&
            !eurNeeded.times(new Decimal(fxPaymentRate)).toDecimalPlaces(2).eq(amount)) {
          throw new Error("USD amount cannot be paid precisely at this rate; adjust the amount or rate");
        }
        const date = format(formData.voucherDate, "yyyy-MM-dd");
        if (voucherEffectiveDate && voucherEffectiveDate !== date) {
          throw new Error("FX agent Payment Voucher requires the effective date to match the voucher date");
        }
        const fingerprint = JSON.stringify({
          walletId: selectedFxWallet.wallet.id, date, effectiveDate: voucherEffectiveDate || null,
          beneficiary: beneficiary.accountType + ":" + beneficiary.accountId,
          payoutCurrency: fxPayoutCurrency, amount: amount.toFixed(2),
          rate: fxPayoutCurrency === "USD" ? fxPaymentRate : null,
          notes: formData.notes, narration: beneficiary.narration,
          paymentAccountNarration: formData.paymentAccountNarration,
        });
        if (fxPaymentRequestRef.current?.fingerprint !== fingerprint) {
          fxPaymentRequestRef.current = { fingerprint, key: crypto.randomUUID() };
        }
        const result = await modeApiRequest(
          "POST",
          "/api/factory/fx-agent-wallets/" + selectedFxWallet.wallet.id + "/settle",
          {
            paymentVoucher: true,
            targetCurrency: fxPayoutCurrency,
            ...(fxPayoutCurrency === "EUR"
              ? { eurAmount: amount.toFixed(2) }
              : { usdAmount: amount.toFixed(2), rateUsdPerEur: fxPaymentRate }),
            targetKind: beneficiary.accountType,
            targetId: beneficiary.accountId,
            date,
            requestKey: fxPaymentRequestRef.current.key,
            narration: formData.notes || "",
            paymentAccountNarration: formData.paymentAccountNarration || "",
            beneficiaryNarration: beneficiary.narration || "",
          }
        );
        return result.json();
      }
      const voucherType = activeTab === "payment" ? "Payment" : "Receipt";
      const isEditMode = !!voucherIdToEdit;
      const autoDesc = formData.notes?.trim()
        ? formData.notes.trim()
        : `${voucherType} (${formData.paymentAccountName || "—"})`;
      const payload = {
        voucherType,
        voucherDate: format(formData.voucherDate, "yyyy-MM-dd"),
        paymentAccountType: formData.paymentAccountType,
        paymentAccountId: formData.paymentAccountId,
        paymentAccountName: formData.paymentAccountName,
        paymentAccountNarration: formData.paymentAccountNarration,
        entries: formData.entries,
        notes: autoDesc,
        optional: formData.optional,
        currency: selectedCurrency,
        exchangeRate: exchangeRate ? exchangeRate.toString() : undefined,
        effectiveDate: voucherEffectiveDate || null,
      };
      if (isEditMode) {
        const res = await modeApiRequest("PATCH", `/api/vouchers/${voucherIdToEdit}/payment-receipt`, payload);
        return await res.json();
      } else {
        const res = await modeApiRequest("POST", "/api/vouchers/payment-receipt", payload);
        return await res.json();
      }
    },
    onSuccess: async (data) => {
      const isEditMode = !!voucherIdToEdit;
      toast({
        title: "Success",
        description: `${activeTab === "payment" ? "Payment" : "Receipt"} voucher ${isEditMode ? "updated" : "created"} successfully`,
      });
      const waPrompt = resolveWhatsAppPrompt(data);
      if (waPrompt) setWaPendingPrompt(waPrompt);
      discardPaymentDraft();
      fxPaymentRequestRef.current = null;
      setFxPaymentRate("");
      setFxCurrencyOverride(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/fx-agent-wallets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/net-position"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/voucher-sidebar"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts", paymentAccountType, paymentAccountId, "balance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bank-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers/stats", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats/net-profit"] });
      if (isEditMode) {
        invalidateContainerLandedCostQueries();
        setLocation(`${modePrefix}/daybook`);
      } else {
        form.reset({
          paymentAccountType: "ledger",
          paymentAccountId: 0,
          paymentAccountName: "",
          voucherDate: new Date(),
          entries: [{ accountType: "ledger", accountId: 0, accountName: "", amount: "" }],
          paymentAccountNarration: "",
          notes: "",
          optional: false,
        });
      }
    },
    onError: (error: ClientErrorLike, formData: VoucherFormData) => {
      if (error.name === "OfflineQueued") {
        const voucherType = activeTab === "payment" ? "Payment" : "Receipt";
        const syntheticVoucher = {
          id: -Date.now(),
          voucherNumber: "PENDING",
          voucherType,
          voucherDate: format(formData.voucherDate, "yyyy-MM-dd"),
          description: formData.notes || `${voucherType} (pending sync)`,
          totalAmount: formData.entries
            .filter((e) => parseFloat(e.amount || "0") > 0)
            .reduce((sum: number, e) => sum + parseFloat(e.amount || "0"), 0)
            .toFixed(2),
          optional: formData.optional || false,
          createdAt: new Date().toISOString(),
        };
        queryClient.setQueriesData({ queryKey: ["/api/vouchers"] }, (old) =>
          Array.isArray(old) ? [syntheticVoucher, ...old] : old
        );
        discardPaymentDraft();
        form.reset({
          paymentAccountType: "ledger",
          paymentAccountId: 0,
          paymentAccountName: "",
          voucherDate: new Date(),
          entries: [{ accountType: "ledger", accountId: 0, accountName: "", amount: "" }],
          paymentAccountNarration: "",
          notes: "",
          optional: false,
        });
        return;
      }
      if ((error as { _handledGlobally?: boolean })._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || `Failed to ${voucherIdToEdit ? "update" : "create"} voucher`,
        variant: "destructive",
      });
    },
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

  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: `${activeTab === "payment" ? "Payment" : "Receipt"}-Voucher-${format(form.watch("voucherDate"), "yyyy-MM-dd")}`,
  });

  const handleExportVoucher = (detailed: boolean) =>
    exportVoucherHelper({ formData: form.getValues(), activeTab, toast, detailed });

  const onSubmit = async (data: VoucherFormData) => {
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
    if (selectedFxWallet && activeTab === "payment" && !voucherIdToEdit) {
      const rate = Number(fxPaymentRate);
      const amount = Number(validEntries[0]?.amount || 0);
      const directEur = fxPayoutCurrency === "EUR";
      const eurAmount = directEur ? amount : rate > 0 ? amount / rate : 0;
      if (fxSupplierBalanceLoading || !Number.isFinite(eurAmount) || eurAmount <= 0 ||
          validEntries.length !== 1 || (!directEur && !fxPaymentRate) ||
          !["ledger", "factorySupplier"].includes(validEntries[0].accountType) ||
          (directEur && (validEntries[0].accountType !== "factorySupplier" ||
            eurAmount > fxSupplierEurBalance))) {
        toast({
          title: "Payment details required",
          description: directEur
            ? "Choose a EUR supplier payable and enter an amount within its EUR balance."
            : "Choose one USD recipient, amount, and agreed EUR rate.",
          variant: "destructive",
        });
        return;
      }
      const paymentDetails = directEur
        ? "Supplier receives: EUR " + amount.toFixed(2) + "\\n" +
          "Agent EUR deducted: EUR " + amount.toFixed(2) + "\\n" +
          "No currency exchange or rate entry is needed."
        : "USD recipient receives: " + amount.toFixed(2) + "\\n" +
          "Agreed USD/EUR rate: " + fxPaymentRate + "\\n" +
          "EUR deducted (approx.): " + eurAmount.toFixed(6) + "\\n" +
          "FX gain/loss is booked automatically.";
      if (!window.confirm(
        "Post Payment Voucher?\\n" +
          "From: " + selectedFxWallet.wallet.accountName + "\\n" +
          "To: " + validEntries[0].accountName + "\\n" + paymentDetails
      )) return;
    }
    saveMutation.mutate({ ...data, entries: validEntries });
  };

  return (
    <div className="space-y-4 md:space-y-5">
      {isPOS ? (
        <PageHeader title="Stock Transfer" subtitle="Transfer stock between locations" />
      ) : !isFactoryMode ? (
        <PageHeader title="Vouchers" />
      ) : (
        <div className="flex items-start justify-between gap-3 pb-4 border-b">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Vouchers</h1>
          </div>
        </div>
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
              {hasPaymentDraft && !voucherIdToEdit && paymentDraftAge && (
                <DraftRestorePrompt
                  draftAge={paymentDraftAge}
                  label="Unsaved payment draft found"
                  onRestore={() => {
                    if (paymentDraft?.data) {
                      const d = paymentDraft.data as unknown as object & { voucherDate: unknown } & {
                        voucherDate: string | number | Date;
                      };
                      form.reset({ ...d, voucherDate: d.voucherDate ? new Date(d.voucherDate) : new Date() });
                    }
                    discardPaymentDraft();
                  }}
                  onDiscard={discardPaymentDraft}
                />
              )}
              {selectedCurrency === "CFA" && (
                <div className="flex flex-wrap items-center gap-2 sm:gap-4 p-3 bg-muted/30 rounded-md">
                  <span className="text-sm text-muted-foreground">Transaction Rate:</span>
                  <ExchangeRateInput
                    value={transactionRate}
                    onChange={setTransactionRate}
                    selectedCurrency={selectedCurrency}
                  />
                </div>
              )}
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
              {hasPaymentDraft && !voucherIdToEdit && paymentDraftAge && (
                <DraftRestorePrompt
                  draftAge={paymentDraftAge}
                  label="Unsaved receipt draft found"
                  onRestore={() => {
                    if (paymentDraft?.data) {
                      const d = paymentDraft.data as unknown as object & { voucherDate: unknown } & {
                        voucherDate: string | number | Date;
                      };
                      form.reset({ ...d, voucherDate: d.voucherDate ? new Date(d.voucherDate) : new Date() });
                    }
                    discardPaymentDraft();
                  }}
                  onDiscard={discardPaymentDraft}
                />
              )}
              {selectedCurrency === "CFA" && (
                <div className="flex flex-wrap items-center gap-2 sm:gap-4 p-3 bg-muted/30 rounded-md">
                  <span className="text-sm text-muted-foreground">Transaction Rate:</span>
                  <ExchangeRateInput
                    value={transactionRate}
                    onChange={setTransactionRate}
                    selectedCurrency={selectedCurrency}
                  />
                </div>
              )}
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

      <VoucherEditDialog
        voucherId={editVoucherId}
        open={editDialogOpen}
        onOpenChange={(open) => {
          setEditDialogOpen(open);
          if (!open) setEditVoucherId(null);
        }}
      />

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
