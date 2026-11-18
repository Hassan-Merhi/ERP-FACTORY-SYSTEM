import { AlertTriangle, CheckCircle, ChevronDown, FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { VoucherActionBar, VoucherOptionalSwitch } from "../VoucherActionBar";
import { useJournalEntriesEditorState, type Model } from "./useJournalEntriesEditorState";
import { JournalEntriesEditorSection } from "./JournalEntriesEditorSection";
import { JournalEntriesEditorSection2 } from "./JournalEntriesEditorSection2";

export function JournalEntriesEditor(props: { model: Model }) {
  const {
    activeJournalRow,
    appendJournal,
    convertToUSD,
    filteredJournalAccounts,
    formatAmount,
    getAccountBalance,
    handleExportJournalVoucher,
    handleJournalAccountSelect,
    handleJournalKeyDown,
    handleJournalTypeChange,
    isBalanced,
    journalAccountHighlightedIndex,
    journalAccountSearchTerm,
    journalEntries,
    journalFields,
    journalForm,
    journalMutation,
    model,
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
    voucherIdToEdit,
  } = useJournalEntriesEditorState(props);

  return (
    <>
      <JournalEntriesEditorSection2
        activeJournalRow={activeJournalRow}
        appendJournal={appendJournal}
        convertToUSD={convertToUSD}
        filteredJournalAccounts={filteredJournalAccounts}
        formatAmount={formatAmount}
        getAccountBalance={getAccountBalance}
        handleJournalAccountSelect={handleJournalAccountSelect}
        handleJournalTypeChange={handleJournalTypeChange}
        journalAccountSearchTerm={journalAccountSearchTerm}
        journalEntries={journalEntries}
        journalFields={journalFields}
        journalForm={journalForm}
        removeJournal={removeJournal}
        scheduleAccountBlur={scheduleAccountBlur}
        selectedCurrency={selectedCurrency}
        setAccountPickersNeeded={setAccountPickersNeeded}
        setActiveJournalRow={setActiveJournalRow}
        setJournalAccountHighlightedIndex={setJournalAccountHighlightedIndex}
        setJournalAccountSearchTerm={setJournalAccountSearchTerm}
        setShowAccountSidebar={setShowAccountSidebar}
        totalCredit={totalCredit}
        totalDebit={totalDebit}
      />

      <JournalEntriesEditorSection
        activeJournalRow={activeJournalRow}
        appendJournal={appendJournal}
        convertToUSD={convertToUSD}
        filteredJournalAccounts={filteredJournalAccounts}
        formatAmount={formatAmount}
        getAccountBalance={getAccountBalance}
        handleJournalAccountSelect={handleJournalAccountSelect}
        handleJournalKeyDown={handleJournalKeyDown}
        handleJournalTypeChange={handleJournalTypeChange}
        journalAccountHighlightedIndex={journalAccountHighlightedIndex}
        journalAccountSearchTerm={journalAccountSearchTerm}
        journalEntries={journalEntries}
        journalFields={journalFields}
        journalForm={journalForm}
        model={model}
        removeJournal={removeJournal}
        scheduleAccountBlur={scheduleAccountBlur}
        selectedCurrency={selectedCurrency}
        setAccountPickersNeeded={setAccountPickersNeeded}
        setActiveJournalRow={setActiveJournalRow}
        setJournalAccountHighlightedIndex={setJournalAccountHighlightedIndex}
        setJournalAccountSearchTerm={setJournalAccountSearchTerm}
        setShowAccountSidebar={setShowAccountSidebar}
      />

      <div className="voucher-journal-summary flex flex-wrap gap-3">
        <div className="rounded-lg border bg-muted/40 px-4 py-2 flex flex-col gap-0.5">
          <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Total Debit</span>
          <span className="text-sm font-semibold font-mono text-emerald-600 dark:text-emerald-400">
            {formatAmount(totalDebit)}
          </span>
        </div>
        <div className="rounded-lg border bg-muted/40 px-4 py-2 flex flex-col gap-0.5">
          <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Total Credit</span>
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

      <VoucherActionBar
        isEditing={!!voucherIdToEdit}
        saving={journalMutation.isPending}
        disabled={Math.abs(totalDebit - totalCredit) > 0.01}
        saveTestId="button-save-journal-voucher"
        data-testid="journal-actions"
        phoneSummary={`Dr ${formatAmount(totalDebit)} · Cr ${formatAmount(totalCredit)}`}
        // The totals and balance state are already shown above the notes; phones repeat them in the bar.
        phoneStatus={{
          ok: isBalanced,
          label: isBalanced ? "Balanced" : `Off by ${formatAmount(Math.abs(totalDebit - totalCredit))}`,
        }}
        optional={
          <FormField
            control={journalForm.control}
            name="optional"
            render={({ field }) => (
              <VoucherOptionalSwitch
                checked={field.value}
                onCheckedChange={field.onChange}
                data-testid="checkbox-journal-optional"
              />
            )}
          />
        }
        secondary={
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
        }
      />
    </>
  );
}
