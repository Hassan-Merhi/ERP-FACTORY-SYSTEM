/**
 * Compact transaction-type filters and clickable per-company summaries.
 * Selection and amounts are sourced from the original journal model.
 */
import { Building2, Check, Layers3 } from "lucide-react";
import { companyColor } from "../utils";
import type { TransactionJournalModel } from "../useTransactionJournalModel";

const TYPE_CHIPS = [
  { label: "All", value: "all" },
  { label: "Offload", value: "Offload" },
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

const COMPANY_STYLES = [
  "border-violet-200/80 bg-gradient-to-br from-violet-50 via-white to-purple-50 text-violet-700 dark:border-violet-400/25 dark:from-violet-950/70 dark:via-[#26183c] dark:to-[#1d1a39] dark:text-violet-200",
  "border-emerald-200/80 bg-gradient-to-br from-emerald-50 via-white to-teal-50 text-emerald-700 dark:border-emerald-400/25 dark:from-emerald-950/70 dark:via-[#133b36] dark:to-[#142e40] dark:text-emerald-200",
  "border-fuchsia-200/80 bg-gradient-to-br from-fuchsia-50 via-white to-purple-50 text-fuchsia-700 dark:border-fuchsia-400/25 dark:from-fuchsia-950/65 dark:via-[#411e42] dark:to-[#23193b] dark:text-fuchsia-200",
] as const;

export function JournalTypeChips({ model }: { model: TransactionJournalModel }) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]" data-testid="type-chips" aria-label="Filter by transaction type">
      {TYPE_CHIPS.map((chip) => {
        const active = model.voucherType === chip.value;
        return (
          <button key={chip.value} type="button" aria-pressed={active}
            onClick={() => model.setVoucherType(chip.value)}
            data-testid={`chip-type-${chip.value.replace(/\s+/g, "-").toLowerCase()}`}
            className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2
              ${active
                ? "border-violet-600 bg-gradient-to-r from-violet-600 to-purple-600 text-white shadow-md shadow-violet-500/25 dark:border-violet-400/60"
                : "border-slate-200 bg-white/85 text-slate-600 hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700 dark:border-white/15 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:border-violet-400/40 dark:hover:bg-violet-400/10 dark:hover:text-white"}`}
          >{chip.label}</button>
        );
      })}
    </div>
  );
}

export function JournalSummaryCards({ model }: { model: TransactionJournalModel }) {
  if (model.isLoading || Object.keys(model.summaryByCompany).length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Company transaction summaries">
      {Object.entries(model.summaryByCompany).map(([id, row], index) => {
        const selected = model.selectedCos.includes(Number(id));
        return (
          <button key={id} type="button" onClick={() => model.toggleCompanySelection(Number(id))}
            aria-pressed={selected} aria-label={`Filter transactions for ${row.name}`}
            data-testid={`card-company-summary-${id}`}
            className={`relative flex min-h-[106px] w-full items-center gap-3 overflow-hidden rounded-2xl border p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 ${COMPANY_STYLES[index % COMPANY_STYLES.length]} ${selected ? "ring-2 ring-violet-500 ring-offset-2 dark:ring-offset-slate-950" : ""}`}>
            <div aria-hidden="true" className="absolute -bottom-14 -left-5 h-28 w-40 rounded-full bg-current opacity-[0.06] blur-2xl" />
            <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-current/10">
              <Building2 className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="relative min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className={`max-w-full truncate text-xs font-bold tracking-wide ${companyColor(Number(id))} rounded-md px-1.5 py-0.5`}>{row.name}</span>
                {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-600 dark:text-slate-300">
                {row.usdDr > 0 && <span>USD Dr: <strong className="font-semibold tabular-nums">{row.usdDr.toLocaleString("en-US", { maximumFractionDigits: 0 })}</strong></span>}
                {row.cfaDr > 0 && <span>CFA Dr: <strong className="font-semibold tabular-nums">{row.cfaDr.toLocaleString("en-US", { maximumFractionDigits: 0 })}</strong></span>}
                {row.usdDr <= 0 && row.cfaDr <= 0 && <span>Company activity</span>}
              </div>
            </div>
            <div className="relative shrink-0 border-l border-current/20 pl-3 text-center">
              <div className="text-xl font-extrabold leading-none tabular-nums">{row.count.toLocaleString()}</div>
              <div className="mt-1 text-[10px] font-medium text-slate-600 dark:text-slate-300">Transactions</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
