/**
 * The two summary strips above the All Daybook table: the voucher-type quick
 * filter chips and the per-company summary cards.
 *
 * Split out of TransactionJournal.tsx unchanged — the chips still set the
 * voucher type without resetting the page (matching the original inline
 * handler), and clicking a summary card still toggles that company in the
 * company filter.
 */
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { companyColor } from "../utils";
import type { TransactionJournalModel } from "../useTransactionJournalModel";

const TYPE_CHIPS = [
  { label: "All", value: "all" },
  { label: "Payment", value: "Payment" },
  { label: "Receipt", value: "Receipt" },
  { label: "Sales", value: "Sales" },
  { label: "Purchase", value: "Purchase" },
  { label: "Stock Transfer", value: "Stock Transfer" },
  { label: "Journal", value: "Journal" },
  { label: "Mixed", value: "Mixed" },
  { label: "Production", value: "Production" },
  { label: "Consumption", value: "Consumption" },
];

export function JournalTypeChips({ model }: { model: TransactionJournalModel }) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="type-chips">
      {TYPE_CHIPS.map((c) => {
        const active = model.voucherType === c.value || (c.value === "all" && model.voucherType === "all");
        return (
          <button
            key={c.value}
            onClick={() => model.setVoucherType(c.value)}
            data-testid={`chip-type-${c.value.replace(/\s+/g, "-").toLowerCase()}`}
            className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors
                    ${
                      active
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:text-foreground hover:border-foreground/40"
                    }`}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

export function JournalSummaryCards({ model }: { model: TransactionJournalModel }) {
  if (model.isLoading || Object.keys(model.summaryByCompany).length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {Object.entries(model.summaryByCompany).map(([id, row]) => (
        <Card
          key={id}
          className={`cursor-pointer hover-elevate ${model.selectedCos.includes(Number(id)) ? "ring-1 ring-primary" : ""}`}
          onClick={() => model.toggleCompanySelection(Number(id))}
          data-testid={`card-company-summary-${id}`}
        >
          <CardHeader className="pb-1 pt-3 px-3">
            <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-sm ${companyColor(Number(id))}`}>
              {row.name}
            </span>
          </CardHeader>
          <CardContent className="px-3 pb-3">
            <div className="text-lg font-semibold">{row.count.toLocaleString()}</div>
            <div className="text-xs text-muted-foreground">vouchers</div>
            {row.usdDr > 0 && (
              <div className="text-xs text-muted-foreground mt-1">
                USD Dr: {row.usdDr.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </div>
            )}
            {row.cfaDr > 0 && (
              <div className="text-xs text-muted-foreground">
                CFA Dr: {row.cfaDr.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
