// Extracted from ./JournalFilters.tsx
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import type { TransactionJournalModel } from "../useTransactionJournalModel";

/** Phone quick search; rendered only inside the phone filter row. */
export function JournalPhoneSearch({ model }: { model: TransactionJournalModel }) {
  const { t } = useApplicationLanguage();
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <SearchField
        id="search-tj"
        wrapperClassName="flex-1"
        value={model.searchInput}
        onValueChange={model.setSearchInput}
        onKeyDown={(e) => e.key === "Enter" && model.handleSearch()}
        placeholder="Voucher # or narration…"
        aria-label={t("mobileFilters.search")}
        enterKeyHint="search"
        showClear={false}
        className="h-9 rounded-lg border-slate-200 bg-white/85 shadow-sm dark:border-white/15 dark:bg-white/[0.04]"
        data-testid="input-search"
      />
      <Button
        variant="default"
        size="icon"
        className="shrink-0 rounded-lg bg-violet-600 text-white hover:bg-violet-700"
        onClick={model.handleSearch}
        aria-label={t("mobileFilters.search")}
        data-testid="button-search"
      >
        <Search className="h-4 w-4" />
      </Button>
      {model.search && (
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={model.clearSearch}
          aria-label={t("mobileFilters.clearSearch")}
          data-testid="button-clear-search"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
