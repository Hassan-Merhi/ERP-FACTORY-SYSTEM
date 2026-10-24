import { useEffect } from "react";
import { UseFormReturn } from "react-hook-form";
import { VoucherFormData } from "./VoucherEditSchemas";

export const useBalanceAdjustments = (
  isPaymentOrReceipt: boolean,
  paymentForm: UseFormReturn<VoucherFormData>,
  voucherType: string | undefined,
  exchangeRate: number | undefined,
  setBalanceAdjustments: (adjustments: Record<string, number>) => void
) => {
  useEffect(() => {
    if (!isPaymentOrReceipt) return;
    const subscription = paymentForm.watch((formValues) => {
      const newAdjustments: Record<string, number> = {};
      const paymentAccountType = formValues.paymentAccountType || "bank";
      const paymentAccountId = formValues.paymentAccountId || 0;
      const paymentKey = `${paymentAccountType}-${paymentAccountId}`;
      const entries = formValues.entries || [];
      let totalAmount = 0;
      entries.forEach((entry) => {
        if (!entry) return;
        const amount = parseFloat(entry.amount || "0");
        const accountId = entry.accountId || 0;
        const accountType = entry.accountType || "ledger";
        const entryUsdAmount =
          (formValues.currency === "CFA" || formValues.currency === "ZMW") && exchangeRate
            ? amount / exchangeRate
            : amount;
        totalAmount += entryUsdAmount;
        const entryKey = `${accountType}-${accountId}`;
        const isLiability =
          accountType === "supplier" || accountType === "factorySupplier" || accountType === "employee";
        const sign = (voucherType === "Payment" && !isLiability) || (voucherType === "Receipt" && isLiability) ? -1 : 1;
        newAdjustments[entryKey] = (newAdjustments[entryKey] || 0) + sign * entryUsdAmount;
      });
      const isPaymentLiability =
        paymentAccountType === "supplier" ||
        paymentAccountType === "factorySupplier" ||
        paymentAccountType === "employee";
      const paymentSign =
        (voucherType === "Receipt" && !isPaymentLiability) || (voucherType === "Payment" && isPaymentLiability)
          ? 1
          : -1;
      newAdjustments[paymentKey] = (newAdjustments[paymentKey] || 0) + paymentSign * totalAmount;
      setBalanceAdjustments(newAdjustments);
    });
    return () => subscription.unsubscribe();
  }, [isPaymentOrReceipt, paymentForm, voucherType, exchangeRate, setBalanceAdjustments]);
};
