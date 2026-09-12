import { useEffect } from "react";
import { parseISO } from "date-fns";
import { UseFormReturn } from "react-hook-form";
import { VoucherData, LedgerAccount, BankAccount, Supplier } from "./VoucherEditHelpers";
import type { AccountWithBalance } from "./VoucherAccountHelpers";
import {
  VoucherFormData,
  JournalFormData,
  SalesFormData,
  PurchaseFormData,
  AdjustmentFormData,
  TransferFormData,
} from "./VoucherEditSchemas";

export const useFormInitialization = (
  voucher: VoucherData | undefined,
  formInitialized: boolean,
  setFormInitialized: (val: boolean) => void,
  voucherType: string | undefined,
  ledgerAccounts: LedgerAccount[],
  bankAccounts: BankAccount[],
  suppliers: Supplier[],
  allAccountsData: AccountWithBalance[],
  selectedCurrency: "USD" | "CFA",
  paymentForm: UseFormReturn<VoucherFormData>,
  journalForm: UseFormReturn<JournalFormData>,
  salesForm: UseFormReturn<SalesFormData>,
  purchaseForm: UseFormReturn<PurchaseFormData>,
  adjustmentForm: UseFormReturn<AdjustmentFormData>,
  transferForm: UseFormReturn<TransferFormData>
) => {
  useEffect(() => {
    if (!voucher || formInitialized) return;

    const isPaymentOrReceipt = voucherType === "Payment" || voucherType === "Receipt";
    const isJournal = voucherType === "Journal";
    const isPurchase = voucherType === "Purchase";
    const isConsumption = voucherType === "Consumption" || voucherType === "Production" || voucherType === "Mixed";
    const isStockTransfer = voucherType === "Stock Transfer";

    if (isPaymentOrReceipt) {
      const isReceipt = voucherType === "Receipt";
      const mainEntry = voucher.entries[0];
      const contraEntries = voucher.entries.slice(1);
      const mainIsLiability = mainEntry.supplierId || mainEntry.factorySupplierId || mainEntry.employeeId;
      const accountType = mainEntry.ledgerAccountId
        ? "ledger"
        : mainEntry.bankAccountId
          ? "bank"
          : mainEntry.supplierId
            ? "supplier"
            : mainEntry.factorySupplierId
              ? "factorySupplier"
              : "employee";
      const accountId =
        mainEntry.ledgerAccountId ||
        mainEntry.bankAccountId ||
        mainEntry.supplierId ||
        mainEntry.factorySupplierId ||
        mainEntry.employeeId ||
        0;
      let accountName = "";
      if (accountType === "ledger") accountName = ledgerAccounts.find((a) => a.id === accountId)?.name || "";
      else if (accountType === "bank") accountName = bankAccounts.find((a) => a.id === accountId)?.bankName || "";
      else if (accountType === "supplier") accountName = suppliers.find((a) => a.id === accountId)?.legalName || "";
      else if (accountType === "factorySupplier") {
        const fsAccount = allAccountsData.find((a) => a.type === "factorySupplier" && Number(a.id) === accountId);
        accountName = fsAccount?.name || `Factory Supplier ${accountId}`;
      }
      paymentForm.reset({
        paymentAccountType: accountType,
        paymentAccountId: accountId,
        paymentAccountName: accountName,
        voucherDate: parseISO(voucher.voucherDate),
        currency: (voucher.currency as "USD" | "CFA") || selectedCurrency,
        paymentAccountNarration: mainEntry?.narration || "",
        notes: voucher.description || "",
        entries: contraEntries.map((e) => {
          const eAccountType = e.ledgerAccountId
            ? "ledger"
            : e.bankAccountId
              ? "bank"
              : e.supplierId
                ? "supplier"
                : e.factorySupplierId
                  ? "factorySupplier"
                  : "employee";
          const eAccountId =
            e.ledgerAccountId || e.bankAccountId || e.supplierId || e.factorySupplierId || e.employeeId || 0;
          let eAccountName = "";
          if (eAccountType === "ledger") eAccountName = ledgerAccounts.find((a) => a.id === eAccountId)?.name || "";
          else if (eAccountType === "bank")
            eAccountName = bankAccounts.find((a) => a.id === eAccountId)?.bankName || "";
          else if (eAccountType === "supplier")
            eAccountName = suppliers.find((a) => a.id === eAccountId)?.legalName || "";
          else if (eAccountType === "factorySupplier") {
            const fsAccount = allAccountsData.find((a) => a.type === "factorySupplier" && Number(a.id) === eAccountId);
            eAccountName = fsAccount?.name || `Factory Supplier ${eAccountId}`;
          }
          const _amount = isReceipt
            ? mainIsLiability
              ? e.creditAmount
              : e.creditAmount
            : mainIsLiability
              ? e.debitAmount
              : e.debitAmount;
          return {
            accountType: eAccountType,
            accountId: eAccountId,
            accountName: eAccountName,
            amount: parseFloat(e.debitAmount) > 0 ? e.debitAmount : e.creditAmount,
            narration: e.narration || "",
          };
        }),
      });
      setFormInitialized(true);
    } else if (isJournal) {
      journalForm.reset({
        voucherDate: parseISO(voucher.voucherDate),
        currency: (voucher.currency as "USD" | "CFA") || selectedCurrency,
        notes: voucher.description || "",
        entries: voucher.entries.map((e) => {
          const type = parseFloat(e.debitAmount) > 0 ? "DR" : "CR";
          const accountType = e.ledgerAccountId
            ? "ledger"
            : e.bankAccountId
              ? "bank"
              : e.supplierId
                ? "supplier"
                : e.factorySupplierId
                  ? "factorySupplier"
                  : "employee";
          const accountId =
            e.ledgerAccountId || e.bankAccountId || e.supplierId || e.factorySupplierId || e.employeeId || 0;
          let accountName = "";
          if (accountType === "ledger") accountName = ledgerAccounts.find((a) => a.id === accountId)?.name || "";
          else if (accountType === "bank") accountName = bankAccounts.find((a) => a.id === accountId)?.bankName || "";
          else if (accountType === "supplier") accountName = suppliers.find((a) => a.id === accountId)?.legalName || "";
          return {
            type,
            accountType: accountType,
            accountId,
            accountName,
            amount: type === "DR" ? e.debitAmount : e.creditAmount,
            narration: e.narration || "",
          };
        }),
      });
      setFormInitialized(true);
    } else if (isPurchase) {
      purchaseForm.reset({
        voucherDate: parseISO(voucher.voucherDate),
        currency: (voucher.currency as "USD" | "CFA") || selectedCurrency,
        items: (voucher.purchaseOrder?.items || []).map((item) => ({
          id: item.id,
          stockItemId: item.stockItemId,
          stockItemName: item.itemName,
          quantity: item.quantity,
          rate: item.rate,
        })),
        notes: voucher.description || "",
      });
      setFormInitialized(true);
    } else if (isConsumption) {
      adjustmentForm.reset({
        voucherDate: parseISO(voucher.voucherDate),
        locationId: voucher.adjustmentData?.locationId || voucher.locationId || 0,
        items: (voucher.adjustmentData?.items || []).map((item) => ({
          id: item.id,
          stockItemId: item.stockItemId,
          stockItemName: `${item.stockItemCode} - ${item.stockItemName}`,
          quantity: item.quantity,
          rate: item.rate,
        })),
        notes: voucher.adjustmentData?.notes || voucher.description || "",
      });
      setFormInitialized(true);
    } else if (isStockTransfer) {
      transferForm.reset({
        voucherDate: parseISO(voucher.voucherDate),
        currency: (voucher.currency as "USD" | "CFA") || selectedCurrency,
        sourceLocationId: voucher.transferData?.sourceLocationId || voucher.locationId || 0,
        destinationLocationId: voucher.transferData?.destinationLocationId || 0,
        items: (voucher.transferData?.items || []).map((item) => ({
          id: item.id,
          stockItemId: item.stockItemId,
          stockItemName: `${item.stockItemCode} - ${item.stockItemName}`,
          quantity: item.quantity,
          rate: item.rate,
        })),
        notes: voucher.transferData?.notes || voucher.description || "",
      });
      setFormInitialized(true);
    }
  }, [
    voucher,
    voucherType,
    ledgerAccounts,
    bankAccounts,
    suppliers,
    formInitialized,
    allAccountsData,
    selectedCurrency,
    paymentForm,
    journalForm,
    salesForm,
    purchaseForm,
    adjustmentForm,
    transferForm,
    setFormInitialized,
  ]);
};
