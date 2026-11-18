// Extracted from ./useJournalFormModel.tsx to keep that module under the source-size cap.
import { useEffect, useMemo, useRef, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { useLocation } from "wouter";
import type { WhatsAppPromptState } from "@/lib/whatsapp-prompt";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useZmwVoucherRate } from "@/hooks/useZmwVoucherRate";
import { useCompany } from "@/contexts/CompanyContext";
import type { CombinedAccount } from "@/components/AccountAutocomplete";
import { useToast } from "@/hooks/use-toast";
import { useAppMode, useModePrefix } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useFormDraft } from "@/hooks/useFormDraft";
import type {
  Account,
  BankAccount,
  Customer,
  Employee,
  FactorySupplierBasic,
  FixedAsset,
  JournalFormData,
  JournalFormProps,
  JournalVoucherToEdit,
  LedgerAccount,
  Supplier,
} from "./types";
import { journalFormSchema } from "./utils";

export function isOfflineQueued(error: unknown): boolean {
  return error instanceof Error && error.name === "OfflineQueued";
}

export function isGloballyHandled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_handledGlobally" in error &&
    (error as { _handledGlobally?: boolean })._handledGlobally === true
  );
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function emptyJournal(): JournalFormData {
  return {
    voucherDate: new Date(),
    entries: [{ type: "DR", accountType: "ledger", accountId: 0, accountName: "", amount: "" }],
    notes: "",
    optional: false,
  };
}

