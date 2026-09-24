import { searchAny } from "@shared/searchNormalization";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { useLocation } from "wouter";
import { resolveWhatsAppPrompt, type WhatsAppPromptState } from "@/lib/whatsapp-prompt";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCompany } from "@/contexts/CompanyContext";
import { parseDateLocal } from "@/components/vouchers/PrintTemplate";
import type { CombinedAccount } from "@/components/AccountAutocomplete";
import { useToast } from "@/hooks/use-toast";
import { keyStartsWith, queryClient } from "@/lib/queryClient";
import { useAppMode, useModePrefix } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useFormDraft } from "@/hooks/useFormDraft";
import { formatNumber } from "@/lib/formatNumber";
import { utils, writeFile } from "@/lib/excelHelper";
import type {
  Account,
  BankAccount,
  Customer,
  Employee,
  FactorySupplierBasic,
  FixedAsset,
  JournalFormData,
  JournalFormProps,
  JournalVoucherEntry,
  JournalVoucherToEdit,
  LedgerAccount,
  Supplier,
} from "./types";
import { journalFormSchema } from "./utils";

function isOfflineQueued(error: unknown): boolean {
  return error instanceof Error && error.name === "OfflineQueued";
}

function isGloballyHandled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_handledGlobally" in error &&
    (error as { _handledGlobally?: boolean })._handledGlobally === true
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function emptyJournal(): JournalFormData {
  return {
    voucherDate: new Date(),
    entries: [{ type: "DR", accountType: "ledger", accountId: 0, accountName: "", amount: "" }],
    notes: "",
    optional: false,
  };
}

