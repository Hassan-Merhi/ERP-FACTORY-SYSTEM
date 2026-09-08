import { useState, useRef, useEffect } from "react";
import { UseFormReturn, UseFieldArrayReturn } from "react-hook-form";
import type { VoucherFormData } from "@/pages/vouchers/voucherTypes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Plus, X, Search, Check } from "lucide-react";
import type { Account } from "@/components/AccountSidebar";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { cn } from "@/lib/utils";
import { focusScopedTestId } from "@/lib/scopedFocus";

const ENTRY_TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  bank: { label: "Bank", cls: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300" },
  ledger: { label: "Ledger", cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  supplier: { label: "Supplier", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300" },
  employee: { label: "Staff", cls: "bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300" },
  fixedAsset: { label: "Asset", cls: "bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300" },
  customer: { label: "Customer", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" },
  factorySupplier: { label: "F.Supp", cls: "bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300" },
};

/**
 * One row of the entries table, derived from the voucher form's own Zod schema
 * so the table and the form cannot drift apart.
 */
export type VoucherEntry = VoucherFormData["entries"][number];

interface VoucherEntriesTableProps {
  form: UseFormReturn<VoucherFormData>;
  fieldArray: UseFieldArrayReturn<VoucherFormData, "entries", "id">;
  entries: VoucherEntry[];
  total: number;
  mode: "payment" | "receipt";
  onAmountCommit?: (rowIndex: number) => void;
  activeRow: number | null;
  filteredSidebarAccounts: Account[];
  sidebarHighlightedIndex: number;
  setSidebarHighlightedIndex: (index: number) => void;
  setSidebarSearchValue: (value: string) => void;
  handleSidebarAccountSelect: (account: Account) => void;
  sidebarAccounts?: Account[];
  onRowFocus: (rowIndex: number, fieldName: string) => void;
  onRowBlur: () => void;
  isFactoryCompany?: boolean;
  onAutoCreateAccount?: (name: string) => Promise<Account | null>;
  isAutoCreating?: boolean;
}

export function VoucherEntriesTable({
  form,
  fieldArray,
  entries,
  total,
  mode,
  onAmountCommit,
  activeRow,
  filteredSidebarAccounts,
  sidebarHighlightedIndex,
  setSidebarHighlightedIndex,
  setSidebarSearchValue,
  handleSidebarAccountSelect,
  sidebarAccounts = [],
  onRowFocus,
  onRowBlur,
  isFactoryCompany = false,
  onAutoCreateAccount,
  isAutoCreating: _isAutoCreating = false,
}: VoucherEntriesTableProps) {
  const { fields, append, remove } = fieldArray;
  const { formatAmount, selectedCurrency, convertToUSD } = useCurrencyContext();

  const [mobileEditIndex, setMobileEditIndex] = useState<number | null>(null);
  const [mobileEditOpen, setMobileEditOpen] = useState(false);
  const [mobileSearch, setMobileSearch] = useState("");
  const [mobileAmountStr, setMobileAmountStr] = useState("");
  const [mobileNarration, setMobileNarration] = useState("");
  const mobileAmountInputRef = useRef<HTMLInputElement>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!mobileEditOpen || mobileEditIndex === null) return;
    const current = form.getValues(`entries.${mobileEditIndex}.amount`) || "";
    setMobileAmountStr(current);
    setMobileNarration(form.getValues(`entries.${mobileEditIndex}.narration`) || "");
    onRowFocus(mobileEditIndex, "account");
    setSidebarSearchValue("");
    setMobileSearch("");
    const timer = setTimeout(() => mobileSearchInputRef.current?.focus(), 150);
    return () => clearTimeout(timer);
  }, [mobileEditOpen, mobileEditIndex, form, onRowFocus, setSidebarSearchValue]);

  const openMobileEdit = (index: number) => {
    setMobileEditIndex(index);
    setMobileEditOpen(true);
  };

  const handleMobileAddRow = () => {
    const newIndex = fields.length;
    append({ accountType: "ledger", accountId: 0, accountName: "", amount: "" });
    setTimeout(() => {
      setMobileEditIndex(newIndex);
      setMobileEditOpen(true);
    }, 50);
  };

  const handleMobileAccountSelect = (account: Account) => {
    handleSidebarAccountSelect(account);
    setMobileSearch("");
    setSidebarSearchValue("");
    setTimeout(() => mobileAmountInputRef.current?.focus(), 120);
  };

  const handleMobileDone = () => {
    if (mobileEditIndex !== null) {
      const numVal = parseFloat(mobileAmountStr);
      const isPositive = !isNaN(numVal) && numVal > 0;
      const finalAmount = isPositive
        ? selectedCurrency !== "USD"
          ? convertToUSD(numVal).toFixed(2)
          : numVal.toFixed(2)
        : "";
      form.setValue(`entries.${mobileEditIndex}.amount`, finalAmount);
      form.setValue(`entries.${mobileEditIndex}.narration`, mobileNarration);
      if (isPositive && onAmountCommit) onAmountCommit(mobileEditIndex);
    }
    setMobileEditOpen(false);
  };

  const getEntryBalance = (index: number): number | null => {
    const entry = entries[index];
    if (!entry || !entry.accountId || !sidebarAccounts.length) return null;
    const found = sidebarAccounts.find((account) => {
      if (account.type !== entry.accountType) return false;
      if (entry.accountType === "employee") {
        return (account as unknown as Account & { accountId: number }).accountId === entry.accountId;
      }
      return account.id === entry.accountId;
    });
    if (!found || found.balance == null) return null;
    return typeof found.balance === "string" ? parseFloat(found.balance) : found.balance;
  };

  const handleAddRow = () => {
    append({ accountType: "ledger", accountId: 0, accountName: "", amount: "" });
  };

  const focusField = (
    field: "account" | "amount",
    index: number,
    select = true,
    anchor?: Element | null,
    delay = 0
  ) => {
    focusScopedTestId(`input-${field}-${index}`, { select, anchor, delay });
  };

  const handleAccountKeyDown = async (e: React.KeyboardEvent, index: number) => {
    const anchor = e.currentTarget as Element;
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const hasAccount = (entries[index]?.accountId ?? 0) > 0;
      if (!hasAccount && filteredSidebarAccounts.length > 0 && sidebarHighlightedIndex >= 0) {
        const highlighted = filteredSidebarAccounts[sidebarHighlightedIndex];
        if (highlighted) handleSidebarAccountSelect(highlighted);
      }
      focusField("amount", index, true, anchor);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filteredSidebarAccounts.length === 0) return;
      setSidebarHighlightedIndex(
        Math.min(sidebarHighlightedIndex < 0 ? 0 : sidebarHighlightedIndex + 1, filteredSidebarAccounts.length - 1)
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filteredSidebarAccounts.length === 0) return;
      setSidebarHighlightedIndex(Math.max(sidebarHighlightedIndex - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const currentName = form.getValues(`entries.${index}.accountName`)?.trim() || "";
      if (isFactoryCompany && onAutoCreateAccount && currentName) {
        const exactMatch = filteredSidebarAccounts.find(
          (account) => account.name.toLowerCase() === currentName.toLowerCase()
        );
        if (exactMatch) handleSidebarAccountSelect(exactMatch);
        else {
          const newAccount = await onAutoCreateAccount(currentName);
          if (newAccount) handleSidebarAccountSelect(newAccount);
        }
      } else if (filteredSidebarAccounts.length > 0 && sidebarHighlightedIndex >= 0) {
        const highlightedAccount = filteredSidebarAccounts[sidebarHighlightedIndex];
        if (highlightedAccount) handleSidebarAccountSelect(highlightedAccount);
      }
    }
  };

  const handleAmountKeyDown = (e: React.KeyboardEvent, index: number) => {
    const anchor = e.currentTarget as Element;
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const amount = Number(entries[index]?.amount);
      if (!isNaN(amount) && amount > 0 && onAmountCommit) onAmountCommit(index);
      const isLastRow = index === fields.length - 1;
      const rowHasContent = (entries[index]?.accountId ?? 0) > 0 || (!isNaN(amount) && amount > 0);
      if (isLastRow) {
        if (!rowHasContent) return;
        handleAddRow();
      }
      focusField("account", index + 1, false, anchor);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusField("account", index, false, anchor);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (index < fields.length - 1) focusField("account", index + 1, false, anchor);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const amount = Number(entries[index]?.amount);
      if (!isNaN(amount) && amount > 0) {
        if (onAmountCommit) onAmountCommit(index);
        handleAddRow();
        focusField("account", entries.length, true, anchor);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (index > 0) focusField("amount", index - 1, true, anchor);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (index < entries.length - 1) focusField("amount", index + 1, true, anchor);
    }
  };

  const handleAmountBlur = (e: React.FocusEvent<HTMLInputElement>, index: number) => {
    const enteredAmount = Number(e.target.value);
    if (!isNaN(enteredAmount) && enteredAmount > 0) {
      if (selectedCurrency !== "USD") {
        const usdAmount = convertToUSD(enteredAmount);
        form.setValue(`entries.${index}.amount`, usdAmount.toFixed(2));
      }
      if (onAmountCommit) onAmountCommit(index);
    }
  };

  const renderBalanceLine = (index: number) => {
    const balance = getEntryBalance(index);
    if (balance == null) return null;
    return (
      <p
        className={`text-[10px] font-mono tabular-nums mt-0.5 ${
          balance < 0
            ? "text-red-500 dark:text-red-400"
            : balance > 0
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground"
        }`}
      >
        bal {formatAmount(balance)}
      </p>
    );
  };

  const runningTotals: number[] = [];
  let running = 0;
  for (let index = 0; index < fields.length; index++) {
    const value = parseFloat(entries[index]?.amount || "0");
    if (!isNaN(value) && value > 0) running += value;
    runningTotals.push(running);
  }
  const hasAnyAmount = runningTotals.length > 0 && runningTotals[runningTotals.length - 1] > 0;

  return (
    <>
      <div className="hidden sm:block border rounded-md overflow-hidden">
        <table className="w-full">
          <thead className="bg-muted/50 sticky top-0 z-30">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-center px-2 py-2 font-semibold w-8">#</th>
              <th className="text-left px-2 py-2 font-semibold">Account</th>
              <th className="text-left px-2 py-2 font-semibold w-24 hidden lg:table-cell">Type</th>
              <th className="text-right px-2 py-2 font-semibold w-[22%]">Amount</th>
              <th className="text-left px-2 py-2 font-semibold w-[24%] hidden md:table-cell">Narration</th>
              <th className="text-right px-2 py-2 font-semibold w-28 hidden lg:table-cell">Running</th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field, index) => {
              const entry = entries[index];
              const isEmpty = !entry?.accountId || entry.accountId === 0;
              const typeBadge = entry?.accountType ? ENTRY_TYPE_BADGE[entry.accountType] : null;
              return (
                <tr
                  key={field.id}
                  className={cn(
                    "border-t hover-elevate",
                    activeRow === index &&
                      (mode === "payment"
                        ? "bg-amber-50/60 dark:bg-amber-950/20 shadow-[inset_2px_0_0_#f59e0b]"
                        : "bg-emerald-50/60 dark:bg-emerald-950/20 shadow-[inset_2px_0_0_#10b981]")
                  )}
                >
                  <td className="px-2 py-1.5 text-center text-[11px] font-mono text-muted-foreground tabular-nums align-top pt-3">
                    {index + 1}
                  </td>
                  <td className="px-2 py-1.5">
                    <FormField
                      control={form.control}
                      name={`entries.${index}.accountName`}
                      render={({ field: accountField }) => (
                        <FormItem>
                          <FormControl>
                            <Input
                              {...accountField}
                              placeholder="Type to search..."
                              className="text-sm h-8"
                              data-testid={`input-account-${index}`}
                              onChange={(event) => {
                                accountField.onChange(event);
                                setSidebarSearchValue(event.target.value);
                              }}
                              onFocus={() => onRowFocus(index, "account")}
                              onKeyDown={(event) => handleAccountKeyDown(event, index)}
                              onBlur={() => setTimeout(() => onRowBlur(), 200)}
                            />
                          </FormControl>
                          {!isEmpty && typeBadge && (
                            <span
                              className={`lg:hidden inline-block text-[10px] font-medium px-1.5 py-0 rounded mt-0.5 ${typeBadge.cls}`}
                            >
                              {typeBadge.label}
                            </span>
                          )}
                          {renderBalanceLine(index)}
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </td>
                  <td className="px-2 py-1.5 align-top pt-3 hidden lg:table-cell">
                    {!isEmpty && typeBadge && (
                      <span className={`inline-block text-[10px] font-medium px-1.5 py-0 rounded ${typeBadge.cls}`}>
                        {typeBadge.label}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <FormField
                      control={form.control}
                      name={`entries.${index}.amount`}
                      render={({ field: amountField }) => (
                        <FormItem>
                          <FormControl>
                            <Input
                              {...amountField}
                              type="number"
                              step="0.01"
                              placeholder="0.00"
                              className="font-mono tabular-nums text-right h-8"
                              data-testid={`input-amount-${index}`}
                              onKeyDown={(event) => handleAmountKeyDown(event, index)}
                              onBlur={(event) => handleAmountBlur(event, index)}
                              onFocus={() => onRowFocus(index, "amount")}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </td>
                  <td className="px-2 py-1.5 hidden md:table-cell">
                    <FormField
                      control={form.control}
                      name={`entries.${index}.narration`}
                      render={({ field: narrationField }) => (
                        <FormItem>
                          <FormControl>
                            <Input
                              {...narrationField}
                              placeholder="Optional note"
                              className="text-sm h-8"
                              data-testid={`input-narration-${index}`}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </td>
                  <td className="px-2 py-1.5 align-top pt-3 text-right hidden lg:table-cell">
                    <span
                      className="text-xs font-mono tabular-nums text-muted-foreground"
                      data-testid={`text-running-${index}`}
                    >
                      {runningTotals[index] > 0 ? formatAmount(runningTotals[index]) : "—"}
                    </span>
                  </td>
                  <td className="px-1 py-1.5 align-top pt-2">
                    {fields.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => remove(index)}
                        data-testid={`button-remove-${index}`}
                      >
                        <X className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-muted/30 border-t">
            <tr>
              <td colSpan={7} className="px-2 py-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={handleAddRow}
                    data-testid="button-add-row"
                  >
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    Add Row
                  </Button>
                  <p className="text-[11px] text-muted-foreground hidden xl:block">
                    <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">Tab</kbd> next field
                    <kbd className="px-1 py-0.5 bg-muted rounded text-[10px] ml-2">↵</kbd> new row
                    <kbd className="px-1 py-0.5 bg-muted rounded text-[10px] ml-2">↑↓</kbd> move
                  </p>
                  {hasAnyAmount && (
                    <div className="text-right xl:hidden">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Subtotal</div>
                      <div className="text-sm font-semibold font-mono tabular-nums">{formatAmount(total)}</div>
                    </div>
                  )}
                </div>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="sm:hidden space-y-2">
        {fields.map((field, index) => {
          const entry = entries[index];
          const hasAccount = (entry?.accountId ?? 0) > 0;
          const typeBadge = entry?.accountType ? ENTRY_TYPE_BADGE[entry.accountType] : null;
          const amount = parseFloat(entry?.amount || "0");
          return (
            <div
              key={field.id}
              className="rounded-md border bg-card px-3 py-2.5 flex items-center gap-2 hover-elevate active-elevate-2 cursor-pointer"
              onClick={() => openMobileEdit(index)}
              data-testid={`mobile-entry-card-${index}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground shrink-0 tabular-nums">{index + 1}.</span>
                  {hasAccount ? (
                    <span className="text-sm font-medium truncate">{entry.accountName}</span>
                  ) : (
                    <span className="text-sm text-muted-foreground italic">Tap to select account</span>
                  )}
                </div>
                {hasAccount && typeBadge && (
                  <span className={`inline-block text-[10px] font-medium px-1.5 py-0 rounded mt-0.5 ${typeBadge.cls}`}>
                    {typeBadge.label}
                  </span>
                )}
                {entry?.narration && (
                  <p className="text-[10px] text-muted-foreground truncate mt-0.5 italic">{entry.narration}</p>
                )}
              </div>
              <div className="shrink-0 flex items-center gap-1.5">
                {amount > 0 && <span className="text-sm font-semibold font-mono">{formatAmount(amount)}</span>}
                {fields.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={(event) => {
                      event.stopPropagation();
                      remove(index);
                    }}
                    data-testid={`mobile-remove-entry-${index}`}
                  >
                    <X className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}

        <div
          className="rounded-md border border-dashed border-muted-foreground/30 px-3 py-3 flex items-center gap-2 text-muted-foreground cursor-pointer hover-elevate active-elevate-2"
          onClick={handleMobileAddRow}
          data-testid="mobile-add-entry-card"
        >
          <Plus className="h-4 w-4" />
          <span className="text-sm">Tap to add entry</span>
        </div>

        <div className="rounded-md border bg-muted/30 px-3 py-2 flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {fields.length} {fields.length === 1 ? "entry" : "entries"}
          </span>
          <span className="text-base font-semibold font-mono">{formatAmount(total)}</span>
        </div>
      </div>

      <Sheet
        open={mobileEditOpen}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setMobileEditOpen(false);
            setMobileSearch("");
            setSidebarSearchValue("");
          }
        }}
      >
        <SheetContent side="bottom" className="flex flex-col p-0" style={{ height: "auto", maxHeight: "88vh" }}>
          <SheetHeader className="px-4 pt-4 pb-3 border-b shrink-0">
            <div className="flex items-center justify-between gap-2">
              <SheetTitle className="text-base truncate">
                {mobileEditIndex !== null && (entries[mobileEditIndex]?.accountId ?? 0) > 0
                  ? entries[mobileEditIndex].accountName
                  : "Select Account"}
              </SheetTitle>
              <Button variant="default" size="sm" onClick={handleMobileDone} data-testid="button-mobile-entry-done">
                Done
              </Button>
            </div>
            <div className="relative mt-2">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                ref={mobileSearchInputRef}
                placeholder="Search accounts..."
                value={mobileSearch}
                onChange={(event) => {
                  setMobileSearch(event.target.value);
                  setSidebarSearchValue(event.target.value);
                }}
                className="pl-9"
                data-testid="input-mobile-account-search"
              />
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto min-h-0">
            {filteredSidebarAccounts.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {mobileSearch ? "No accounts match your search" : "No accounts available"}
              </div>
            ) : (
              filteredSidebarAccounts.slice(0, 40).map((account) => {
                const isSelected =
                  mobileEditIndex !== null &&
                  entries[mobileEditIndex]?.accountId === account.id &&
                  entries[mobileEditIndex]?.accountType === account.type;
                const balance =
                  typeof account.balance === "string" ? parseFloat(account.balance) : (account.balance ?? null);
                return (
                  <button
                    key={`${account.type}-${account.id}`}
                    type="button"
                    className={cn(
                      "w-full text-left px-4 py-3 border-b border-muted/40 flex items-center justify-between gap-3 active-elevate-2",
                      isSelected && "bg-accent"
                    )}
                    onClick={() => handleMobileAccountSelect(account)}
                    data-testid={`mobile-account-option-${account.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{account.name}</div>
                      {balance != null && (
                        <div className="text-xs text-muted-foreground font-mono mt-0.5">{formatAmount(balance)}</div>
                      )}
                    </div>
                    {isSelected && <Check className="h-4 w-4 text-primary shrink-0" />}
                  </button>
                );
              })
            )}
          </div>

          <div className="px-4 py-4 border-t shrink-0">
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground shrink-0 w-16">Amount</span>
              <Input
                ref={mobileAmountInputRef}
                type="number"
                inputMode="decimal"
                step="0.01"
                placeholder="0.00"
                value={mobileAmountStr}
                onChange={(event) => setMobileAmountStr(event.target.value)}
                className="flex-1 font-mono text-right h-12 text-lg"
                data-testid="input-mobile-entry-amount"
              />
            </div>
            <div className="flex items-center gap-3 mt-3">
              <span className="text-sm text-muted-foreground shrink-0 w-16">Narration</span>
              <Input
                value={mobileNarration}
                onChange={(event) => setMobileNarration(event.target.value)}
                placeholder="Optional note"
                className="flex-1 h-10"
                data-testid="input-mobile-entry-narration"
              />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