export function useJournalFormModelPart1(props: JournalFormProps) {
  const { voucherIdToEdit, isPOS } = props;
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const isFactoryCompany = selectedCompany?.companyType === "factory";
  const isPropertiesCompany = selectedCompany?.companyType === "properties";
  const isFactoryMode = appMode === "factory";
  const modePrefix = useModePrefix();
  const [, setLocation] = useLocation();
  const { formatAmount, selectedCurrency: preferredCurrency, convertToUSD } = useCurrencyContext();
  const [transactionRate, setTransactionRate] = useState<number | null>(null);
  const [journalEffectiveDate, setJournalEffectiveDate] = useState("");
  const [waPendingPrompt, setWaPendingPrompt] = useState<WhatsAppPromptState>(null);
  const [accountPickersNeeded, setAccountPickersNeeded] = useState(() => !!voucherIdToEdit);
  const hydratedVoucherIdRef = useRef<number | null>(null);

  const { data: bankAccounts = [], isFetched: bankAccountsFetched } = useQuery<BankAccount[]>({
    queryKey: ["/api/bank-accounts", selectedCompany?.id],
  });
  const { data: ledgerAccounts = [], isFetched: ledgerAccountsFetched } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts?profile=voucher-picker", selectedCompany?.id],
  });
  const { data: suppliers = [], isFetched: suppliersFetched } = useQuery<Supplier[]>({
    queryKey: ["/api/suppliers", selectedCompany?.id],
    enabled: accountPickersNeeded && !!selectedCompany && !isPropertiesCompany,
    staleTime: 5 * 60 * 1000,
  });
  const { data: factorySuppliersList = [] } = useQuery<FactorySupplierBasic[]>({
    queryKey: ["/api/factory/suppliers", selectedCompany?.id],
    enabled: isFactoryCompany,
  });
  const { data: customers = [], isFetched: customersFetched } = useQuery<Customer[]>({
    queryKey: ["/api/customers", selectedCompany?.id],
    enabled: accountPickersNeeded && !!selectedCompany,
    staleTime: 5 * 60 * 1000,
  });
  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: ["/api/employees", selectedCompany?.id],
  });
  const { data: fixedAssets = [] } = useQuery<FixedAsset[]>({
    queryKey: ["/api/fixed-assets", selectedCompany?.id],
  });
  const { data: sidebarAccounts = [] } = useQuery<Account[]>({
    queryKey: ["/api/accounts/voucher-sidebar", selectedCompany?.id],
  });

  const [liveAccountSearch, setLiveAccountSearch] = useState("");
  const [debouncedAccountSearch, setDebouncedAccountSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedAccountSearch(liveAccountSearch), 300);
    return () => clearTimeout(timer);
  }, [liveAccountSearch]);

  const { data: supplierSearchResults = [] } = useQuery<Supplier[]>({
    queryKey: ["/api/suppliers", "live-search", debouncedAccountSearch, selectedCompany?.id],
    enabled: debouncedAccountSearch.length >= 2 && !!selectedCompany && !isPropertiesCompany,
    staleTime: 30 * 1000,
    queryFn: async () => {
      const response = await fetch(`/api/suppliers?search=${encodeURIComponent(debouncedAccountSearch)}&limit=50`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to search suppliers");
      return response.json();
    },
  });
  const { data: customerSearchResults = [] } = useQuery<Customer[]>({
    queryKey: ["/api/customers", "live-search", debouncedAccountSearch, selectedCompany?.id],
    enabled: debouncedAccountSearch.length >= 2 && !!selectedCompany,
    staleTime: 30 * 1000,
    queryFn: async () => {
      const response = await fetch(`/api/customers?search=${encodeURIComponent(debouncedAccountSearch)}&limit=50`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to search customers");
      return response.json();
    },
  });
  const { data: voucherToEdit } = useQuery<JournalVoucherToEdit | undefined>({
    queryKey: ["/api/vouchers", voucherIdToEdit],
    enabled: !!voucherIdToEdit,
    queryFn: async () => {
      const response = await fetch(`/api/vouchers/${voucherIdToEdit}`);
      if (!response.ok) throw new Error("Failed to fetch voucher");
      const voucher = (await response.json()) as JournalVoucherToEdit;
      return {
        ...voucher,
        notes: voucher.notes ?? voucher.description ?? null,
      };
    },
  });

  const selectedCurrency =
    voucherIdToEdit &&
    (voucherToEdit?.currency === "ZMW" || voucherToEdit?.currency === "CFA" || voucherToEdit?.currency === "USD")
      ? voucherToEdit.currency
      : preferredCurrency;

  useEffect(() => {
    if (voucherIdToEdit) setAccountPickersNeeded(true);
  }, [voucherIdToEdit]);

  const allAccounts = useMemo<CombinedAccount[]>(() => {
    const accounts: CombinedAccount[] = [
      ...ledgerAccounts.map((account) => ({
        type: "ledger" as const,
        id: account.id,
        name: account.name,
        code: account.code,
      })),
      ...bankAccounts.map((account) => ({
        type: "bank" as const,
        id: account.id,
        name: account.bankName,
        code: account.accountNumber,
      })),
      ...suppliers.map((supplier) => ({
        type: "supplier" as const,
        id: supplier.id,
        name: supplier.legalName,
        code: supplier.code,
      })),
      ...supplierSearchResults
        .filter((supplier) => !suppliers.find((existing) => existing.id === supplier.id))
        .map((supplier) => ({
          type: "supplier" as const,
          id: supplier.id,
          name: supplier.legalName,
          code: supplier.code,
        })),
      ...employees.map((employee) => ({
        type: "employee" as const,
        id: employee.id,
        name: `${employee.firstName} ${employee.lastName}`,
        code: employee.code,
        openingBalance: employee.openingBalance,
      })),
      ...fixedAssets.map((asset) => ({
        type: "fixedAsset" as const,
        id: asset.id,
        name: asset.name,
        code: asset.code,
        openingBalance: asset.openingBalance,
      })),
      ...customers.map((customer) => ({
        type: "customer" as const,
        id: customer.id,
        name: customer.legalName,
        code: customer.code,
        openingBalance: customer.openingBalance,
      })),
      ...customerSearchResults
        .filter((customer) => !customers.find((existing) => existing.id === customer.id))
        .map((customer) => ({
          type: "customer" as const,
          id: customer.id,
          name: customer.legalName,
          code: customer.code,
        })),
      ...factorySuppliersList.map((supplier) => ({
        type: "factorySupplier" as const,
        id: supplier.id,
        name: supplier.name,
        code: String(supplier.id),
      })),
    ];
    return accounts.sort((left, right) => (left.name || "").localeCompare(right.name || ""));
  }, [
    ledgerAccounts,
    bankAccounts,
    suppliers,
    supplierSearchResults,
    employees,
    fixedAssets,
    customers,
    customerSearchResults,
    factorySuppliersList,
  ]);

  const journalForm = useForm<JournalFormData>({
    resolver: zodResolver(journalFormSchema),
    defaultValues: emptyJournal(),
  });
  const {
    fields: journalFields,
    append: appendJournal,
    remove: removeJournal,
  } = useFieldArray({
    control: journalForm.control,
    name: "entries",
  });
  const journalEntries = journalForm.watch("entries");
  const journalDateForRate = format(journalForm.watch("voucherDate") ?? new Date(), "yyyy-MM-dd");
  const { rate: datedZmwRate } = useZmwVoucherRate(journalDateForRate);
  const storedZmwRate = Number(voucherToEdit?.exchangeRate);
  const lockedJournalRate =
    voucherIdToEdit && voucherToEdit?.currency === "ZMW"
      ? Number.isFinite(storedZmwRate) && storedZmwRate > 0
        ? storedZmwRate
        : null
      : datedZmwRate;
  const postingRate = selectedCurrency === "ZMW" ? lockedJournalRate : transactionRate;
  const totalDebit = journalEntries.reduce(
    (sum, entry) => sum + (entry.type === "DR" ? parseFloat(entry.amount) || 0 : 0),
    0
  );
  const totalCredit = journalEntries.reduce(
    (sum, entry) => sum + (entry.type === "CR" ? parseFloat(entry.amount) || 0 : 0),
    0
  );

  const {
    hasDraft: hasJournalDraft,
    draftAge: journalDraftAge,
    draft: journalDraft,
    scheduleSave: scheduleJournalSave,
    discardDraft: discardJournalDraft,
  } = useFormDraft({
    entityType: "voucher-journal",
    mode: isFactoryMode ? "factory" : "erp",
    companyId: selectedCompany?.id ?? null,
    enabled: !voucherIdToEdit,
  });
  const allJournalValues = journalForm.watch();
  useEffect(() => {
    if (!voucherIdToEdit) scheduleJournalSave(allJournalValues);
  }, [allJournalValues, scheduleJournalSave, voucherIdToEdit]);

  const [activeJournalRow, setActiveJournalRowState] = useState<number | null>(null);
  return {
    activeJournalRow,
    allAccounts,
    appMode,
    appendJournal,
    bankAccounts,
    bankAccountsFetched,
    convertToUSD,
    customers,
    customersFetched,
    discardJournalDraft,
    employees,
    factorySuppliersList,
    fixedAssets,
    formatAmount,
    hasJournalDraft,
    hydratedVoucherIdRef,
    isPOS,
    journalDraft,
    journalDraftAge,
    journalEffectiveDate,
    journalEntries,
    journalFields,
    journalForm,
    ledgerAccounts,
    ledgerAccountsFetched,
    modeApiRequest,
    modePrefix,
    postingRate,
    removeJournal,
    selectedCompany,
    selectedCurrency,
    setAccountPickersNeeded,
    setActiveJournalRowState,
    setJournalEffectiveDate,
    setLiveAccountSearch,
    setLocation,
    setTransactionRate,
    setWaPendingPrompt,
    sidebarAccounts,
    suppliers,
    suppliersFetched,
    toast,
    totalCredit,
    totalDebit,
    transactionRate,
    voucherIdToEdit,
    voucherToEdit,
    waPendingPrompt,
  };
}