export function useJournalFormModel({ voucherIdToEdit, isPOS }: JournalFormProps) {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const isFactoryCompany = selectedCompany?.companyType === "factory";
  const isPropertiesCompany = selectedCompany?.companyType === "properties";
  const isFactoryMode = appMode === "factory";
  const modePrefix = useModePrefix();
  const [, setLocation] = useLocation();
  const { formatAmount, selectedCurrency, convertToUSD } = useCurrencyContext();
  const [transactionRate, setTransactionRate] = useState<number | null>(null);
  const [journalEffectiveDate, setJournalEffectiveDate] = useState("");
  const [waPendingPrompt, setWaPendingPrompt] = useState<WhatsAppPromptState>(null);
  const [accountPickersNeeded, setAccountPickersNeeded] = useState(() => !!voucherIdToEdit);
  const hydratedVoucherIdRef = useRef<number | null>(null);

  const { data: bankAccounts = [], isFetched: bankAccountsFetched } = useQuery<BankAccount[]>({
    queryKey: ["/api/bank-accounts", selectedCompany?.id],
  });
  const { data: ledgerAccounts = [], isFetched: ledgerAccountsFetched } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts", selectedCompany?.id],
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
  const [showAccountSidebar, setShowAccountSidebar] = useState(false);
  const [journalAccountSearchTerm, setJournalAccountSearchTermState] = useState("");
  const [journalAccountHighlightedIndex, setJournalAccountHighlightedIndex] = useState(0);
  const journalSidebarRef = useRef<HTMLDivElement>(null);
  const [showCreateAccountModal, setShowCreateAccountModal] = useState(false);
  const [createAccountContext, setCreateAccountContext] = useState<{
    tab: "payment" | "receipt" | "journal";
    rowIndex?: number;
  } | null>(null);

  const isJournalAccountSearchFocused = () => {
    if (typeof document === "undefined") return false;
    const activeElement = document.activeElement as HTMLElement | null;
    const testId = activeElement?.getAttribute("data-testid") || "";
    return (
      testId === "input-journal-sidebar-search" ||
      testId.startsWith("input-journal-account-") ||
      testId.startsWith("input-journal-account-mobile-")
    );
  };

  // Journal row inputs still have legacy delayed blur callbacks. Guard the shared state
  // so an old 200ms blur cannot clear a newly focused row/sidebar search.
  const setActiveJournalRow = (nextRow: number | null) => {
    if (nextRow === null && isJournalAccountSearchFocused()) return;
    if (nextRow !== null) {
      setJournalAccountSearchTermState("");
      setJournalAccountHighlightedIndex(0);
    }
    setActiveJournalRowState(nextRow);
  };

  const setJournalAccountSearchTerm = (nextTerm: string) => {
    if (nextTerm === "" && isJournalAccountSearchFocused()) return;
    setJournalAccountSearchTermState(nextTerm);
  };

  useEffect(() => setLiveAccountSearch(journalAccountSearchTerm), [journalAccountSearchTerm]);
  const filteredJournalAccounts = useMemo(() => {
    if (!journalAccountSearchTerm.trim()) return allAccounts;
    return allAccounts.filter((account) => searchAny(journalAccountSearchTerm, account.name, account.code));
  }, [allAccounts, journalAccountSearchTerm]);

  useEffect(() => {
    setJournalAccountHighlightedIndex((previous) => {
      if (filteredJournalAccounts.length === 0) return 0;
      return Math.min(previous, filteredJournalAccounts.length - 1);
    });
  }, [filteredJournalAccounts.length]);

  useEffect(() => {
    const sidebar = journalSidebarRef.current;
    if (!sidebar || activeJournalRow === null || filteredJournalAccounts.length === 0) return;
    const option = sidebar.querySelector(
      `[data-testid="journal-account-option-${journalAccountHighlightedIndex}"]`
    ) as HTMLElement | null;
    if (!option) return;

    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;
    const visibleTop = sidebar.scrollTop;
    const visibleBottom = visibleTop + sidebar.clientHeight;
    if (optionTop < visibleTop) sidebar.scrollTop = optionTop;
    else if (optionBottom > visibleBottom) sidebar.scrollTop = optionBottom - sidebar.clientHeight;
  }, [journalAccountHighlightedIndex, filteredJournalAccounts.length, activeJournalRow]);

  const focusVisibleJournalInput = (testIds: string[], select = false, delay = 50) => {
    setTimeout(() => {
      if (typeof document === "undefined") return;
      const candidates = testIds.flatMap((testId) =>
        Array.from(document.querySelectorAll(`[data-testid="${testId}"]`)) as HTMLInputElement[]
      );
      const input = candidates.find((candidate) => candidate.offsetParent !== null) || candidates[0];
      input?.focus();
      if (select) input?.select();
    }, delay);
  };

  const handleJournalAccountSelect = (account: CombinedAccount) => {
    if (activeJournalRow === null) return;
    const rowIndex = activeJournalRow;
    journalForm.setValue(`entries.${rowIndex}.accountType`, account.type);
    journalForm.setValue(`entries.${rowIndex}.accountId`, account.id);
    journalForm.setValue(`entries.${rowIndex}.accountName`, account.name);
    setJournalAccountSearchTermState("");
    setJournalAccountHighlightedIndex(0);
    setShowAccountSidebar(false);
    setActiveJournalRowState(null);
    focusVisibleJournalInput(
      [`input-journal-amount-${rowIndex}`, `input-journal-amount-mobile-${rowIndex}`],
      true
    );
  };

  const getAccountBalance = (accountType: string, accountId: number): number =>
    sidebarAccounts.find((account) => account.type === accountType && account.id === accountId)?.balance ?? 0;

  const handleJournalTypeChange = (index: number, newType: "DR" | "CR") => {
    const currentEntries = journalForm.getValues("entries");
    const currentAmount = parseFloat(currentEntries[index]?.amount || "0");
    journalForm.setValue(`entries.${index}.type`, newType);
    if (newType === "CR") {
      const updated = currentEntries.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, type: newType } : entry
      );
      const debits = updated.reduce((sum, entry) => sum + (entry.type === "DR" ? parseFloat(entry.amount) || 0 : 0), 0);
      const otherCredits = updated.reduce(
        (sum, entry, entryIndex) =>
          entryIndex !== index && entry.type === "CR" ? sum + (parseFloat(entry.amount) || 0) : sum,
        0
      );
      const remaining = debits - otherCredits;
      if (currentAmount === 0 && remaining > 0) {
        journalForm.setValue(`entries.${index}.amount`, formatNumber(remaining));
      }
    }
    focusVisibleJournalInput(
      [`input-journal-account-${index}`, `input-journal-account-mobile-${index}`],
      false
    );
  };

  useEffect(() => {
    const entries = voucherToEdit?.entries;
    if (!voucherToEdit || voucherToEdit.voucherType !== "Journal" || !entries?.length) return;
    if (hydratedVoucherIdRef.current === voucherToEdit.id) return;
    if (!ledgerAccountsFetched || !bankAccountsFetched) return;
    if (entries.some((entry) => entry.factorySupplierId) && factorySuppliersList.length === 0) return;
    if (entries.some((entry) => entry.supplierId) && !suppliersFetched) return;
    if (entries.some((entry) => entry.customerId) && !customersFetched) return;

    const formEntries: JournalFormData["entries"] = entries.map((entry: JournalVoucherEntry) => {
      let accountType: JournalFormData["entries"][number]["accountType"] = "ledger";
      let accountId = 0;
      let accountName = "";
      if (entry.bankAccountId) {
        accountType = "bank";
        accountId = entry.bankAccountId;
        accountName = bankAccounts.find((account) => account.id === accountId)?.bankName || "";
      } else if (entry.ledgerAccountId) {
        accountId = entry.ledgerAccountId;
        accountName = ledgerAccounts.find((account) => account.id === accountId)?.name || "";
      } else if (entry.supplierId) {
        accountType = "supplier";
        accountId = entry.supplierId;
        accountName = suppliers.find((supplier) => supplier.id === accountId)?.legalName || "";
      } else if (entry.factorySupplierId) {
        accountType = "factorySupplier";
        accountId = entry.factorySupplierId;
        accountName = factorySuppliersList.find((supplier) => supplier.id === accountId)?.name || "";
      } else if (entry.employeeId) {
        accountType = "employee";
        accountId = entry.employeeId;
        const employee = employees.find((candidate) => candidate.id === accountId);
        accountName = employee ? `${employee.firstName} ${employee.lastName}` : "";
      } else if (entry.fixedAssetId) {
        accountType = "fixedAsset";
        accountId = entry.fixedAssetId;
        accountName = fixedAssets.find((asset) => asset.id === accountId)?.name || "";
      } else if (entry.customerId) {
        accountType = "customer";
        accountId = entry.customerId;
        accountName = customers.find((customer) => customer.id === accountId)?.legalName || "";
      }
      const debit = parseFloat(String(entry.debitAmount || "0"));
      // eslint-disable-next-line unused-imports/no-unused-vars -- God Files extraction preserves pre-split behavior.
      const credit = parseFloat(String(entry.creditAmount || "0"));
      return {
        type: debit > 0 ? "DR" : "CR",
        accountType,
        accountId,
        accountName,
        amount: String(debit > 0 ? (entry.debitAmount ?? "") : (entry.creditAmount ?? "")),
        narration: entry.narration || "",
      };
    });
    if (formEntries.some((entry) => entry.accountId > 0 && entry.accountName === "")) return;

    journalForm.reset({
      voucherDate: parseDateLocal(voucherToEdit.voucherDate),
      entries: formEntries.length ? formEntries : emptyJournal().entries,
      notes: voucherToEdit.description ?? voucherToEdit.notes ?? "",
      optional: voucherToEdit.optional || false,
    });
    setJournalEffectiveDate(voucherToEdit.effectiveDate || "");
    hydratedVoucherIdRef.current = voucherToEdit.id;
  }, [
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
    journalForm,
  ]);

  const journalMutation = useMutation({
    mutationFn: async (formData: JournalFormData) => {
      const payload = {
        voucherDate: format(formData.voucherDate, "yyyy-MM-dd"),
        entries: formData.entries.filter((entry) => entry.accountId > 0),
        notes: formData.notes,
        optional: formData.optional,
        currency: selectedCurrency,
        exchangeRate: transactionRate ? transactionRate.toString() : undefined,
        effectiveDate: journalEffectiveDate || null,
      };
      const response = voucherIdToEdit
        ? await modeApiRequest("PATCH", `/api/vouchers/${voucherIdToEdit}/journal`, payload)
        : await modeApiRequest("POST", "/api/vouchers/journal", payload);
      return response.json();
    },
    onSuccess: async (data: unknown) => {
      const editing = !!voucherIdToEdit;
      toast({ title: "Success", description: `Journal voucher ${editing ? "updated" : "created"} successfully` });
      const prompt = resolveWhatsAppPrompt(data);
      if (prompt) setWaPendingPrompt(prompt);
      discardJournalDraft();
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/voucher-sidebar"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bank-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers/stats", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats/net-profit"] });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customers/") });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      if (editing) setLocation(`${modePrefix}/daybook`);
      else journalForm.reset(emptyJournal());
    },
    onError: (error: unknown, formData: JournalFormData) => {
      if (isOfflineQueued(error)) {
        const syntheticVoucher = {
          id: -Date.now(),
          voucherNumber: "PENDING",
          voucherType: "Journal",
          voucherDate: format(formData.voucherDate, "yyyy-MM-dd"),
          description: formData.notes || "Journal (pending sync)",
          totalAmount: formData.entries
            .filter((entry) => entry.type === "DR" && parseFloat(entry.amount || "0") > 0)
            .reduce((sum, entry) => sum + parseFloat(entry.amount || "0"), 0)
            .toFixed(2),
          optional: formData.optional || false,
          createdAt: new Date().toISOString(),
        };
        queryClient.setQueriesData({ queryKey: ["/api/vouchers"] }, (old: unknown) =>
          Array.isArray(old) ? [syntheticVoucher, ...old] : old
        );
        discardJournalDraft();
        journalForm.reset(emptyJournal());
        return;
      }
      if (isGloballyHandled(error)) return;
      toast({
        title: "Error",
        description: errorMessage(error, `Failed to ${voucherIdToEdit ? "update" : "create"} journal voucher`),
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
      const response = await modeApiRequest("POST", url, { month });
      const json = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(json.message || "Failed to send WhatsApp");
      return json;
    },
    onSuccess: () => {
      toast({ title: "Statement sent to WhatsApp" });
      setWaPendingPrompt(null);
    },
    onError: (error: unknown) => {
      if (isGloballyHandled(error)) return;
      toast({
        title: "WhatsApp send failed",
        description: errorMessage(error, "Failed to send WhatsApp"),
        variant: "destructive",
      });
      setWaPendingPrompt(null);
    },
  });

  const handleExportJournalVoucher = async (detailed: boolean) => {
    const formData = journalForm.getValues();
    const voucherDate = formData.voucherDate
      ? format(formData.voucherDate, "yyyy-MM-dd")
      : format(new Date(), "yyyy-MM-dd");
    const validEntries = formData.entries.filter((entry) => entry.accountId > 0 && parseFloat(entry.amount) > 0);
    if (!validEntries.length) {
      toast({
        title: "No data to export",
        description: "Add at least one entry before exporting.",
        variant: "destructive",
      });
      return;
    }
    if (detailed) {
      const worksheet = utils.json_to_sheet(
        validEntries.map((entry) => ({
          "Voucher Type": "Journal",
          Date: voucherDate,
          "DR/CR": entry.type,
          Account: entry.accountName || "",
          "Account Type": entry.accountType || "",
          Amount: parseFloat(entry.amount).toFixed(2),
          Notes: formData.notes || "",
          Optional: formData.optional ? "Yes" : "No",
        }))
      );
      const workbook = utils.book_new();
      utils.book_append_sheet(workbook, worksheet, "Journal Detailed");
      const fileName = `Journal_Voucher_Detailed_${voucherDate}.xlsx`;
      await writeFile(workbook, fileName);
      toast({ title: "Export successful", description: `Downloaded ${fileName} with ${validEntries.length} entries.` });
      return;
    }
    const totalDr = validEntries
      .filter((entry) => entry.type === "DR")
      .reduce((sum, entry) => sum + (parseFloat(entry.amount) || 0), 0);
    const totalCr = validEntries
      .filter((entry) => entry.type === "CR")
      .reduce((sum, entry) => sum + (parseFloat(entry.amount) || 0), 0);
    const worksheet = utils.json_to_sheet([
      {
        "Voucher Type": "Journal",
        Date: voucherDate,
        "Total Debit": totalDr.toFixed(2),
        "Total Credit": totalCr.toFixed(2),
        "Number of Entries": validEntries.length,
        Notes: formData.notes || "",
        Optional: formData.optional ? "Yes" : "No",
      },
    ]);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, "Journal Summary");
    const fileName = `Journal_Voucher_Summary_${voucherDate}.xlsx`;
    await writeFile(workbook, fileName);
    toast({ title: "Export successful", description: `Downloaded ${fileName}.` });
  };

  const onJournalSubmit = async (data: JournalFormData) => {
    const validEntries = data.entries.filter((entry) => entry.accountId > 0 && parseFloat(entry.amount) > 0);
    if (!validEntries.length) {
      toast({ title: "Validation Error", description: "Please add at least one valid entry", variant: "destructive" });
      return;
    }
    if (!validEntries.some((entry) => entry.type === "DR") || !validEntries.some((entry) => entry.type === "CR")) {
      toast({
        title: "Validation Error",
        description: "Journal must have both DR (debit) and CR (credit) entries",
        variant: "destructive",
      });
      return;
    }
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      toast({
        title: "Validation Error",
        description: `Debits (${formatAmount(totalDebit)}) must equal Credits (${formatAmount(totalCredit)})`,
        variant: "destructive",
      });
      return;
    }
    journalMutation.mutate(data);
  };

  const handleJournalKeyDown = (event: KeyboardEvent, rowIndex: number, fieldName: "type" | "account" | "amount") => {
    const isLastRow = rowIndex === journalFields.length - 1;
    const focus = (selector: string, select = false, delay = 50) =>
      setTimeout(() => {
        const element = document.querySelector(selector) as HTMLInputElement | null;
        element?.focus();
        if (select) element?.select();
      }, delay);
    if (fieldName === "amount") {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (rowIndex > 0) focus(`[data-testid="input-journal-amount-${rowIndex - 1}"]`, true);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (rowIndex < journalFields.length - 1) focus(`[data-testid="input-journal-amount-${rowIndex + 1}"]`, true);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        focus(`[data-testid="input-journal-account-${rowIndex}"]`);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (rowIndex < journalFields.length - 1) focus(`[data-testid="input-journal-type-${rowIndex + 1}"]`);
        return;
      }
    }
    if (fieldName === "amount" && event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      if (isLastRow)
        appendJournal({ type: "DR", accountType: "ledger", accountId: 0, accountName: "", amount: "", narration: "" });
      focus(`[data-testid="input-journal-type-${rowIndex + 1}"]`, false, 100);
    }
    if (fieldName === "amount" && event.key === "Enter") {
      event.preventDefault();
      if (isLastRow) {
        appendJournal({ type: "DR", accountType: "ledger", accountId: 0, accountName: "", amount: "", narration: "" });
        focus(`[data-testid="input-journal-type-${rowIndex + 1}"]`, false, 100);
      } else focus(`[data-testid="input-journal-type-${rowIndex + 1}"]`);
    }
  };

  const handleOpenCreateAccountModal = (tab: "payment" | "receipt" | "journal", rowIndex?: number) => {
    setCreateAccountContext({ tab, rowIndex });
    setShowCreateAccountModal(true);
  };
  const handleAccountCreated = (account: { id: number; name: string; type: string }) => {
    if (!createAccountContext) return;
    if (createAccountContext.tab === "journal" && createAccountContext.rowIndex !== undefined) {
      const rowIndex = createAccountContext.rowIndex;
      journalForm.setValue(`entries.${rowIndex}.accountType`, "ledger");
      journalForm.setValue(`entries.${rowIndex}.accountId`, account.id);
      journalForm.setValue(`entries.${rowIndex}.accountName`, account.name);
      setJournalAccountSearchTermState("");
      setActiveJournalRowState(null);
      setShowAccountSidebar(false);
      focusVisibleJournalInput(
        [`input-journal-amount-${rowIndex}`, `input-journal-amount-mobile-${rowIndex}`],
        true,
        0
      );
    }
    setCreateAccountContext(null);
  };

  const restoreJournalDraft = () => {
    const data = journalDraft?.data;
    if (typeof data === "object" && data !== null) {
      const draft = data as Partial<JournalFormData> & { voucherDate?: string | Date };
      const rawDate = draft.voucherDate;
      const voucherDate = rawDate instanceof Date ? rawDate : rawDate ? new Date(rawDate) : new Date();
      journalForm.reset({ ...emptyJournal(), ...draft, voucherDate });
    }
    discardJournalDraft();
  };

  return {
    isPOS,
    voucherIdToEdit,
    selectedCompany,
    modeApiRequest,
    selectedCurrency,
    convertToUSD,
    formatAmount,
    transactionRate,
    setTransactionRate,
    journalEffectiveDate,
    setJournalEffectiveDate,
    voucherToEdit,
    journalForm,
    journalFields,
    appendJournal,
    removeJournal,
    journalEntries,
    totalDebit,
    totalCredit,
    hasJournalDraft,
    journalDraftAge,
    discardJournalDraft,
    restoreJournalDraft,
    activeJournalRow,
    setActiveJournalRow,
    showAccountSidebar,
    setShowAccountSidebar,
    journalAccountSearchTerm,
    setJournalAccountSearchTerm,
    journalAccountHighlightedIndex,
    setJournalAccountHighlightedIndex,
    journalSidebarRef,
    filteredJournalAccounts,
    handleJournalAccountSelect,
    getAccountBalance,
    handleJournalTypeChange,
    handleJournalKeyDown,
    onJournalSubmit,
    journalMutation,
    handleExportJournalVoucher,
    setAccountPickersNeeded,
    showCreateAccountModal,
    setShowCreateAccountModal,
    createAccountContext,
    setCreateAccountContext,
    handleOpenCreateAccountModal,
    handleAccountCreated,
    waPendingPrompt,
    setWaPendingPrompt,
    sendWaStatementMutation,
  };
}
