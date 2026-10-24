import { format } from "date-fns";
import {
  VoucherFormData,
  JournalFormData,
  PurchaseFormData,
  SalesFormData,
  AdjustmentFormData,
  TransferFormData,
} from "./VoucherEditSchemas";

export const convertAmountToUSD = (amount: string, currency: string, exchangeRate: number | undefined): string => {
  if (currency === "CFA" || currency === "ZMW") {
    if (!exchangeRate || !Number.isFinite(exchangeRate) || exchangeRate <= 0) {
      throw new Error("A valid locked historical exchange rate is required for a foreign-currency voucher.");
    }
    return (Number(amount || "0") / exchangeRate).toFixed(2);
  }
  return amount;
};

export const preparePaymentReceiptData = (
  data: VoucherFormData,
  voucherType: string,
  exchangeRate: number | undefined
) => {
  const voucherUpdates = {
    voucherDate: format(data.voucherDate, "yyyy-MM-dd"),
    voucherType: voucherType,
    description: data.notes,
    currency: data.currency === "ZMW" ? "ZMW" : "USD",
    exchangeRate: data.currency === "ZMW" ? String(exchangeRate) : undefined,
  };

  // The with-entries edit endpoint receives native Kwacha amounts and
  // converts BOTH legs back to historical USD using the voucher's locked
  // rate. Mixing a USD payment leg with ZMW contra legs would not balance.
  const total = data.entries
    .reduce((sum, e) => {
      const amt = parseFloat(e.amount || "0");
      const postedAmount =
        data.currency === "ZMW" ? amt : data.currency === "CFA" && exchangeRate ? amt / exchangeRate : amt;
      return sum + postedAmount;
    }, 0)
    .toFixed(data.currency === "ZMW" ? 6 : 2);

  const isLiabilityPayment =
    data.paymentAccountType === "supplier" ||
    data.paymentAccountType === "factorySupplier" ||
    data.paymentAccountType === "employee";

  if (data.currency === "ZMW" && (!exchangeRate || !Number.isFinite(exchangeRate) || exchangeRate <= 0)) {
    throw new Error("The historical ZMW voucher has no valid locked exchange rate.");
  }

  const paymentEntry = {
    ledgerAccountId: data.paymentAccountType === "ledger" ? data.paymentAccountId : null,
    bankAccountId: data.paymentAccountType === "bank" ? data.paymentAccountId : null,
    supplierId: data.paymentAccountType === "supplier" ? data.paymentAccountId : null,
    factorySupplierId: data.paymentAccountType === "factorySupplier" ? data.paymentAccountId : null,
    employeeId: data.paymentAccountType === "employee" ? data.paymentAccountId : null,
    narration: data.paymentAccountNarration || null,
    debitAmount:
      (voucherType === "Receipt" && !isLiabilityPayment) || (voucherType === "Payment" && isLiabilityPayment)
        ? total
        : "0",
    creditAmount:
      (voucherType === "Payment" && !isLiabilityPayment) || (voucherType === "Receipt" && isLiabilityPayment)
        ? total
        : "0",
  };

  const contraEntries = data.entries.map((entry) => {
    const usdAmount =
      data.currency === "ZMW" ? entry.amount : convertAmountToUSD(entry.amount, data.currency, exchangeRate);
    return {
      ledgerAccountId: entry.accountType === "ledger" ? entry.accountId : null,
      bankAccountId: entry.accountType === "bank" ? entry.accountId : null,
      supplierId: entry.accountType === "supplier" ? entry.accountId : null,
      factorySupplierId: entry.accountType === "factorySupplier" ? entry.accountId : null,
      employeeId: entry.accountType === "employee" ? entry.accountId : null,
      debitAmount:
        (voucherType === "Payment" && !isLiabilityPayment) || (voucherType === "Receipt" && isLiabilityPayment)
          ? usdAmount
          : "0",
      creditAmount:
        (voucherType === "Receipt" && !isLiabilityPayment) || (voucherType === "Payment" && isLiabilityPayment)
          ? usdAmount
          : "0",
      narration: entry.narration || null,
    };
  });

  return { voucherUpdates, entries: [paymentEntry, ...contraEntries] };
};

export const prepareJournalData = (data: JournalFormData, exchangeRate: number | undefined) => {
  const voucherUpdates = {
    voucherDate: format(data.voucherDate, "yyyy-MM-dd"),
    voucherType: "Journal",
    description: data.notes,
    currency: data.currency === "ZMW" ? "ZMW" : "USD",
    exchangeRate: data.currency === "ZMW" ? String(exchangeRate) : undefined,
  };

  const entries = data.entries.map((entry) => {
    const usdAmount =
      data.currency === "ZMW" ? entry.amount : convertAmountToUSD(entry.amount, data.currency, exchangeRate);
    return {
      ledgerAccountId: entry.accountType === "ledger" ? entry.accountId : null,
      bankAccountId: entry.accountType === "bank" ? entry.accountId : null,
      supplierId: entry.accountType === "supplier" ? entry.accountId : null,
      factorySupplierId: entry.accountType === "factorySupplier" ? entry.accountId : null,
      debitAmount: entry.type === "DR" ? usdAmount : "0",
      creditAmount: entry.type === "CR" ? usdAmount : "0",
      narration: entry.narration || null,
    };
  });

  return { voucherUpdates, entries };
};

export const prepareSalesData = (data: SalesFormData) => {
  return {
    voucherDate: format(data.voucherDate, "yyyy-MM-dd"),
    description: data.notes,
    currency: data.currency,
    items: data.items.map((item) => ({
      id: item.id,
      stockItemId: item.stockItemId,
      quantity: item.quantity,
      sellingPrice: item.sellingPrice,
    })),
  };
};

export const preparePurchaseData = (data: PurchaseFormData) => {
  return {
    voucherDate: format(data.voucherDate, "yyyy-MM-dd"),
    description: data.notes,
    currency: data.currency,
    items: data.items.map((item) => ({
      id: item.id,
      stockItemId: item.stockItemId,
      itemName: item.stockItemName,
      quantity: item.quantity,
      rate: item.rate,
    })),
  };
};

export const prepareAdjustmentData = (data: AdjustmentFormData) => {
  return {
    voucherDate: format(data.voucherDate, "yyyy-MM-dd"),
    description: data.notes,
    currency: data.currency,
    locationId: data.locationId,
    items: data.items.map((item) => ({
      id: item.id,
      stockItemId: item.stockItemId,
      quantity: item.quantity,
      rate: item.rate,
    })),
  };
};

export const prepareTransferData = (data: TransferFormData) => {
  return {
    voucherDate: format(data.voucherDate, "yyyy-MM-dd"),
    description: data.notes,
    sourceLocationId: data.sourceLocationId,
    destinationLocationId: data.destinationLocationId,
    items: data.items.map((item) => ({
      id: item.id,
      stockItemId: item.stockItemId,
      quantity: item.quantity,
      rate: item.rate,
    })),
  };
};
