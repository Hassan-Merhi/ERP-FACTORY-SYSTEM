/**
 * All Daybook (TransactionJournal) page shell.
 *
 * Keeps its route and default export; the filter state, cross-company query,
 * pagination and detail lookups live in ./transactionjournal —
 * useTransactionJournalModel — and the views under
 * ./transactionjournal/components render it.
 */
import { FileText, RefreshCw } from "lucide-react";
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
    <div className="flex flex-col gap-4">
      {/* ── Page header ── */}
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            All Daybook
            {model.isFetching && (
              <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin" data-testid="icon-refreshing" />
            )}
          </span>
        }
        subtitle="All vouchers across all companies — filtered and searchable"
        icon={<FileText className="h-5 w-5" />}
      >
        <Button
          variant="outline"
          size="default"
          onClick={() => model.refetch()}
          disabled={model.isFetching}
          data-testid="button-refresh-journal"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${model.isFetching ? "animate-spin" : ""}`} />
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
