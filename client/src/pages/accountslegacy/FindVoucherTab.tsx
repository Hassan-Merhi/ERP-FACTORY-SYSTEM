/**
 * "Find Voucher" tab of the Accounts Overview page: a debounced voucher search
 * with its three empty/loading/no-result states and the result list.
 *
 * Split out of AccountsLegacy.tsx unchanged — results still navigate to the
 * Vouchers page on the tab that voucherTypeToTab resolves.
 */
import { FileText, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { voucherTypeToTab } from "./utils";
import type { AccountsLegacyModel } from "./useAccountsLegacyModel";

export function FindVoucherTab({ model }: { model: AccountsLegacyModel }) {
  const { debouncedFindQuery, voucherSearchLoading, voucherSearchResults } = model;

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by voucher number, description, or amount (e.g. REC-001, duties, 3967)"
          value={model.findQuery}
          onChange={(e) => model.setFindQuery(e.target.value)}
          className="pl-9"
          data-testid="input-find-voucher"
          autoFocus
        />
      </div>

      {!debouncedFindQuery.trim() ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <FileText className="w-10 h-10 mb-3 opacity-30" />
          <p className="font-medium text-sm">Find any voucher</p>
          <p className="text-xs mt-1">Type a voucher number, description, or amount above</p>
        </div>
      ) : voucherSearchLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">Searching…</div>
      ) : voucherSearchResults.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <FileText className="w-10 h-10 mb-3 opacity-30" />
          <p className="font-medium text-sm">No vouchers found</p>
          <p className="text-xs mt-1">Try a different number, description, or amount</p>
        </div>
      ) : (
        <div className="rounded-md border overflow-hidden divide-y">
          {voucherSearchResults.map((v) => (
            <button
              key={v.id}
              data-testid={`button-voucher-result-${v.id}`}
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
              onClick={() =>
                model.navigate(`${model.modePrefix}/vouchers?edit=${v.id}&tab=${voucherTypeToTab(v.voucherType || "")}`)
              }
            >
              <FileText className="w-4 h-4 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-[11px]">
                    {v.voucherType}
                  </Badge>
                  {v.locationName && <span className="text-xs text-muted-foreground">{v.locationName}</span>}
                </div>
                {v.description && <p className="text-xs text-muted-foreground truncate mt-0.5">{v.description}</p>}
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm font-medium">
                  {model.formatAmount(parseFloat(v.totalAmount || "0"))}
                  {v.currency && v.currency !== "USD" && (
                    <span className="text-xs text-muted-foreground ml-1">{v.currency}</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {model.formatDisplayDate(v.effectiveDate || v.voucherDate)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
