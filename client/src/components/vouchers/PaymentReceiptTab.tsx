import { useState, useMemo } from "react";
import { UseFormReturn, UseFieldArrayReturn, type SubmitHandler } from "react-hook-form";
import { format } from "date-fns";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Printer,
  FileDown,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ArrowUpCircle,
  ArrowDownCircle,
  AlertCircle,
  BookOpen,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AccountAutocomplete } from "@/components/AccountAutocomplete";
import type { CombinedAccount } from "@/components/AccountAutocomplete";
import AccountSidebar, { Account } from "@/components/AccountSidebar";
import { VoucherEntriesTable, type VoucherEntry } from "@/components/vouchers/VoucherEntriesTable";
import type { VoucherFormData } from "@/pages/vouchers/voucherTypes";
import { VoucherSourceCard } from "@/components/vouchers/VoucherSourceCard";
import { useCurrencyContext } from "@/contexts/CurrencyContext";

export interface PaymentReceiptTabProps {
  form: UseFormReturn<VoucherFormData>;
  fieldArray: UseFieldArrayReturn<VoucherFormData, "entries", "id">;
  entries: VoucherEntry[];
  total: number;
  paymentAccountId: number;
  paymentAccountType: string;
  paymentAccountName: string;
  accountBalance: number;
  accountCurrencyBalances?: { currency: string; balance: number }[] | null;
  allAccounts: CombinedAccount[];
  payFromAccounts?: CombinedAccount[];
  sidebarAccounts: Account[];
  filteredSidebarAccounts: Account[];
  sidebarSearchValue: string;
  setSidebarSearchValue: (value: string) => void;
  sidebarHighlightedIndex: number;
  setSidebarHighlightedIndex: (index: number) => void;
  selectedAccountId: number | null;
  selectedAccountType: string | null;
  handleSidebarAccountSelect: (account: Account) => void;
  handleAmountCommit: (rowIndex: number) => void;
  handlePrint: () => void;
  handleExportVoucher?: (detailed: boolean) => void;
  onSubmit: SubmitHandler<VoucherFormData>;
  activeTab: "payment" | "receipt";
  activeRowIndex: number | null;
  setActiveRowIndex: (index: number | null) => void;
  onCreateAccount?: () => void;
  isFactoryCompany?: boolean;
  onAutoCreateAccount?: (name: string) => Promise<Account | null>;
  isAutoCreating?: boolean;
  isEditMode?: boolean;
  originalTotal?: number;
  isPending?: boolean;
  voucherNumber?: string;
  onAccountPickerOpen?: () => void;
  onAccountSearchChange?: (term: string) => void;
  effectiveDate?: string | null;
  onEffectiveDateChange?: (v: string) => void;
}

