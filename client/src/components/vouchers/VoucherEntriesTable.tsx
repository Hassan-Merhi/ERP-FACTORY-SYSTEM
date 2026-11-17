import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Plus, X, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { ENTRY_TYPE_BADGE, type VoucherEntriesTableProps } from "./VoucherEntriesTableTypes";
import { useVoucherEntriesTableState } from "./useVoucherEntriesTableState";
import { VoucherEntriesTableSection } from "./VoucherEntriesTableSection";
import { SearchField } from "@/components/ui/search-field";
export type { VoucherEntry } from "./VoucherEntriesTableTypes";

export function VoucherEntriesTable(props: VoucherEntriesTableProps) {
  const {
    activeRow,
    amountCurrencyOverride,
    entries,
    fields,
    filteredSidebarAccounts,
    form,
    formatAmount,
    formatEntryAmount,
    handleAccountKeyDown,
    handleAddRow,
    handleAmountBlur,
    handleAmountKeyDown,
    handleMobileAccountSelect,
    handleMobileAddRow,
    handleMobileDone,
    hasAnyAmount,
    mobileAmountInputRef,
    mobileAmountStr,
    mobileEditIndex,
    mobileEditOpen,
    mobileNarration,
    mobileSearch,
    mobileSearchInputRef,
    mode,
    onRowBlur,
    onRowFocus,
    openMobileEdit,
    remove,
    renderBalanceLine,
    runningTotals,
    setMobileAmountStr,
    setMobileEditOpen,
    setMobileNarration,
    setMobileSearch,
    setSidebarSearchValue,
    total,
  } = useVoucherEntriesTableState(props);

  return (
    <>
      {/* Scrolls sideways below ~22rem rather than squeezing the inputs to a few characters. */}
      <VoucherEntriesTableSection
        activeRow={activeRow}
        amountCurrencyOverride={amountCurrencyOverride}
        entries={entries}
        fields={fields}
        form={form}
        formatEntryAmount={formatEntryAmount}
        handleAccountKeyDown={handleAccountKeyDown}
        handleAddRow={handleAddRow}
        handleAmountBlur={handleAmountBlur}
        handleAmountKeyDown={handleAmountKeyDown}
        hasAnyAmount={hasAnyAmount}
        mode={mode}
        onRowBlur={onRowBlur}
        onRowFocus={onRowFocus}
        remove={remove}
        renderBalanceLine={renderBalanceLine}
        runningTotals={runningTotals}
        setSidebarSearchValue={setSidebarSearchValue}
        total={total}
      />

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
                  <span
                    className={`inline-block text-[11px] font-medium px-1.5 py-0 rounded-sm mt-0.5 ${typeBadge.cls}`}
                  >
                    {typeBadge.label}
                  </span>
                )}
                {entry?.narration && (
                  <p className="text-[11px] text-muted-foreground truncate mt-0.5 italic">{entry.narration}</p>
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
        <SheetContent
          side="bottom"
          className="flex flex-col p-0"
          // Capped to the visible viewport, so the Amount field stays above the phone keyboard.
          style={{ height: "auto", maxHeight: "min(88vh, calc(var(--erp-visual-viewport-height, 100dvh) - 1rem))" }}
        >
          {/* pe-14 keeps Done clear of the sheet's close control. */}
          <SheetHeader className="px-4 pe-14 pt-4 pb-3 border-b shrink-0">
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
            <SearchField
              ref={mobileSearchInputRef}
              value={mobileSearch}
              onValueChange={(value) => {
                setMobileSearch(value);
                setSidebarSearchValue(value);
              }}
              placeholder="Search accounts..."
              wrapperClassName="mt-2"
              data-testid="input-mobile-account-search"
            />
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
