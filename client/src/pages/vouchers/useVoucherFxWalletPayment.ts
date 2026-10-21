/**
 * FX agent wallet payments for the Payment voucher (b0de355, #2404, #2405):
 * a Pay From ledger can be an FX agent whose balance is native EUR. Paying
 * from it posts one atomic settlement (Payment voucher + EUR wallet movement)
 * instead of the generic USD voucher. Extracted from pages/Vouchers.tsx.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import Decimal from "decimal.js";
import { format } from "date-fns";
import type { CombinedAccount } from "@/components/AccountAutocomplete";
import type { VoucherFormData } from "@/pages/vouchers/voucherTypes";

type ApiRequest = (method: string, url: string, body?: unknown) => Promise<Response>;
type Toast = (options: { title: string; description?: string; variant?: "destructive" }) => unknown;

export function useVoucherFxWalletPayment({
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
}: {
  selectedCompany: { id: number } | null | undefined;
  isFactoryMode: boolean;
  isFactoryCompany: boolean;
  isPOS: boolean;
  activeTab: string;
  voucherIdToEdit: number | null;
  paymentAccountType: string;
  paymentAccountId: number;
  entries: VoucherFormData["entries"];
  form: UseFormReturn<VoucherFormData>;
  payFromAccounts: CombinedAccount[];
}) {
  const [fxPaymentRate, setFxPaymentRate] = useState("");
  const [fxCurrencyOverride, setFxCurrencyOverride] = useState<{
    beneficiary: string;
    currency: "EUR" | "USD";
  } | null>(null);
  const fxPaymentRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);

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
  const selectedFxWallet =
    activeTab === "payment" && !voucherIdToEdit && paymentAccountType === "ledger"
      ? fxWallets?.wallets?.find((w) => w.wallet.ledgerAccountId === paymentAccountId)
      : undefined;

  // A broker's EUR payable is its Parties settlement pool, NOT its GL EUR lines.
  // Other suppliers still use their posted native EUR ledger payable.
  const fxSelectedBeneficiary = entries[0];
  const fxSupplierId =
    selectedFxWallet && fxSelectedBeneficiary?.accountType === "factorySupplier" ? fxSelectedBeneficiary.accountId : 0;
  const {
    data: fxSupplierBalance,
    isPending: fxSupplierBalancePending,
    isError: fxSupplierBalanceError,
  } = useQuery<{
    fxEurPayable?: {
      balance: string;
      basis: "broker-statement" | "native-ledger";
      includeOtw: boolean;
      eligible: boolean;
    };
  }>({
    queryKey: ["/api/factory/suppliers", selectedCompany?.id, fxSupplierId, "balance", "fx-payment"],
    queryFn: async () => {
      const response = await fetch(`/api/factory/suppliers/${fxSupplierId}/balance?fxEurPayout=true`, {
        credentials: "include",
      });
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
      : fxSupplierId && fxSupplierEurBalance > 0
        ? "EUR"
        : "USD";
  const fxSupplierBalanceLoading = !!fxSupplierId && (fxSupplierBalancePending || fxSupplierBalanceError);
  // When an async currency lookup changes the payout from USD to EUR, never
  // silently reinterpret an amount typed while the lookup was loading.
  useEffect(() => {
    if (!fxSupplierId || !fxSupplierBalance?.fxEurPayable || fxCurrencyOverride?.beneficiary === fxBeneficiaryKey)
      return;
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
      type: "ledger" as const,
      id: w.wallet.ledgerAccountId,
      name: w.wallet.accountName + " (FX EUR)",
      code: "FX",
    }));
    const present = new Set(payFromAccounts.map((account) => account.type + ":" + account.id));
    return [...payFromAccounts, ...walletAccounts.filter((a) => !present.has("ledger:" + a.id))].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }, [payFromAccounts, fxWallets?.wallets]);

  const isWalletPayment = !!selectedFxWallet && activeTab === "payment" && !voucherIdToEdit;

  /** Validates and posts the wallet settlement; only called when isWalletPayment. */
  async function postWalletPayment(
    formData: VoucherFormData,
    {
      selectedCurrency,
      voucherEffectiveDate,
      modeApiRequest,
    }: { selectedCurrency: string; voucherEffectiveDate: string; modeApiRequest: ApiRequest }
  ) {
    // One atomic FX settlement creates a Payment voucher and a native EUR
    // wallet movement. Do not also submit to the generic USD voucher path.
    if (!selectedFxWallet) throw new Error("Choose an FX agent wallet");
    if (!navigator.onLine) throw new Error("FX payments must be posted online");
    if (!selectedFxWallet.synchronized) throw new Error("FX agent ledger needs reconciliation");
    if (fxSupplierBalanceLoading) throw new Error("Wait until the supplier's currency balance has loaded");
    if (fxPayoutCurrency === "USD" && selectedCurrency !== "USD") {
      throw new Error("Select USD as the display currency before entering a USD payout");
    }
    if (formData.optional) throw new Error("FX payments cannot be optional vouchers");
    if (fxPayoutCurrency === "USD" && (!/^\d+(?:\.\d{1,10})?$/.test(fxPaymentRate) || Number(fxPaymentRate) <= 0)) {
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
    if (
      fxPayoutCurrency === "EUR" &&
      (beneficiary.accountType !== "factorySupplier" || fxSupplierEurBalance <= 0 || amount.gt(fxSupplierEurBalance))
    ) {
      throw new Error("Choose a supplier with an outstanding EUR payable and do not exceed its EUR balance");
    }
    const eurNeeded = fxPayoutCurrency === "EUR" ? amount : amount.div(new Decimal(fxPaymentRate)).toDecimalPlaces(6);
    if (eurNeeded.lte(0) || eurNeeded.gt(new Decimal(selectedFxWallet.state.eur))) {
      throw new Error("FX agent has insufficient EUR for this USD payment");
    }
    if (fxPayoutCurrency === "USD" && !eurNeeded.times(new Decimal(fxPaymentRate)).toDecimalPlaces(2).eq(amount)) {
      throw new Error("USD amount cannot be paid precisely at this rate; adjust the amount or rate");
    }
    const date = format(formData.voucherDate, "yyyy-MM-dd");
    if (voucherEffectiveDate && voucherEffectiveDate !== date) {
      throw new Error("FX agent Payment Voucher requires the effective date to match the voucher date");
    }
    const fingerprint = JSON.stringify({
      walletId: selectedFxWallet.wallet.id,
      date,
      effectiveDate: voucherEffectiveDate || null,
      beneficiary: beneficiary.accountType + ":" + beneficiary.accountId,
      payoutCurrency: fxPayoutCurrency,
      amount: amount.toFixed(2),
      rate: fxPayoutCurrency === "USD" ? fxPaymentRate : null,
      notes: formData.notes,
      narration: beneficiary.narration,
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

  /** Asks the user to confirm the wallet payment; false when it must not be posted. */
  function confirmWalletPayment(validEntries: VoucherFormData["entries"], toast: Toast): boolean {
    if (!selectedFxWallet) return false;
    const rate = Number(fxPaymentRate);
    const amount = Number(validEntries[0]?.amount || 0);
    const directEur = fxPayoutCurrency === "EUR";
    const eurAmount = directEur ? amount : rate > 0 ? amount / rate : 0;
    if (
      fxSupplierBalanceLoading ||
      !Number.isFinite(eurAmount) ||
      eurAmount <= 0 ||
      validEntries.length !== 1 ||
      (!directEur && !fxPaymentRate) ||
      !["ledger", "factorySupplier"].includes(validEntries[0].accountType) ||
      (directEur && (validEntries[0].accountType !== "factorySupplier" || eurAmount > fxSupplierEurBalance))
    ) {
      toast({
        title: "Payment details required",
        description: directEur
          ? "Choose a EUR supplier payable and enter an amount within its EUR balance."
          : "Choose one USD recipient, amount, and agreed EUR rate.",
        variant: "destructive",
      });
      return false;
    }
    const paymentDetails = directEur
      ? "Supplier receives: EUR " +
        amount.toFixed(2) +
        "\\n" +
        "Agent EUR deducted: EUR " +
        amount.toFixed(2) +
        "\\n" +
        "No currency exchange or rate entry is needed."
      : "USD recipient receives: " +
        amount.toFixed(2) +
        "\\n" +
        "Agreed USD/EUR rate: " +
        fxPaymentRate +
        "\\n" +
        "EUR deducted (approx.): " +
        eurAmount.toFixed(6) +
        "\\n" +
        "FX gain/loss is booked automatically.";
    if (
      !window.confirm(
        "Post Payment Voucher?\\n" +
          "From: " +
          selectedFxWallet.wallet.accountName +
          "\\n" +
          "To: " +
          validEntries[0].accountName +
          "\\n" +
          paymentDetails
      )
    )
      return false;
    return true;
  }

  function resetWalletPayment() {
    fxPaymentRequestRef.current = null;
    setFxPaymentRate("");
    setFxCurrencyOverride(null);
  }

  return {
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
  };
}
