// Extracted from ./JournalEntriesEditor.tsx to keep that module under the source-size cap.
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useJournalEntriesEditorState } from "./useJournalEntriesEditorState";

export function JournalEntriesEditorSection2({
  activeJournalRow,
  appendJournal,
  convertToUSD,
  filteredJournalAccounts,
  formatAmount,
  getAccountBalance,
  handleJournalAccountSelect,
  handleJournalTypeChange,
  journalAccountSearchTerm,
  journalEntries,
  journalFields,
  journalForm,
  removeJournal,
  scheduleAccountBlur,
  selectedCurrency,
  setAccountPickersNeeded,
  setActiveJournalRow,
  setJournalAccountHighlightedIndex,
  setJournalAccountSearchTerm,
  setShowAccountSidebar,
  totalCredit,
  totalDebit,
}: Pick<
  ReturnType<typeof useJournalEntriesEditorState>,
  | "activeJournalRow"
  | "appendJournal"
  | "convertToUSD"
  | "filteredJournalAccounts"
  | "formatAmount"
  | "getAccountBalance"
  | "handleJournalAccountSelect"
  | "handleJournalTypeChange"
  | "journalAccountSearchTerm"
  | "journalEntries"
  | "journalFields"
  | "journalForm"
  | "removeJournal"
  | "scheduleAccountBlur"
  | "selectedCurrency"
  | "setAccountPickersNeeded"
  | "setActiveJournalRow"
  | "setJournalAccountHighlightedIndex"
  | "setJournalAccountSearchTerm"
  | "setShowAccountSidebar"
  | "totalCredit"
  | "totalDebit"
>) {
  return (
    <div className="sm:hidden space-y-2">
      {journalFields.map((field, index) => {
        const entry = journalEntries[index];
        const currentBalance = entry?.accountId > 0 ? getAccountBalance(entry.accountType, entry.accountId) : 0;
        const entryAmount = parseFloat(entry?.amount || "0");
        const projectedBalance = entry?.type === "DR" ? currentBalance + entryAmount : currentBalance - entryAmount;
        return (
          <div
            key={field.id}
            className="border rounded-md p-3 space-y-2 bg-card"
            data-testid={`journal-entry-card-${index}`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground">Entry {index + 1}</p>
              {journalFields.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeJournal(index)}
                  data-testid={`button-journal-remove-mobile-${index}`}
                  className="-my-2 -me-2 shrink-0"
                  aria-label={`Remove entry ${index + 1}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
            <div className="flex items-start gap-2">
              <FormField
                control={journalForm.control}
                name={`entries.${index}.type`}
                render={({ field: typeField }) => (
                  <FormItem className="shrink-0">
                    <Select
                      value={typeField.value}
                      onValueChange={(value) => {
                        if (value === "DR" || value === "CR") handleJournalTypeChange(index, value);
                      }}
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
  );
}
