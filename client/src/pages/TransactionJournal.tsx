/**
 * All Daybook (Transaction Journal) presentation.
 * All data, filters, voucher actions and pagination continue to be owned by
 * useTransactionJournalModel; these styles are theme-aware.
 */
import { Layers3, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTransactionJournalModel } from "./transactionjournal/useTransactionJournalModel";
import { JournalFilters } from "./transactionjournal/components/JournalFilters";
import { JournalSummaryCards, JournalTypeChips } from "./transactionjournal/components/JournalOverview";
import { JournalVoucherList } from "./transactionjournal/components/JournalVoucherList";
import { JournalDetailDialog } from "./transactionjournal/components/JournalDetailDialog";

export default function TransactionJournal() {
  const model = useTransactionJournalModel();

  return (
    <div className="flex min-w-0 flex-col gap-4 pb-6" data-testid="transaction-journal-page">
      <header className="relative isolate overflow-hidden rounded-2xl border border-violet-200/70 bg-gradient-to-r from-white via-violet-50/60 to-fuchsia-50/40 px-4 py-4 shadow-sm dark:border-violet-500/20 dark:from-slate-950 dark:via-[#1c153c] dark:to-[#25113a] sm:px-5 sm:py-5">
        <div aria-hidden="true" className="pointer-events-none absolute -right-14 -top-28 h-64 w-72 rounded-full bg-violet-400/20 blur-3xl dark:bg-fuchsia-500/20" />
        <div aria-hidden="true" className="pointer-events-none absolute right-12 bottom-0 h-px w-1/2 bg-gradient-to-r from-transparent via-fuchsia-400/60 to-transparent" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white shadow-lg shadow-violet-500/20 sm:h-12 sm:w-12">
              <Layers3 className="h-6 w-6" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-[0.17em] text-violet-700 dark:text-violet-300">All Daybook</div>
              <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-2xl"><span className="sr-only">All Daybook — </span>Transaction Journal</h1>
              <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300 sm:text-sm">
                All transactions across companies, vouchers, and operations
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => model.refetch()} disabled={model.isFetching}
            className="h-9 gap-2 rounded-xl border-violet-200/80 bg-white/75 shadow-sm hover:bg-violet-50 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10"
            data-testid="button-refresh-journal">
            <RefreshCw className={`h-4 w-4 ${model.isFetching ? "animate-spin" : ""}`} data-testid={model.isFetching ? "icon-refreshing" : undefined} />
            Refresh
          </Button>
        </div>
      </header>

      <JournalFilters model={model} />
      <JournalTypeChips model={model} />
      <JournalSummaryCards model={model} />
      <JournalVoucherList model={model} />
      <JournalDetailDialog model={model} />
    </div>
  );
}
