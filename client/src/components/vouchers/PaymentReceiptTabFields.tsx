// Extracted from ./PaymentReceiptTab.tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronUp, ChevronRight, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { AccountAutocomplete } from "@/components/AccountAutocomplete";
import { VoucherEntriesTable } from "@/components/vouchers/VoucherEntriesTable";
import { VoucherSourceCard } from "@/components/vouchers/VoucherSourceCard";
import { FxWalletPaymentSection, FxWalletSourceCard } from "@/components/vouchers/FxWalletPayment";
import type { PaymentReceiptTabProps } from "./PaymentReceiptTab";
import type { PaymentReceiptTabModel } from "./PaymentReceiptTabModel";

export function PaymentReceiptTabFields({
  m,
  paymentAccountId,
  paymentAccountName,
  accountBalance,
  total,
  accountCurrencyBalances,
  fxWallet,
  form,
  onAccountPickerOpen,
  paymentAccountType,
  payFromAccounts,
  allAccounts,
  onAccountSearchChange,
  entries,
  fxPayoutCurrency,
  fxPaymentRate,
  fxSupplierEurBalance,
  fxSupplierEurBasis,
  fxSupplierBalanceLoading,
  onFxPaymentRateChange,
  onFxPayoutCurrencyChange,
  fxWalletsLoading,
  fieldArray,
  activeTab,
  handleAmountCommit,
  activeRowIndex,
  filteredSidebarAccounts,
  sidebarHighlightedIndex,
  setSidebarHighlightedIndex,
  setSidebarSearchValue,
  sidebarAccounts,
  setActiveRowIndex,
  isFactoryCompany,
  onAutoCreateAccount,
  isAutoCreating,
}: {
  m: PaymentReceiptTabModel;
  paymentAccountId: PaymentReceiptTabProps["paymentAccountId"];
  paymentAccountName: PaymentReceiptTabProps["paymentAccountName"];
  accountBalance: PaymentReceiptTabProps["accountBalance"];
  total: PaymentReceiptTabProps["total"];
  accountCurrencyBalances: PaymentReceiptTabProps["accountCurrencyBalances"];
  fxWallet: PaymentReceiptTabProps["fxWallet"];
  form: PaymentReceiptTabProps["form"];
  onAccountPickerOpen: PaymentReceiptTabProps["onAccountPickerOpen"];
  paymentAccountType: PaymentReceiptTabProps["paymentAccountType"];
  payFromAccounts: PaymentReceiptTabProps["payFromAccounts"];
  allAccounts: PaymentReceiptTabProps["allAccounts"];
  onAccountSearchChange: PaymentReceiptTabProps["onAccountSearchChange"];
  entries: PaymentReceiptTabProps["entries"];
  fxPayoutCurrency: Exclude<PaymentReceiptTabProps["fxPayoutCurrency"], undefined>;
  fxPaymentRate: Exclude<PaymentReceiptTabProps["fxPaymentRate"], undefined>;
  fxSupplierEurBalance: Exclude<PaymentReceiptTabProps["fxSupplierEurBalance"], undefined>;
  fxSupplierEurBasis: Exclude<PaymentReceiptTabProps["fxSupplierEurBasis"], undefined>;
  fxSupplierBalanceLoading: Exclude<PaymentReceiptTabProps["fxSupplierBalanceLoading"], undefined>;
  onFxPaymentRateChange: PaymentReceiptTabProps["onFxPaymentRateChange"];
  onFxPayoutCurrencyChange: PaymentReceiptTabProps["onFxPayoutCurrencyChange"];
  fxWalletsLoading: Exclude<PaymentReceiptTabProps["fxWalletsLoading"], undefined>;
  fieldArray: PaymentReceiptTabProps["fieldArray"];
  activeTab: PaymentReceiptTabProps["activeTab"];
  handleAmountCommit: PaymentReceiptTabProps["handleAmountCommit"];
  activeRowIndex: PaymentReceiptTabProps["activeRowIndex"];
  filteredSidebarAccounts: PaymentReceiptTabProps["filteredSidebarAccounts"];
  sidebarHighlightedIndex: PaymentReceiptTabProps["sidebarHighlightedIndex"];
  setSidebarHighlightedIndex: PaymentReceiptTabProps["setSidebarHighlightedIndex"];
  setSidebarSearchValue: PaymentReceiptTabProps["setSidebarSearchValue"];
  sidebarAccounts: PaymentReceiptTabProps["sidebarAccounts"];
  setActiveRowIndex: PaymentReceiptTabProps["setActiveRowIndex"];
  isFactoryCompany: Exclude<PaymentReceiptTabProps["isFactoryCompany"], undefined>;
  onAutoCreateAccount: PaymentReceiptTabProps["onAutoCreateAccount"];
  isAutoCreating: Exclude<PaymentReceiptTabProps["isAutoCreating"], undefined>;
}) {
  return (
    <div className="voucher-fields p-4 sm:p-5 space-y-6">
      {/* ── Source account + running total ── */}
      <div className="grid gap-3 lg:grid-cols-[1fr_minmax(170px,210px)]">
        {/* Selected-account summary card — the picker collapses into this */}
        {paymentAccountId > 0 && !m.editingSource && !m.isFxPayment && (
          <VoucherSourceCard
            label={m.accountLabel}
            accountName={paymentAccountName}
            accentColor={m.accentColor}
            balance={accountBalance}
            projected={m.projected}
            total={total}
            meterPct={m.meterPct}
            currencyBalances={accountCurrencyBalances}
            onChange={() => m.setEditingSource(true)}
          />
        )}

        {m.isFxPayment && paymentAccountId > 0 && !m.editingSource && (
          <FxWalletSourceCard
            accountName={paymentAccountName}
            eurAvailable={fxWallet!.state.eur}
            onChange={() => m.setEditingSource(true)}
          />
        )}

        {/* Account picker — shown until an account is chosen, or on "Change" */}
        <FormField
          control={form.control}
          name="paymentAccountId"
          render={() => (
            <FormItem
              className={cn("min-w-0", paymentAccountId > 0 && !m.editingSource && "hidden")}
              data-testid="field-source-picker"
            >
              <FormLabel>{m.accountLabel}</FormLabel>
              <FormControl>
                <div className="w-full min-w-0">
                  {/* Mobile: tappable card → opens Pay From sheet */}
                  <div
                    className="sm:hidden w-full rounded-md border bg-card px-3 py-2.5 flex items-center justify-between gap-2 cursor-pointer hover-elevate active-elevate-2 min-h-9"
                    onClick={() => {
                      m.setPayFromSearch("");
                      m.setPayFromSheetOpen(true);
                    }}
                    data-testid={`${m.accountTestId}-mobile-card`}
                  >
                    <span
                      className={cn("text-sm truncate", paymentAccountId > 0 ? "font-medium" : "text-muted-foreground")}
                    >
                      {paymentAccountId > 0 ? paymentAccountName : m.accountPlaceholder}
                    </span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </div>
                  {/* Desktop: AccountAutocomplete */}
                  <div
                    className="hidden sm:block w-full min-w-0"
                    onFocus={() => {
                      m.setPayFromActive(true);
                      onAccountPickerOpen?.();
                    }}
                    onBlur={() => m.setPayFromTouched(true)}
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
                        m.setEditingSource(false);
                      }}
                      allAccounts={payFromAccounts ?? allAccounts}
                      rowIndex={-1}
                      placeholder={m.accountPlaceholder}
                      testId={m.accountTestId}
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
        <div className="voucher-total-card rounded-lg border bg-muted/20 px-4 py-3 flex flex-col justify-center">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {m.title.replace(" Voucher", "")} Total
          </span>
          <span
            className={cn(
              "text-2xl font-bold font-mono tabular-nums leading-tight mt-0.5",
              total === 0 && "text-muted-foreground"
            )}
            style={total > 0 ? { color: m.accentColor } : undefined}
            data-testid="text-hero-total"
          >
            {total > 0 ? (m.directEurPayment ? `EUR ${total.toFixed(2)}` : m.formatAmount(total)) : "—"}
          </span>
          <span className="text-xs text-muted-foreground mt-0.5 tabular-nums">
            {m.validEntryCount} {m.validEntryCount === 1 ? "line" : "lines"}
          </span>
        </div>
      </div>

      <FormField
        control={form.control}
        name="paymentAccountNarration"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{m.accountLabel} narration</FormLabel>
            <FormControl>
              <Input {...field} value={field.value ?? ""} placeholder="Optional narration for this account" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      {m.isFxPayment && (
        <FxWalletPaymentSection
          fxWallet={fxWallet!}
          directEurPayment={m.directEurPayment}
          showPayoutToggle={entries[0]?.accountType === "factorySupplier"}
          fxPayoutCurrency={fxPayoutCurrency}
          fxPaymentRate={fxPaymentRate}
          fxRateValue={m.fxRateValue}
          fxEurRequired={m.fxEurRequired}
          fxSupplierEurBalance={fxSupplierEurBalance ?? null}
          fxSupplierEurBasis={fxSupplierEurBasis}
          fxSupplierBalanceLoading={fxSupplierBalanceLoading}
          fxUnsupportedEntries={m.fxUnsupportedEntries}
          total={total}
          onFxPaymentRateChange={onFxPaymentRateChange}
          onFxPayoutCurrencyChange={onFxPayoutCurrencyChange}
        />
      )}
      {m.isPayment && fxWalletsLoading && (
        <p className="text-xs text-muted-foreground">Loading FX wallet status before payment…</p>
      )}
      {/* ── Entries table ── */}
      <VoucherEntriesTable
        amountCurrencyOverride={m.directEurPayment ? "EUR" : undefined}
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
        handleSidebarAccountSelect={m.handleAccountSelect}
        sidebarAccounts={sidebarAccounts}
        onRowFocus={(rowIndex, fieldName) => {
          if (fieldName === "account") {
            m.setPayFromActive(false);
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
      {m.showValidation && (m.missingAccount || m.missingEntries) && (
        <div className="flex flex-col gap-1" data-testid="voucher-validation">
          {m.missingAccount && (
            <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>{m.accountLabel} account is required</span>
            </div>
          )}
          {!m.missingAccount && m.missingEntries && (
            <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>Add at least one entry with an amount</span>
            </div>
          )}
        </div>
      )}
      {/* ── Notes (collapsible) ── */}
      <Collapsible open={m.notesOpen} onOpenChange={m.setNotesOpen}>
        <div className="flex items-center justify-between gap-2">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="flex items-center gap-1.5 px-1 text-muted-foreground"
              data-testid="button-toggle-notes"
            >
              {m.notesOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              <span className="text-xs font-medium">Notes</span>
            </Button>
          </CollapsibleTrigger>
          {!m.notesOpen && form.watch("notes") && (
            <span className="text-xs text-muted-foreground truncate max-w-xs italic">{form.watch("notes")}</span>
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
  );
}
