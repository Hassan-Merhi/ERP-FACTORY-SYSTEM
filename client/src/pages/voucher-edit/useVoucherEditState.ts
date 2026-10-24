import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import {
  voucherFormSchema,
  journalFormSchema,
  salesFormSchema,
  purchaseFormSchema,
  adjustmentFormSchema,
  transferFormSchema,
  VoucherFormData,
  JournalFormData,
  SalesFormData,
  PurchaseFormData,
  AdjustmentFormData,
  TransferFormData,
} from "./VoucherEditSchemas";
import { VoucherData, BankAccount, LedgerAccount, Supplier } from "./VoucherEditHelpers";
import { useAccountsWithBalances, AccountWithBalance } from "./VoucherAccountHelpers";
import { useBalanceAdjustments } from "./useBalanceAdjustments";
import { useFormInitialization } from "./useFormInitialization";

interface UseVoucherEditStateOptions {
  voucher: VoucherData | undefined;
  voucherType: string | undefined;
  isPaymentOrReceipt: boolean;
  selectedCurrency: string;
  ledgerAccounts: LedgerAccount[];
  bankAccounts: BankAccount[];
  suppliers: Supplier[];
  allAccountsData: AccountWithBalance[];
  exchangeRate: number;
  id: string | undefined;
}

export function useVoucherEditState({
  voucher,
  voucherType,
  isPaymentOrReceipt,
  selectedCurrency,
  ledgerAccounts,
  bankAccounts,
  suppliers,
  allAccountsData,
  exchangeRate,
  id,
}: UseVoucherEditStateOptions) {
  const [formInitialized, setFormInitialized] = useState(false);

  useEffect(() => {
    setFormInitialized(false);
  }, [id]);

  const paymentForm = useForm<VoucherFormData>({
    resolver: zodResolver(voucherFormSchema),
    defaultValues: {
      paymentAccountType: "bank",
      paymentAccountId: 0,
      paymentAccountName: "",
      voucherDate: new Date(),
      currency: selectedCurrency as "USD" | "CFA" | "ZMW",
      entries: [],
      paymentAccountNarration: "",
      notes: "",
    },
  });

  const [balanceAdjustments, setBalanceAdjustments] = useState<Record<string, number>>({});

  const allAccountsWithBalances = useAccountsWithBalances(
    ledgerAccounts,
    bankAccounts,
    suppliers,
    allAccountsData,
    balanceAdjustments
  );

  useBalanceAdjustments(isPaymentOrReceipt, paymentForm, voucherType, exchangeRate, setBalanceAdjustments);

  const journalForm = useForm<JournalFormData>({
    resolver: zodResolver(journalFormSchema),
    defaultValues: {
      voucherDate: new Date(),
      currency: selectedCurrency as "USD" | "CFA" | "ZMW",
      entries: [],
      notes: "",
    },
  });

  const salesForm = useForm<SalesFormData>({
    resolver: zodResolver(salesFormSchema),
    defaultValues: {
      voucherDate: new Date(),
      currency: selectedCurrency as "USD" | "CFA" | "ZMW",
      locationId: 0,
      items: [],
      notes: "",
    },
  });

  const purchaseForm = useForm<PurchaseFormData>({
    resolver: zodResolver(purchaseFormSchema),
    defaultValues: {
      voucherDate: new Date(),
      currency: selectedCurrency as "USD" | "CFA" | "ZMW",
      items: [],
      notes: "",
    },
  });

  const adjustmentForm = useForm<AdjustmentFormData>({
    resolver: zodResolver(adjustmentFormSchema),
    defaultValues: {
      voucherDate: new Date(),
      currency: selectedCurrency as "USD" | "CFA" | "ZMW",
      locationId: 0,
      items: [],
      notes: "",
    },
  });

  const transferForm = useForm<TransferFormData>({
    resolver: zodResolver(transferFormSchema),
    defaultValues: {
      voucherDate: new Date(),
      currency: selectedCurrency as "USD" | "CFA" | "ZMW",
      sourceLocationId: 0,
      destinationLocationId: 0,
      items: [],
      notes: "",
    },
  });

  useFormInitialization(
    voucher,
    formInitialized,
    setFormInitialized,
    voucherType,
    ledgerAccounts,
    bankAccounts,
    suppliers,
    allAccountsData,
    selectedCurrency as "USD" | "CFA" | "ZMW",
    paymentForm,
    journalForm,
    salesForm,
    purchaseForm,
    adjustmentForm,
    transferForm
  );

  return {
    paymentForm,
    journalForm,
    salesForm,
    purchaseForm,
    adjustmentForm,
    transferForm,
    allAccountsWithBalances,
  };
}
