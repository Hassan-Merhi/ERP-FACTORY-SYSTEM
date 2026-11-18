// Extracted from ./StockAdjustmentConfirmCard.tsx
import { useLocation } from "wouter";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VoucherSearchResult } from "./chatWidgetTypes";
import { formatUsd } from "@/lib/moneyDisplay";

// ── Voucher Search Results Card ──────────────────────────────────────
const VOUCHER_TYPE_TAB: Record<string, string> = {
  Payment: "payment",
  Receipt: "receipt",
  Journal: "journal",
  "Stock Transfer": "transfer",
  Production: "adjustment",
  Consumption: "adjustment",
  Mixed: "adjustment",
  "Credit Note": "creditnote",
};

export function VoucherSearchResultsCard({
  results,
  onDismiss,
}: {
  results: VoucherSearchResult[];
  onDismiss: () => void;
}) {
  const [, setLocation] = useLocation();
  return (
    <div
      className="mt-2 rounded-md border border-blue-500/30 bg-blue-500/5 overflow-hidden"
      data-testid="voucher-search-results-card"
    >
      <div className="px-3 py-2 bg-blue-500/10 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
          <span className="text-sm font-semibold text-blue-700 dark:text-blue-400">
            {results.length} Voucher{results.length !== 1 ? "s" : ""} Found
          </span>
        </div>
        <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onDismiss}>
          <X className="h-3 w-3" />
        </Button>
      </div>
      <div className="divide-y">
        {results.map((v) => {
          const tab = VOUCHER_TYPE_TAB[v.voucherType] ?? "payment";
          const amount = formatUsd(parseFloat(v.totalAmount), 2);
          return (
            <div key={v.id} className="px-3 py-2 flex items-start justify-between gap-2 hover-elevate">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-semibold text-foreground">{v.voucherNumber}</span>
                  <span className="text-[11px] text-muted-foreground bg-muted rounded-sm px-1 py-0.5">
                    {v.voucherType}
                  </span>
                  {v.optional && (
                    <span className="text-[11px] text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-sm px-1 py-0.5">
                      Optional
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{v.description || "—"}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[11px] text-muted-foreground">{v.voucherDate}</span>
                  <span className="text-[11px] font-medium text-foreground">{amount}</span>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 text-xs h-7 px-2"
                onClick={() => setLocation(`/vouchers?tab=${tab}`)}
                data-testid={`button-view-voucher-${v.id}`}
              >
                View
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
