/**
 * "Find Voucher" tab of the Accounts Overview page: a debounced voucher search
 * with its three empty/loading/no-result states and the result list.
 *
 * Split out of AccountsLegacy.tsx unchanged — results still navigate to the
 * Vouchers page on the tab that voucherTypeToTab resolves.
 */
import { ChevronRight, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SearchField } from "@/components/ui/search-field";
import { voucherTypeToTab } from "./utils";
import type { AccountsLegacyModel } from "./useAccountsLegacyModel";

export function FindVoucherTab({ model }: { model: AccountsLegacyModel }) {
  const { debouncedFindQuery, voucherSearchLoading, voucherSearchResults } = model;

  return (
    <div className="space-y-5">
      <SearchField
        placeholder="Search by voucher number, description, or amount (e.g. REC-001, duties, 3967)"
        value={model.findQuery}
        onValueChange={model.setFindQuery}
        data-testid="input-find-voucher"
        wrapperClassName="rounded-2xl shadow-sm"
        className="h-14 rounded-2xl border-slate-200 bg-white/90 ps-11 pe-12 text-sm shadow-sm transition-colors focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/30 sm:h-14 dark:border-slate-700/80 dark:bg-[#111e31] dark:focus-visible:border-blue-500"
        clearOnEscape
        autoFocus
      />

      {!debouncedFindQuery.trim() ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-5 py-20 text-center text-muted-foreground dark:border-slate-700/70 dark:bg-[#101b2b]/70">
          <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300"><FileText className="h-6 w-6" aria-hidden="true" /></span>
          <p className="text-sm font-semibold text-foreground">Find any voucher</p>
          <p className="mt-1 text-xs">Type a voucher number, description, or amount above</p>
        </div>
      ) : voucherSearchLoading ? (
        <div className="flex items-center justify-center rounded-2xl border border-slate-200 bg-slate-50/70 py-16 text-sm text-muted-foreground dark:border-slate-700/70 dark:bg-[#101b2b]/70" role="status">Searching…</div>
      ) : voucherSearchResults.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-5 py-20 text-center text-muted-foreground dark:border-slate-700/70 dark:bg-[#101b2b]/70">
          <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300"><FileText className="h-6 w-6" aria-hidden="true" /></span>
          <p className="text-sm font-semibold text-foreground">No vouchers found</p>
          <p className="mt-1 text-xs">Try a different number, description, or amount</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white/90 shadow-sm divide-y divide-slate-100 dark:divide-slate-700/60 dark:border-slate-700/80 dark:bg-[#111e31]/95" aria-label="Voucher search results">
          {voucherSearchResults.map((v) => (
            <button
              key={v.id}
              type="button"
              data-testid={`button-voucher-result-${v.id}`}
              className="group flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-blue-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 sm:gap-4 sm:px-5 dark:hover:bg-blue-500/10"
              onClick={() =>
                model.navigate(`${model.modePrefix}/vouchers?edit=${v.id}&tab=${voucherTypeToTab(v.voucherType || "")}`)
              }
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-blue-100 bg-blue-50 text-blue-600 dark:border-blue-400/15 dark:bg-blue-500/15 dark:text-blue-200"><FileText className="h-5 w-5" aria-hidden="true" /></span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="rounded-lg border-blue-200 bg-blue-50/70 px-2 py-0.5 text-[11px] font-semibold text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-200">
                    {v.voucherType}
                  </Badge>
                  {v.locationName && <span className="text-xs text-muted-foreground">{v.locationName}</span>}
                </div>
                {v.description && <p className="mt-1 truncate text-sm font-medium text-slate-700 dark:text-slate-200">{v.description}</p>}
              </div>
              <div className="ml-auto shrink-0 border-l border-slate-200 pl-3 text-right sm:min-w-36 sm:pl-5 dark:border-slate-700">
                <div className="text-base font-bold tabular-nums text-foreground">
                  {model.formatAmount(parseFloat(v.totalAmount || "0"))}
                  {v.currency && v.currency !== "USD" && (
                    <span className="text-xs text-muted-foreground ml-1">{v.currency}</span>
                  )}
                </div>
                <div className="mt-1 text-xs tabular-nums text-muted-foreground">
                  {model.formatDisplayDate(v.effectiveDate || v.voucherDate)}
                </div>
              </div>
              <ChevronRight className="hidden h-4 w-4 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-blue-500 sm:block" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
