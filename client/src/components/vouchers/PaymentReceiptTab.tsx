import { VoucherActionBar, VoucherOptionalSwitch } from "@/pages/vouchers/VoucherActionBar";
import { UseFormReturn, UseFieldArrayReturn, type SubmitHandler } from "react-hook-form";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem } from "@/components/ui/form";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CombinedAccount } from "@/components/AccountAutocomplete";
import AccountSidebar, { Account } from "@/components/AccountSidebar";
import { type VoucherEntry } from "@/components/vouchers/VoucherEntriesTable";
import type { VoucherFormData } from "@/pages/vouchers/voucherTypes";
import { type FxWalletSummary } from "@/components/vouchers/FxWalletPayment";
import { PayFromAccountSheet } from "@/components/vouchers/PayFromAccountSheet";
import { PaymentReceiptHeaderActions } from "@/components/vouchers/PaymentReceiptHeaderActions";
import { usePaymentReceiptTabModel } from "./PaymentReceiptTabModel";
import { PaymentReceiptTabFields } from "./PaymentReceiptTabFields";

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
  fxWallet?: FxWalletSummary;
  fxWalletsLoading?: boolean;
  fxPaymentRate?: string;
  onFxPaymentRateChange?: (value: string) => void;
  fxPayoutCurrency?: "EUR" | "USD";
  fxSupplierEurBalance?: number | null;
  fxSupplierEurBasis?: "broker-statement" | "native-ledger" | null;
  fxSupplierBalanceLoading?: boolean;
  onFxPayoutCurrencyChange?: (currency: "EUR" | "USD") => void;
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
  fxWallet,
  fxWalletsLoading = false,
  fxPaymentRate = "",
  onFxPaymentRateChange,
  fxPayoutCurrency = "USD",
  fxSupplierEurBalance = null,
  fxSupplierEurBasis = null,
  fxSupplierBalanceLoading = false,
  onFxPayoutCurrencyChange,
  voucherNumber,
  onAccountPickerOpen,
  onAccountSearchChange,
  effectiveDate,
  onEffectiveDateChange,
}: PaymentReceiptTabProps) {
  const m = usePaymentReceiptTabModel({
    form,
    entries,
    total,
    paymentAccountId,
    paymentAccountType,
    accountBalance,
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
    handleExportVoucher,
    activeTab,
    activeRowIndex,
    onCreateAccount,
    isFactoryCompany,
    onAutoCreateAccount,
    isAutoCreating,
    isEditMode,
    originalTotal,
    fxWallet,
    fxWalletsLoading,
    fxPaymentRate,
    fxPayoutCurrency,
    fxSupplierEurBalance,
    fxSupplierBalanceLoading,
    effectiveDate,
  });

  return (
    // Three columns (type nav, form, account picker) only from xl: at lg with the sidebar pinned the
    // form had ~450px and its labels wrapped letter by letter.
    <div className="flex flex-col xl:flex-row gap-4">
      {/* ── Left column: form ── */}
      <div className="flex-1 min-w-0">
        <Card className="voucher-form-card">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col" noValidate>
              {/* ── Compact header strip ── */}
              <div
                className="voucher-hero relative flex items-center gap-2 px-4 py-3 border-b border-border/50 overflow-hidden flex-wrap rounded-t-lg"
                style={{
                  background: `linear-gradient(135deg, ${m.accentColor}22 0%, ${m.accentColor}08 55%, transparent 100%)`,
                }}
              >
                {/* Left accent stripe */}
                <div
                  className="absolute left-0 top-0 bottom-0 w-[3px] rounded-tl-lg"
                  style={{ backgroundColor: m.accentColor }}
                />

                {/* Icon tile */}
                <div
                  className="voucher-hero-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white ml-2"
                  style={{
                    backgroundColor: m.accentColor,
                    boxShadow: `0 2px 8px ${m.accentColor}55, inset 0 1px 0 rgba(255,255,255,0.2)`,
                  }}
                >
                  <m.Icon className="h-4 w-4" />
                </div>

                {/* Title + badges */}
                {/* min-w keeps the title readable: the row wraps the date input instead of covering it. */}
                <div className="voucher-hero-heading flex flex-col gap-0.5 flex-1 min-w-[9rem]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="voucher-hero-title text-sm font-semibold">{m.title}</span>
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
                  <span className="voucher-hero-subtitle">
                    {m.isPayment ? "Create a new payment entry" : "Record incoming funds"}
                  </span>
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
                          className="w-38 h-8 text-xs"
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
                  (m.showEffectiveDate ? (
                    <div className="shrink-0 flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground whitespace-nowrap">Eff.</span>
                      <Input
                        type="date"
                        className="w-38 h-8 text-xs"
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
                      onClick={() => m.setShowEffectiveDate(true)}
                      data-testid="button-show-effective-date"
                    >
                      + Effective date
                    </Button>
                  ))}

                {/* Mobile accounts drawer trigger — hidden on sm+ */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="sm:hidden shrink-0"
                  onClick={() => m.setSheetOpen(true)}
                  data-testid="button-open-accounts-drawer"
                >
                  <BookOpen className="h-4 w-4 mr-1.5" />
                  Accounts
                  {m.activeTargetLabel && (
                    <span className="ml-1.5 text-xs text-muted-foreground font-normal">— {m.activeTargetLabel}</span>
                  )}
                </Button>
              </div>

              {/* ── Form fields ── */}
              <PaymentReceiptTabFields
                m={m}
                paymentAccountId={paymentAccountId}
                paymentAccountName={paymentAccountName}
                accountBalance={accountBalance}
                total={total}
                accountCurrencyBalances={accountCurrencyBalances}
                fxWallet={fxWallet}
                form={form}
                onAccountPickerOpen={onAccountPickerOpen}
                paymentAccountType={paymentAccountType}
                payFromAccounts={payFromAccounts}
                allAccounts={allAccounts}
                onAccountSearchChange={onAccountSearchChange}
                entries={entries}
                fxPayoutCurrency={fxPayoutCurrency}
                fxPaymentRate={fxPaymentRate}
                fxSupplierEurBalance={fxSupplierEurBalance}
                fxSupplierEurBasis={fxSupplierEurBasis}
                fxSupplierBalanceLoading={fxSupplierBalanceLoading}
                onFxPaymentRateChange={onFxPaymentRateChange}
                onFxPayoutCurrencyChange={onFxPayoutCurrencyChange}
                fxWalletsLoading={fxWalletsLoading}
                fieldArray={fieldArray}
                activeTab={activeTab}
                handleAmountCommit={handleAmountCommit}
                activeRowIndex={activeRowIndex}
                filteredSidebarAccounts={filteredSidebarAccounts}
                sidebarHighlightedIndex={sidebarHighlightedIndex}
                setSidebarHighlightedIndex={setSidebarHighlightedIndex}
                setSidebarSearchValue={setSidebarSearchValue}
                sidebarAccounts={sidebarAccounts}
                setActiveRowIndex={setActiveRowIndex}
                isFactoryCompany={isFactoryCompany}
                onAutoCreateAccount={onAutoCreateAccount}
                isAutoCreating={isAutoCreating}
              />

              {/* ── Action bar — the total stays with Save, pinned to the bottom of the card ── */}
              <VoucherActionBar
                isEditing={!!isEditMode}
                saving={isPending}
                disabled={m.saveDisabled}
                hint={m.saveHint ? <span data-testid="text-save-hint">{m.saveHint}</span> : null}
                saveTestId="button-save-voucher"
                data-testid="payment-receipt-actions"
                className="mt-0"
                summary={
                  <div className="flex items-center gap-5">
                    <div className="flex flex-col">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Lines
                      </span>
                      <span className="text-sm font-semibold font-mono tabular-nums">{m.validEntryCount}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Total
                      </span>
                      <span
                        className={cn(
                          "text-xl font-bold font-mono tabular-nums leading-tight",
                          total === 0 && "text-muted-foreground"
                        )}
                        style={total > 0 ? { color: m.accentColor } : undefined}
                        data-testid="text-total-amount"
                      >
                        {m.totalLabel}
                      </span>
                    </div>
                  </div>
                }
                phoneSummary={`${m.validEntryCount} ${m.validEntryCount === 1 ? "line" : "lines"} · ${m.totalLabel}`}
                optional={
                  <FormField
                    control={form.control}
                    name="optional"
                    render={({ field }) => (
                      <VoucherOptionalSwitch
                        checked={m.isFxPayment ? false : field.value}
                        disabled={m.isFxPayment}
                        onCheckedChange={field.onChange}
                        data-testid="checkbox-optional"
                      />
                    )}
                  />
                }
                secondary={
                  <PaymentReceiptHeaderActions
                    canPrint={m.canPrint}
                    canExport={m.canExport}
                    hasExport={m.hasExport}
                    printDisabledReason={m.printDisabledReason}
                    handlePrint={handlePrint}
                    handleExportVoucher={handleExportVoucher}
                  />
                }
              />
            </form>
          </Form>
        </Card>
      </div>

      {/* ── Right column: Account Sidebar — hidden on mobile, visible on sm+ ── */}
      <div
        className="hidden sm:block w-full xl:w-[40%] xl:sticky xl:top-4 h-fit"
        style={{ maxHeight: "calc(100dvh - 2rem)" }}
      >
        <AccountSidebar {...m.sidebarProps} />
      </div>

      {/* ── Mobile Account Drawer (Sheet) — entry rows ── */}
      <Sheet open={m.sheetOpen} onOpenChange={m.setSheetOpen}>
        <SheetContent side="right" className="w-full sm:max-w-sm p-0 flex flex-col" data-testid="sheet-accounts-drawer">
          <SheetHeader className="p-4 border-b shrink-0">
            <SheetTitle className="text-base">
              {m.activeTargetLabel ? `Accounts — ${m.activeTargetLabel}` : "Select Account"}
            </SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden">
            <AccountSidebar {...m.sidebarProps} />
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Mobile Pay From / Receive Into Sheet ── */}
      <PayFromAccountSheet
        open={m.payFromSheetOpen}
        onOpenChange={(isOpen) => {
          m.setPayFromSheetOpen(isOpen);
          if (!isOpen) m.setPayFromSearch("");
        }}
        accountLabel={m.accountLabel}
        payFromSearch={m.payFromSearch}
        setPayFromSearch={m.setPayFromSearch}
        sidebarAccounts={sidebarAccounts}
        payFromKeys={m.payFromKeys}
        paymentAccountId={paymentAccountId}
        paymentAccountType={paymentAccountType}
        formatAmount={m.formatAmount}
        onSelect={(account) => {
          form.setValue("paymentAccountType", account.type);
          form.setValue("paymentAccountId", account.id);
          form.setValue("paymentAccountName", account.name);
          m.setEditingSource(false);
          m.setPayFromTouched(true);
          m.setPayFromSheetOpen(false);
        }}
      />
    </div>
  );
}
