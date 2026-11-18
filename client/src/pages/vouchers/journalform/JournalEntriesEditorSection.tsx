// Extracted from ./JournalEntriesEditor.tsx to keep that module under the source-size cap.
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { focusInput, useJournalEntriesEditorState } from "./useJournalEntriesEditorState";

export function JournalEntriesEditorSection({
  activeJournalRow,
  appendJournal,
  convertToUSD,
  filteredJournalAccounts,
  formatAmount,
  getAccountBalance,
  handleJournalAccountSelect,
  handleJournalKeyDown,
  handleJournalTypeChange,
  journalAccountHighlightedIndex,
  journalAccountSearchTerm,
  journalEntries,
  journalFields,
  journalForm,
  model,
  removeJournal,
  scheduleAccountBlur,
  selectedCurrency,
  setAccountPickersNeeded,
  setActiveJournalRow,
  setJournalAccountHighlightedIndex,
  setJournalAccountSearchTerm,
  setShowAccountSidebar,
}: Pick<
  ReturnType<typeof useJournalEntriesEditorState>,
  | "activeJournalRow"
  | "appendJournal"
  | "convertToUSD"
  | "filteredJournalAccounts"
  | "formatAmount"
  | "getAccountBalance"
  | "handleJournalAccountSelect"
  | "handleJournalKeyDown"
  | "handleJournalTypeChange"
  | "journalAccountHighlightedIndex"
  | "journalAccountSearchTerm"
  | "journalEntries"
  | "journalFields"
  | "journalForm"
  | "model"
  | "removeJournal"
  | "scheduleAccountBlur"
  | "selectedCurrency"
  | "setAccountPickersNeeded"
  | "setActiveJournalRow"
  | "setJournalAccountHighlightedIndex"
  | "setJournalAccountSearchTerm"
  | "setShowAccountSidebar"
>) {
  return (
    <div className="voucher-journal-table hidden sm:block border rounded-xl overflow-hidden overflow-x-auto">
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
                          onValueChange={(value) => {
                            if (value === "DR" || value === "CR") handleJournalTypeChange(index, value);
                          }}
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
  );
}