export function PaymentReceiptTab({
  form,
  fieldArray,
  entries,
  total,
  paymentAccountId,
  paymentAccountType,
  paymentAccountName,
  accountBalance,
  accountCurrencyBalances,
  allAccounts,
  payFromAccounts,
  sidebarAccounts,
  filteredSidebarAccounts,
  sidebarSearchValue,
  setSidebarSearchValue,
  sidebarHighlightedIndex,
  setSidebarHighlightedIndex,
  selectedAccountId,
  selectedAccountType,
  handleSidebarAccountSelect,
  handleAmountCommit,
  handlePrint,
  handleExportVoucher,
  onSubmit,
  activeTab,
  activeRowIndex,
  setActiveRowIndex,
  onCreateAccount,
  isFactoryCompany = false,
  onAutoCreateAccount,
  isAutoCreating = false,
  isEditMode = false,
  originalTotal = 0,
  isPending = false,
  voucherNumber,
  onAccountPickerOpen,
  onAccountSearchChange,
  effectiveDate,
  onEffectiveDateChange,
}: PaymentReceiptTabProps) {
  const { formatAmount } = useCurrencyContext();
  const { formatDisplayDate: _formatDisplayDate } = useDateFormat();

  // Notes collapse state — auto-open if there is already a notes value
  const [notesOpen, setNotesOpen] = useState<boolean>(() => {
    const existingNotes = form.getValues("notes");
    return typeof existingNotes === "string" && existingNotes.trim().length > 0;
  });

  // Mobile account drawer (entry rows → AccountSidebar)
  const [sheetOpen, setSheetOpen] = useState(false);

  // Mobile Pay From sheet
  const [payFromSheetOpen, setPayFromSheetOpen] = useState(false);
  const [payFromSearch, setPayFromSearch] = useState("");

  // Track whether the Pay From / Receive Into autocomplete is the active target
  const [payFromActive, setPayFromActive] = useState(false);

  // Effective date is optional and rarely used — it stays behind a toggle until asked for,
  // and reveals itself automatically when the voucher already carries one.
  const [showEffectiveDate, setShowEffectiveDate] = useState<boolean>(Boolean(effectiveDate));

  // Once an account is chosen the picker collapses into a summary card; "Change" reopens it.
  const [editingSource, setEditingSource] = useState(false);

  // Required-field warnings wait for a submit attempt or for the user to leave the field,
  // so an untouched form never opens with an error on it.
  const [payFromTouched, setPayFromTouched] = useState(false);
  const showValidation = form.formState.isSubmitted || payFromTouched;

  const isPayment = activeTab === "payment";

  // Tab-specific styling / labels
  const Icon = isPayment ? ArrowUpCircle : ArrowDownCircle;
  const _iconColor = isPayment ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400";
  const accentColor = isPayment ? "#f59e0b" : "#10b981";
  const title = isPayment ? "Payment Voucher" : "Receipt Voucher";
  const accountLabel = isPayment ? "Pay From" : "Receive Into";
  const accountPlaceholder = isPayment ? "Pay from..." : "Receive into...";
  const accountTestId = isPayment ? "input-pay-from" : "input-receive-in";

  // Active target label shown in the account sidebar / drawer
  const activeTargetLabel: string | undefined = payFromActive
    ? accountLabel
    : activeRowIndex !== null
      ? `Row ${activeRowIndex + 1}`
      : undefined;

  // Wrap handleSidebarAccountSelect to also close the mobile drawer
  const handleAccountSelect = (account: Account) => {
    handleSidebarAccountSelect(account);
    setSheetOpen(false);
  };

  // Action guards
  const hasExport = Boolean(handleExportVoucher);
  const hasAnyEntry = entries.some((e) => (e?.accountId ?? 0) > 0);
  const canRunActions = paymentAccountId !== 0;
  const canPrint = canRunActions && hasAnyEntry;
  const canExport = canRunActions && hasAnyEntry && hasExport;

  // Tooltip reason for disabled print/export
  const printDisabledReason = !canRunActions
    ? `Select ${accountLabel} account first`
    : "Add at least one entry with an amount";

  // Validation state for summary warnings
  const validEntryCount = entries.filter((e) => (e?.accountId ?? 0) > 0 && parseFloat(e?.amount || "0") > 0).length;
  const missingAccount = paymentAccountId === 0;
  const missingEntries = validEntryCount === 0;

  // Why Save is disabled, said out loud rather than left to a dead button.
  const saveHint = missingAccount
    ? `Select a ${accountLabel} account to save`
    : total === 0
      ? "Add at least one line with an amount"
      : null;

  // ⌘/Ctrl+Enter saves from anywhere in the form, matching the keyboard-first entry flow.
  const handleFormKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!saveHint && !isPending) form.handleSubmit(onSubmit)();
    }
  };

  // Projected balance after save.
  // Payment edit: undo the original deduction, apply the new one.
  // Receipt edit: undo the original addition, apply the new one.
  const projected = isPayment
    ? isEditMode
      ? accountBalance + originalTotal - total
      : accountBalance - total
    : isEditMode
      ? accountBalance - originalTotal + total
      : accountBalance + total;

  // How much of the source account this voucher consumes, purely as a visual cue.
  // Capped at 100% so a voucher larger than the balance simply fills the bar.
  const meterPct = (() => {
    if (total <= 0) return 0;
    const capacity = Math.max(Math.abs(accountBalance), total);
    return capacity > 0 ? Math.min(100, (total / capacity) * 100) : 0;
  })();

  // When the Pay From / Receive Into field is active, restrict the sidebar and autocomplete to
  // Cash / Bank / Loans ledger accounts + bank accounts only.
  const payFromKeys = useMemo(() => {
    const src = payFromAccounts ?? allAccounts;
    return new Set(src.map((a) => `${a.type}:${a.id}`));
  }, [payFromAccounts, allAccounts]);

  const filteredSidebarForPayFrom = useMemo(
    () => filteredSidebarAccounts.filter((a) => payFromKeys.has(`${a.type}:${a.id}`)),
    [filteredSidebarAccounts, payFromKeys]
  );

  // Shared AccountSidebar props
  const sidebarProps = {
    accounts: sidebarAccounts,
    filteredAccounts: payFromActive ? filteredSidebarForPayFrom : filteredSidebarAccounts,
    onSelectAccount: handleAccountSelect,
    searchValue: sidebarSearchValue,
    onSearchChange: setSidebarSearchValue,
    selectedAccountId,
    selectedAccountType,
    highlightedIndex: sidebarHighlightedIndex,
    onHighlightedIndexChange: setSidebarHighlightedIndex,
    entries,
    mode: activeTab,
    paymentAccountId,
    paymentAccountType,
    voucherTotal: total,
    onCreateAccount: isFactoryCompany ? undefined : onCreateAccount,
    isFactoryCompany,
    onAutoCreateAccount,
    isAutoCreating,
    activeTargetLabel,
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      {/* ── Left column: form ── */}
      <div className="flex-1 min-w-0">
        <Card>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              onKeyDown={handleFormKeyDown}
              className="flex flex-col"
              noValidate
            >
              {/* ── Compact header strip ── */}
              <div
                className="relative flex items-center gap-2 px-4 py-3 border-b border-border/50 overflow-hidden flex-wrap rounded-t-lg"
                style={{
                  background: `linear-gradient(135deg, ${accentColor}22 0%, ${accentColor}08 55%, transparent 100%)`,
                }}
              >
                {/* Left accent stripe */}
                <div
                  className="absolute left-0 top-0 bottom-0 w-[3px] rounded-tl-lg"
                  style={{ backgroundColor: accentColor }}
                />

                {/* Icon tile */}
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white ml-2"
                  style={{
                    backgroundColor: accentColor,
                    boxShadow: `0 2px 8px ${accentColor}55, inset 0 1px 0 rgba(255,255,255,0.2)`,
                  }}
                >
                  <Icon className="h-4 w-4" />
                </div>

                {/* Title + badges */}
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="text-sm font-medium">{title}</span>
                  {isEditMode && (
                    <Badge variant="secondary" className="text-xs" data-testid="badge-editing">
                      Editing
                    </Badge>
                  )}
                  {voucherNumber && (
                    <span className="text-xs font-mono text-muted-foreground" data-testid="text-voucher-number">
                      #{voucherNumber}
                    </span>
                  )}
                </div>

                {/* Entry Date input */}
                <FormField
                  control={form.control}
                  name="voucherDate"
                  render={({ field }) => (
                    <FormItem className="shrink-0 space-y-0">
                      <FormControl>
                        <Input
                          type="date"
                          className="w-[9.5rem] h-8 text-xs"
                          value={
                            field.value instanceof Date
                              ? format(field.value, "yyyy-MM-dd")
                              : typeof field.value === "string"
                                ? field.value
                                : ""
                          }
                          onChange={(e) =>
                            field.onChange(e.target.value ? new Date(e.target.value + "T00:00:00") : new Date())
                          }
                          data-testid="input-date-picker"
                          title="Entry Date"
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />

                {/* Effective Date — optional, revealed on demand */}
                {onEffectiveDateChange &&
                  (showEffectiveDate ? (
                    <div className="shrink-0 flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground whitespace-nowrap">Eff.</span>
                      <Input
                        type="date"
                        className="w-[9.5rem] h-8 text-xs"
                        value={effectiveDate || ""}
                        onChange={(e) => onEffectiveDateChange(e.target.value)}
                        data-testid="input-effective-date"
                        title="Effective Date (optional — used for ledger/accounts)"
                      />
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 shrink-0 text-xs text-muted-foreground"
                      onClick={() => setShowEffectiveDate(true)}
                      data-testid="button-show-effective-date"
                    >
                      + Effective date
                    </Button>
                  ))}

                {/* Print */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className={!canPrint ? "cursor-not-allowed" : ""}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={!canPrint}
                        onClick={handlePrint}
                        data-testid="button-print"
                        className={cn("h-8 text-muted-foreground", !canPrint && "pointer-events-none")}
                      >
                        <Printer className="h-4 w-4" />
                        <span className="hidden sm:inline ml-1.5">Print</span>
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {!canPrint && (
                    <TooltipContent side="bottom" className="max-w-xs text-center">
                      {printDisabledReason}
                    </TooltipContent>
                  )}
                </Tooltip>

                {/* Export */}
                {hasExport && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className={!canExport ? "cursor-not-allowed" : ""}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={!canExport}
                              data-testid="button-export"
                              className={cn("h-8 text-muted-foreground", !canExport && "pointer-events-none")}
                            >
                              <FileDown className="h-4 w-4" />
                              <span className="hidden sm:inline ml-1.5">Export</span>
                              <ChevronDown className="h-3.5 w-3.5 ml-1" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleExportVoucher?.(false)} data-testid="export-summary">
                              <FileDown className="h-4 w-4 mr-2" />
                              Summary
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleExportVoucher?.(true)} data-testid="export-detailed">
                              <FileDown className="h-4 w-4 mr-2" />
                              Detailed
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </span>
                    </TooltipTrigger>
                    {!canExport && (
                      <TooltipContent side="bottom" className="max-w-xs text-center">
                        {printDisabledReason}
                      </TooltipContent>
                    )}
                  </Tooltip>
                )}

                {/* Mobile accounts drawer trigger — hidden on sm+ */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="sm:hidden shrink-0"
                  onClick={() => setSheetOpen(true)}
                  data-testid="button-open-accounts-drawer"
                >
                  <BookOpen className="h-4 w-4 mr-1.5" />
                  Accounts
                  {activeTargetLabel && (
                    <span className="ml-1.5 text-xs text-muted-foreground font-normal">— {activeTargetLabel}</span>
                  )}
                </Button>
              </div>

              {/* ── Form fields ── */}
              <div className="p-4 sm:p-5 space-y-6">
                {/* ── Source account + running total ── */}
                <div className="grid gap-3 lg:grid-cols-[1fr_minmax(170px,210px)]">
                  {/* Selected-account summary card — the picker collapses into this */}
                  {paymentAccountId > 0 && !editingSource && (
                    <VoucherSourceCard
                      label={accountLabel}
                      accountName={paymentAccountName}
                      accentColor={accentColor}
                      balance={accountBalance}
                      projected={projected}
                      total={total}
                      meterPct={meterPct}
                      currencyBalances={accountCurrencyBalances}
                      onChange={() => setEditingSource(true)}
                    />
                  )}

                  {/* Account picker — shown until an account is chosen, or on "Change" */}
                  <FormField
                    control={form.control}
                    name="paymentAccountId"
                    render={() => (
                      <FormItem
                        className={cn("min-w-0", paymentAccountId > 0 && !editingSource && "hidden")}
                        data-testid="field-source-picker"
                      >
                        <FormLabel>{accountLabel}</FormLabel>
                        <FormControl>
                          <div className="w-full min-w-0">
                            {/* Mobile: tappable card → opens Pay From sheet */}
                            <div
                              className="sm:hidden w-full rounded-md border bg-card px-3 py-2.5 flex items-center justify-between gap-2 cursor-pointer hover-elevate active-elevate-2 min-h-9"
                              onClick={() => {
                                setPayFromSearch("");
                                setPayFromSheetOpen(true);
                              }}
                              data-testid={`${accountTestId}-mobile-card`}
                            >
                              <span
                                className={cn(
                                  "text-sm truncate",
                                  paymentAccountId > 0 ? "font-medium" : "text-muted-foreground"
                                )}
                              >
                                {paymentAccountId > 0 ? paymentAccountName : accountPlaceholder}
                              </span>
                              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                            </div>
                            {/* Desktop: AccountAutocomplete */}
                            <div
                              className="hidden sm:block w-full min-w-0"
                              onFocus={() => {
                                setPayFromActive(true);
                                onAccountPickerOpen?.();
                              }}
                              onBlur={() => setPayFromTouched(true)}
                            >
                              <AccountAutocomplete
                                value={
                                  paymentAccountId > 0
                                    ? { type: paymentAccountType, id: paymentAccountId, name: paymentAccountName }
                                    : null
                                }
                                onChange={(type, id, name) => {
                                  form.setValue("paymentAccountType", type);
                                  form.setValue("paymentAccountId", id);
                                  form.setValue("paymentAccountName", name);
                                  setEditingSource(false);
                                }}
                                allAccounts={payFromAccounts ?? allAccounts}
                                rowIndex={-1}
                                placeholder={accountPlaceholder}
                                testId={accountTestId}
                                onSearchChange={onAccountSearchChange}
                              />
                            </div>
                          </div>
                        </FormControl>

                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Running total — stated up front, not discovered at the bottom */}
                  <div className="rounded-lg border bg-muted/20 px-4 py-3 flex flex-col justify-center">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {title.replace(" Voucher", "")} Total
                    </span>
                    <span
                      className={cn(
                        "text-2xl font-bold font-mono tabular-nums leading-tight mt-0.5",
                        total === 0 && "text-muted-foreground"
                      )}
                      style={total > 0 ? { color: accentColor } : undefined}
                      data-testid="text-hero-total"
                    >
                      {total > 0 ? formatAmount(total) : "—"}
                    </span>
                    <span className="text-xs text-muted-foreground mt-0.5 tabular-nums">
                      {validEntryCount} {validEntryCount === 1 ? "line" : "lines"}
                    </span>
                  </div>
                </div>

                <FormField
                  control={form.control}
                  name="paymentAccountNarration"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{accountLabel} narration</FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ""} placeholder="Optional narration for this account" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* ── Entries table ── */}
                <VoucherEntriesTable
                  form={form}
                  fieldArray={fieldArray}
                  entries={entries}
                  total={total}
                  mode={activeTab}
                  onAmountCommit={handleAmountCommit}
                  activeRow={activeRowIndex}
                  filteredSidebarAccounts={filteredSidebarAccounts}
                  sidebarHighlightedIndex={sidebarHighlightedIndex}
                  setSidebarHighlightedIndex={setSidebarHighlightedIndex}
                  setSidebarSearchValue={setSidebarSearchValue}
                  handleSidebarAccountSelect={handleAccountSelect}
                  sidebarAccounts={sidebarAccounts}
                  onRowFocus={(rowIndex, fieldName) => {
                    if (fieldName === "account") {
                      setPayFromActive(false);
                      setActiveRowIndex(rowIndex);
                      const currentAccountName = entries[rowIndex]?.accountName || "";
                      setSidebarSearchValue(currentAccountName);
                    }
                  }}
                  onRowBlur={() => {
                    // intentionally blank — amount commit clears active row
                  }}
                  isFactoryCompany={isFactoryCompany}
                  onAutoCreateAccount={onAutoCreateAccount}
                  isAutoCreating={isAutoCreating}
                />

                {/* ── Validation — held back until the form has been touched or submitted ── */}
                {showValidation && (missingAccount || missingEntries) && (
                  <div className="flex flex-col gap-1" data-testid="voucher-validation">
                    {missingAccount && (
                      <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                        <span>{accountLabel} account is required</span>
                      </div>
                    )}
                    {!missingAccount && missingEntries && (
                      <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                        <span>Add at least one entry with an amount</span>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Notes (collapsible) ── */}
                <Collapsible open={notesOpen} onOpenChange={setNotesOpen}>
                  <div className="flex items-center justify-between gap-2">
                    <CollapsibleTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="flex items-center gap-1.5 px-1 text-muted-foreground"
                        data-testid="button-toggle-notes"
                      >
                        {notesOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        <span className="text-xs font-medium">Notes</span>
                      </Button>
                    </CollapsibleTrigger>
                    {!notesOpen && form.watch("notes") && (
                      <span className="text-xs text-muted-foreground truncate max-w-xs italic">
                        {form.watch("notes")}
                      </span>
                    )}
                  </div>
                  <CollapsibleContent>
                    <FormField
                      control={form.control}
                      name="notes"
                      render={({ field }) => (
                        <FormItem className="mt-2">
                          <FormControl>
                            <Textarea {...field} placeholder="Additional notes..." rows={3} data-testid="input-notes" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </CollapsibleContent>
                </Collapsible>
              </div>

              {/* ── Action bar — the total stays with Save, pinned to the bottom of the card ── */}
              <div className="sticky bottom-0 z-20 rounded-b-lg border-t bg-card/95 px-4 sm:px-5 py-3 backdrop-blur supports-[backdrop-filter]:bg-card/80">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-5">
                    <div className="flex flex-col">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Lines
                      </span>
                      <span className="text-sm font-semibold font-mono tabular-nums">{validEntryCount}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Total
                      </span>
                      <span
                        className={cn(
                          "text-xl font-bold font-mono tabular-nums leading-tight",
                          total === 0 && "text-muted-foreground"
                        )}
                        style={total > 0 ? { color: accentColor } : undefined}
                        data-testid="text-total-amount"
                      >
                        {total > 0 ? formatAmount(total) : "—"}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 flex-wrap justify-end flex-1 min-w-0">
                    <FormField
                      control={form.control}
                      name="optional"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center gap-2 space-y-0">
                          <FormControl>
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                              data-testid="checkbox-optional"
                            />
                          </FormControl>
                          <FormLabel
                            className="cursor-pointer text-xs text-muted-foreground font-normal"
                            title="Excluded from required balance checks"
                          >
                            Optional
                          </FormLabel>
                        </FormItem>
                      )}
                    />

                    <div className="flex flex-col items-end gap-1 w-full sm:w-auto">
                      <Button
                        type="submit"
                        size="default"
                        className="w-full sm:w-auto"
                        disabled={paymentAccountId === 0 || total === 0 || isPending}
                        data-testid="button-save-voucher"
                      >
                        {isPending
                          ? isEditMode
                            ? "Updating…"
                            : "Saving…"
                          : isEditMode
                            ? `Update Voucher${total > 0 ? ` · ${formatAmount(total)}` : ""}`
                            : `Save Voucher${total > 0 ? ` · ${formatAmount(total)}` : ""}`}
                      </Button>
                      {saveHint ? (
                        <span className="text-[11px] text-muted-foreground" data-testid="text-save-hint">
                          {saveHint}
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground hidden sm:block">
                          <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">⌘</kbd>
                          <kbd className="px-1 py-0.5 bg-muted rounded text-[10px] ml-1">↵</kbd> to save
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </form>
          </Form>
        </Card>
      </div>

      {/* ── Right column: Account Sidebar — hidden on mobile, visible on sm+ ── */}
      <div
        className="hidden sm:block w-full lg:w-[40%] lg:sticky lg:top-4 h-fit"
        style={{ maxHeight: "calc(100vh - 2rem)" }}
      >
        <AccountSidebar {...sidebarProps} />
      </div>

      {/* ── Mobile Account Drawer (Sheet) — entry rows ── */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full sm:max-w-sm p-0 flex flex-col" data-testid="sheet-accounts-drawer">
          <SheetHeader className="p-4 border-b shrink-0">
            <SheetTitle className="text-base">
              {activeTargetLabel ? `Accounts — ${activeTargetLabel}` : "Select Account"}
            </SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden">
            <AccountSidebar {...sidebarProps} />
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Mobile Pay From / Receive Into Sheet ── */}
      <Sheet
        open={payFromSheetOpen}
        onOpenChange={(isOpen) => {
          setPayFromSheetOpen(isOpen);
          if (!isOpen) setPayFromSearch("");
        }}
      >
        <SheetContent side="bottom" className="flex flex-col p-0" style={{ height: "auto", maxHeight: "88vh" }}>
          <SheetHeader className="px-4 pt-4 pb-3 border-b shrink-0">
            <SheetTitle className="text-base">{accountLabel}</SheetTitle>
            <div className="relative mt-2">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                autoFocus
                placeholder={`Search ${accountLabel.toLowerCase()}...`}
                value={payFromSearch}
                onChange={(e) => setPayFromSearch(e.target.value)}
                className="pl-9"
                data-testid="input-pay-from-mobile-search"
              />
            </div>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto min-h-0">
            {(() => {
              const search = payFromSearch.toLowerCase().replace(/[\s.-]/g, "");
              const filtered = sidebarAccounts.filter((a) => {
                // Only show cash / bank / loan eligible accounts in the Pay From sheet
                if (!payFromKeys.has(`${a.type}:${a.id}`)) return false;
                if (!payFromSearch) return true;
                return a.name
                  .toLowerCase()
                  .replace(/[\s.-]/g, "")
                  .includes(search);
              });
              if (filtered.length === 0) {
                return (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {payFromSearch ? "No accounts match your search" : "No accounts available"}
                  </div>
                );
              }
              return filtered.slice(0, 40).map((account) => {
                const isSelected = account.id === paymentAccountId && account.type === paymentAccountType;
                const bal =
                  typeof account.balance === "string" ? parseFloat(account.balance) : (account.balance ?? null);
                return (
                  <button
                    key={`${account.type}-${account.id}`}
                    type="button"
                    className={cn(
                      "w-full text-left px-4 py-3 border-b border-muted/40 flex items-center justify-between gap-3 active-elevate-2",
                      isSelected && "bg-accent"
                    )}
                    onClick={() => {
                      form.setValue("paymentAccountType", account.type);
                      form.setValue("paymentAccountId", account.id);
                      form.setValue("paymentAccountName", account.name);
                      setEditingSource(false);
                      setPayFromTouched(true);
                      setPayFromSheetOpen(false);
                    }}
                    data-testid={`pay-from-mobile-option-${account.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{account.name}</div>
                      {bal != null && (
                        <div className="text-xs text-muted-foreground font-mono mt-0.5">{formatAmount(bal)}</div>
                      )}
                    </div>
                    {isSelected && <div className="h-2 w-2 rounded-full bg-primary shrink-0" />}
                  </button>
                );
              });
            })()}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
