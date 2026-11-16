/**
 * All Daybook (Transaction Journal) presentation.
 * All data, filters, voucher actions and pagination continue to be owned by
 * useTransactionJournalModel; these styles are theme-aware.
 */
import { Layers3, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { useTransactionJournalModel } from "./transactionjournal/useTransactionJournalModel";
import { JournalFilters } from "./transactionjournal/components/JournalFilters";
import { JournalSummaryCards, JournalTypeChips } from "./transactionjournal/components/JournalOverview";
import { JournalVoucherList } from "./transactionjournal/components/JournalVoucherList";
import { JournalDetailDialog } from "./transactionjournal/components/JournalDetailDialog";

export default function TransactionJournal() {
  const model = useTransactionJournalModel();

  return (
    <div className="flex min-w-0 flex-col gap-4 pb-6" data-testid="transaction-journal-page">
      <PageHeader
        title={
          <>
            <span className="sr-only">All Daybook — </span>Transaction Journal
          </>
        }
        subtitle="All transactions across companies, vouchers, and operations"
        icon={<Layers3 className="h-5 w-5" aria-hidden="true" />}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => model.refetch()}
          disabled={model.isFetching}
          className="h-9 gap-2 rounded-xl border-violet-200/80 bg-white/75 shadow-sm hover:bg-violet-50 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10"
          data-testid="button-refresh-journal"
        >
          <RefreshCw
            className={`h-4 w-4 ${model.isFetching ? "animate-spin" : ""}`}
            data-testid={model.isFetching ? "icon-refreshing" : undefined}
          />
          Refresh
        </Button>
      </PageHeader>

      <JournalFilters model={model} />
      <JournalTypeChips model={model} />
      <JournalSummaryCards model={model} />
      <JournalVoucherList model={model} />
      <JournalDetailDialog model={model} />
    </div>
  );
}
