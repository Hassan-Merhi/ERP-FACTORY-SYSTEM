import { useEffect, useRef } from "react";
import { AlertTriangle, CheckCircle, ChevronDown, FileDown, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { useJournalFormModel } from "./useJournalFormModel";

type Model = ReturnType<typeof useJournalFormModel>;

function focusInput(selector: string, select = false, delay = 50) {
  setTimeout(() => {
    if (typeof document === "undefined") return;
    const element = document.querySelector(selector) as HTMLInputElement | null;
    element?.focus();
    if (select) element?.select();
  }, delay);
}

export function JournalEntriesEditor({ model }: { model: Model }) {
  const {
    journalForm,
    journalFields,
    journalEntries,
    appendJournal,
    removeJournal,
    getAccountBalance,
    handleJournalTypeChange,
    activeJournalRow,
    setActiveJournalRow,
    journalAccountSearchTerm,
    setJournalAccountSearchTerm,
    setJournalAccountHighlightedIndex,
    filteredJournalAccounts,
    handleJournalAccountSelect,
    setShowAccountSidebar,
    setAccountPickersNeeded,
    journalAccountHighlightedIndex,
    handleJournalKeyDown,
    selectedCurrency,
    convertToUSD,
    formatAmount,
    totalDebit,
    totalCredit,
    handleExportJournalVoucher,
    journalMutation,
  } = model;

  const pendingBlurTimeouts = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(
    () => () => {
      for (const timeout of pendingBlurTimeouts.current) clearTimeout(timeout);
      pendingBlurTimeouts.current.clear();
    },
    []
  );

  const scheduleAccountBlur = (index: number) => {
    const timeout = setTimeout(() => {
      pendingBlurTimeouts.current.delete(timeout);
      if (activeJournalRow === index) {
        setJournalAccountSearchTerm("");
        setActiveJournalRow(null);
      }
    }, 200);
    pendingBlurTimeouts.current.add(timeout);
  };

  return (
    <>
      <div className="sm:hidden space-y-2">
        {journalFields.map((field, index) => {
          const entry = journalEntries[index];
          const currentBalance = entry?.accountId > 0 ? getAccountBalance(entry.accountType, entry.accountId) : 0;
          const entryAmount = parseFloat(entry?.amount || "0");
          const projectedBalance = entry?.type === "DR" ? currentBalance + entryAmount : currentBalance - entryAmount;
          return (
            <div key={field.id} className="border rounded-md p-3 space-y-2 bg-card">
              <div className="flex items-start gap-2">
                <FormField
                  control={journalForm.control}
                  name={`entries.${index}.type`}
                  render={({ field: typeField }) => (
                    <FormItem className="shrink-0">
                      <Select
                        value={typeField.value}
                        onValueChange={(value: "DR" | "CR") => handleJournalTypeChange(index, value)}
                      >
                        <FormControl>
                          <SelectTrigger
                            className="w-16 text-center font-medium"
                            data-testid={`input-journal-type-mobile-${index}`}
                          >
                            <SelectValue placeholder="DR" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="DR">DR</SelectItem>
                          <SelectItem value="CR">CR</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
                <div className="flex-1 min-w-0">
                  <Input
                    value={activeJournalRow === index ? journalAccountSearchTerm : entry?.accountName || ""}
                    onChange={(event) => {
                      setJournalAccountSearchTerm(event.target.value);
                      setJournalAccountHighlightedIndex(0);
                    }}
                    onFocus={() => {
                      setAccountPickersNeeded(true);
                      setActiveJournalRow(index);
                      setShowAccountSidebar(true);
                      setJournalAccountSearchTerm("");
                    }}
                    onBlur={() => scheduleAccountBlur(index)}
                    placeholder="Type to search account..."
                    data-testid={`input-journal-account-mobile-${index}`}
                    className="text-sm"
                  />
                  {activeJournalRow === index && filteredJournalAccounts.length > 0 && (
                    <div className="mt-1 border rounded-md bg-popover shadow-md max-h-44 overflow-y-auto z-20 relative">
                      {filteredJournalAccounts.slice(0, 10).map((account) => (
                        <button
                          key={`${account.type}-${account.id}`}
                          type="button"
                          className="w-full text-left px-3 py-2.5 text-sm hover-elevate border-b last:border-b-0"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            handleJournalAccountSelect(account);
                            setShowAccountSidebar(false);
                          }}
                        >
                          <div className="font-medium truncate">{account.name}</div>
                        </button>
                      ))}
                    </div>
                  )}
                  {entry?.accountId > 0 && (
                    <div className="text-xs text-muted-foreground pl-1 mt-0.5">
                      New Bal:{" "}
                      <span
                        className={cn(
                          "font-mono",
                          projectedBalance >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"
                        )}
                      >
                        {formatAmount(Math.abs(projectedBalance))} {projectedBalance >= 0 ? "Dr" : "Cr"}
                      </span>
                    </div>
                  )}
                </div>
                {journalFields.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeJournal(index)}
                    data-testid={`button-journal-remove-mobile-${index}`}
                    className="shrink-0"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>

              <FormField
                control={journalForm.control}
                name={`entries.${index}.amount`}
                render={({ field: amountField }) => (
                  <FormItem>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground w-14 shrink-0">Amount</span>
                      <FormControl>
                        <Input
                          {...amountField}
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0.00"
                          className="font-mono text-right"
                          data-testid={`input-journal-amount-mobile-${index}`}
                          onBlur={(event) => {
                            const value = Number(event.target.value);
                            if (!isNaN(value) && value > 0 && selectedCurrency !== "USD") {
                              journalForm.setValue(`entries.${index}.amount`, convertToUSD(value).toFixed(2));
                            }
                          }}
                        />
                      </FormControl>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={journalForm.control}
                name={`entries.${index}.narration`}
                render={({ field: narrationField }) => (
                  <FormItem>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground w-14 shrink-0">Narration</span>
                      <FormControl>
                        <Input
                          {...narrationField}
                          value={narrationField.value ?? ""}
                          placeholder="Optional note for this entry"
                          className="text-sm"
                          data-testid={`input-journal-narration-mobile-${index}`}
                        />
                      </FormControl>
                    </div>
                  </FormItem>
                )}
              />
            </div>
          );
        })}

        <div className="flex items-center justify-between pt-1 px-0.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              appendJournal({
                type: "DR",
                accountType: "ledger",
                accountId: 0,
                accountName: "",
                amount: "",
                narration: "",
              })
            }
            data-testid="button-journal-add-row-mobile"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Row
          </Button>
          <div className="text-right text-xs space-y-0.5">
            <div className="text-muted-foreground">
              DR: {formatAmount(totalDebit)} | CR: {formatAmount(totalCredit)}
            </div>
          </div>
        </div>
        {Math.abs(totalDebit - totalCredit) > 0.01 && (
          <div className="text-center text-sm text-destructive p-2 bg-destructive/10 rounded-md">
            DR/CR mismatch: {formatAmount(Math.abs(totalDebit - totalCredit))}
          </div>
        )}
      </div>

      <div className="hidden sm:block border rounded-xl overflow-hidden overflow-x-auto">
        <table className="w-full min-w-[500px]">
          <thead className="bg-muted/40">
            <tr className="h-9">
              <th className="text-left px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide w-[10%]">
                DR/CR
              </th>
              <th className="text-left px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide w-[35%]">
                Account
              </th>
              <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide w-[20%]">
                Amount
              </th>
              <th className="text-left px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide w-[28%]">
                Narration
              </th>
              <th className="w-[7%]"></th>
            </tr>
          </thead>
          <tbody>
            {journalFields.map((field, index) => {
              const entry = journalEntries[index];
              const currentBalance = entry?.accountId > 0 ? getAccountBalance(entry.accountType, entry.accountId) : 0;
              const entryAmount = parseFloat(entry?.amount || "0");
              const displayBalance = entry?.type === "DR" ? currentBalance + entryAmount : currentBalance - entryAmount;
              return (
                <tr key={field.id} className="border-t hover:bg-muted/20 transition-colors">
                  <td className="p-2">
                    <FormField
                      control={journalForm.control}
                      name={`entries.${index}.type`}
                      render={({ field: typeField }) => (
                        <FormItem>
                          <Select
                            value={typeField.value}
                            onValueChange={(value: "DR" | "CR") => handleJournalTypeChange(index, value)}
                          >
                            <FormControl>
                              <SelectTrigger
                                className={cn(
                                  "w-20 text-center font-semibold border",
                                  typeField.value === "DR"
                                    ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800"
                                    : "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800"
                                )}
                                data-testid={`input-journal-type-${index}`}
                                onKeyDown={(event) => {
                                  if ((event.key === "Tab" && !event.shiftKey) || event.key === "ArrowRight") {
                                    event.preventDefault();
                                    focusInput(`[data-testid="input-journal-account-${index}"]`);
                                  } else if (event.key === "ArrowLeft") {
                                    event.preventDefault();
                                    focusInput(`[data-testid="input-journal-amount-${index}"]`, true);
                                  } else if (event.key === "ArrowUp" && index > 0) {
                                    event.preventDefault();
                                    focusInput(`[data-testid="input-journal-type-${index - 1}"]`);
                                  } else if (event.key === "ArrowDown" && index < journalFields.length - 1) {
                                    event.preventDefault();
                                    focusInput(`[data-testid="input-journal-type-${index + 1}"]`);
                                  }
                                }}
                              >
                                <SelectValue placeholder="DR" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="DR">DR</SelectItem>
                              <SelectItem value="CR">CR</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </td>

                  <td className="p-2">
                    <FormField
                      control={journalForm.control}
                      name={`entries.${index}.accountId`}
                      render={() => (
                        <FormItem>
                          <FormControl>
                            <div className="space-y-1">
                              <Input
                                value={activeJournalRow === index ? journalAccountSearchTerm : entry?.accountName || ""}
                                onChange={(event) => {
                                  setJournalAccountSearchTerm(event.target.value);
                                  setJournalAccountHighlightedIndex(0);
                                }}
                                onFocus={() => {
                                  setAccountPickersNeeded(true);
                                  setActiveJournalRow(index);
                                  setShowAccountSidebar(true);
                                  setJournalAccountSearchTerm("");
                                }}
                                onBlur={() => scheduleAccountBlur(index)}
                                placeholder="Type to search..."
                                data-testid={`input-journal-account-${index}`}
                                onKeyDown={(event) => {
                                  if (model.showAccountSidebar) {
                                    if (event.key === "ArrowUp") {
                                      event.preventDefault();
                                      setJournalAccountHighlightedIndex((previous) =>
                                        previous > 0 ? previous - 1 : Math.max(0, filteredJournalAccounts.length - 1)
                                      );
                                      return;
                                    }
                                    if (event.key === "ArrowDown") {
                                      event.preventDefault();
                                      setJournalAccountHighlightedIndex((previous) =>
                                        previous < filteredJournalAccounts.length - 1 ? previous + 1 : 0
                                      );
                                      return;
                                    }
                                    if (event.key === "Enter") {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      const selected = filteredJournalAccounts[journalAccountHighlightedIndex];
                                      if (selected) {
                                        handleJournalAccountSelect(selected);
                                        setShowAccountSidebar(false);
                                      }
                                      return;
                                    }
                                  }
                                  if (event.key === "Tab" && !event.shiftKey) {
                                    event.preventDefault();
                                    focusInput(`[data-testid="input-journal-amount-${index}"]`, true);
                                  } else if (event.key === "ArrowUp" && index > 0) {
                                    event.preventDefault();
                                    focusInput(`[data-testid="input-journal-account-${index - 1}"]`);
                                  } else if (event.key === "ArrowDown" && index < journalFields.length - 1) {
                                    event.preventDefault();
                                    focusInput(`[data-testid="input-journal-account-${index + 1}"]`);
                                  } else if (event.key === "ArrowRight") {
                                    event.preventDefault();
                                    focusInput(`[data-testid="input-journal-amount-${index}"]`, true);
                                  } else if (event.key === "ArrowLeft") {
                                    event.preventDefault();
                                    focusInput(`[data-testid="input-journal-type-${index}"]`);
                                  }
                                }}
                              />
                              {entry?.accountId > 0 && (
                                <div className="text-xs text-muted-foreground pl-1">
                                  New Bal:{" "}
                                  <span
                                    className={cn(
                                      "font-mono",
                                      displayBalance >= 0
                                        ? "text-emerald-600 dark:text-emerald-400"
                                        : "text-red-600 dark:text-red-400"
                                    )}
                                  >
                                    {formatAmount(Math.abs(displayBalance))} {displayBalance >= 0 ? "Dr" : "Cr"}
                                  </span>
                                </div>
                              )}
                            </div>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </td>

                  <td className="p-2">
                    <FormField
                      control={journalForm.control}
                      name={`entries.${index}.amount`}
                      render={({ field: amountField }) => (
                        <FormItem>
                          <FormControl>
                            <Input
                              {...amountField}
                              type="number"
                              step="0.01"
                              min="0"
                              placeholder="0.00"
                              className="font-mono text-right"
                              data-testid={`input-journal-amount-${index}`}
                              onKeyDown={(event) => handleJournalKeyDown(event, index, "amount")}
                              onBlur={(event) => {
                                const value = Number(event.target.value);
                                if (!isNaN(value) && value > 0 && selectedCurrency !== "USD") {
                                  journalForm.setValue(`entries.${index}.amount`, convertToUSD(value).toFixed(2));
                                }
                              }}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </td>

                  <td className="p-2">
                    <FormField
                      control={journalForm.control}
                      name={`entries.${index}.narration`}
                      render={({ field: narrationField }) => (
                        <FormItem>
                          <FormControl>
                            <Input
                              {...narrationField}
                              value={narrationField.value ?? ""}
                              placeholder="Optional note…"
                              className="text-sm h-8"
                              data-testid={`input-journal-narration-${index}`}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </td>
                  <td className="p-2">
                    {journalFields.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeJournal(index)}
                        data-testid={`button-journal-remove-${index}`}
                      >
                        <X className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-muted/40 border-t">
            <tr>
              <td colSpan={5} className="px-3 py-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    appendJournal({
                      type: "DR",
                      accountType: "ledger",
                      accountId: 0,
                      accountName: "",
                      amount: "",
                      narration: "",
                    })
                  }
                  data-testid="button-journal-add-row"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Row
                </Button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="rounded-lg border bg-muted/40 px-4 py-2 flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Total Debit</span>
          <span className="text-sm font-semibold font-mono text-emerald-600 dark:text-emerald-400">
            {formatAmount(totalDebit)}
          </span>
        </div>
        <div className="rounded-lg border bg-muted/40 px-4 py-2 flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Total Credit</span>
          <span className="text-sm font-semibold font-mono text-red-600 dark:text-red-400">
            {formatAmount(totalCredit)}
          </span>
        </div>
        <div
          className={cn(
            "rounded-lg border px-4 py-2 flex items-center gap-2",
            Math.abs(totalDebit - totalCredit) <= 0.01
              ? "bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800"
              : "bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800"
          )}
        >
          {Math.abs(totalDebit - totalCredit) <= 0.01 ? (
            <>
              <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">Balanced</span>
            </>
          ) : (
            <>
              <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0" />
              <span className="text-sm font-medium text-red-700 dark:text-red-300">
                Off by {formatAmount(Math.abs(totalDebit - totalCredit))}
              </span>
            </>
          )}
        </div>
      </div>

      <FormField
        control={journalForm.control}
        name="notes"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Notes</FormLabel>
            <FormControl>
              <Textarea {...field} placeholder="Additional notes..." rows={3} data-testid="input-journal-notes" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <FormField
          control={journalForm.control}
          name="optional"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center gap-2.5 space-y-0">
              <FormControl>
                <Checkbox
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  data-testid="checkbox-journal-optional"
                />
              </FormControl>
              <FormLabel className="text-sm font-normal cursor-pointer">Mark as Optional</FormLabel>
            </FormItem>
          )}
        />
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                disabled={
                  journalEntries.filter((entry) => entry.accountId > 0 && parseFloat(entry.amount) > 0).length === 0
                }
                data-testid="button-export-journal-voucher"
              >
                <FileDown className="h-4 w-4 mr-2" />
                Export
                <ChevronDown className="h-4 w-4 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleExportJournalVoucher(false)} data-testid="export-journal-summary">
                Summary Export
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExportJournalVoucher(true)} data-testid="export-journal-detailed">
                Detailed Export
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="submit"
            disabled={journalMutation.isPending || Math.abs(totalDebit - totalCredit) > 0.01}
            data-testid="button-save-journal-voucher"
          >
            {journalMutation.isPending ? "Saving..." : "Save Journal Voucher"}
          </Button>
        </div>
      </div>
    </>
  );
}
