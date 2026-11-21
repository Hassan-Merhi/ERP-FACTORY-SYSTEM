// Extracted from ./GroupNetPositionPage.tsx
import { useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Building2, ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

interface GroupLineItem {
  label: string;
  value: number;
  category: string;
  side: "forUs" | "onUs";
}

interface GroupCompanyPosition {
  companyId: number;
  companyCode: string;
  companyName: string;
  companyType: string;
  forUsTotal: number;
  onUsTotal: number;
  sideNetPosition: number;
  netAdjustment: number;
  netPosition: number;
  netPositionLabel: string;
  forUsLines: GroupLineItem[];
  onUsLines: GroupLineItem[];
}

export interface GroupNetPositionData {
  asOfDate: string;
  companyCount: number;
  excludedCompanyTypes: string[];
  companies: GroupCompanyPosition[];
  totals: {
    forUsTotal: number;
    onUsTotal: number;
    sideNetPosition: number;
    netAdjustments: number;
    netPosition: number;
  };
  intercompany: {
    mode: "paired-elimination";
    additionalElimination: number;
    /** Unmatched or mismatched intercompany amounts, part of the group totals (wave 13). */
    differences?: GroupLineItem[];
    note: string;
  };
}

export function todayStr() {
  return new Date().toLocaleDateString("en-CA");
}

function groupByCategory(lines: GroupLineItem[]) {
  return lines.reduce<Record<string, GroupLineItem[]>>((groups, line) => {
    const key = line.category || "Other";
    if (!groups[key]) groups[key] = [];
    groups[key].push(line);
    return groups;
  }, {});
}

function CompanySide({
  title,
  lines,
  total,
  side,
  formatAmount,
}: {
  title: string;
  lines: GroupLineItem[];
  total: number;
  side: "have" | "owe";
  formatAmount: (amount: number) => string;
}) {
  const grouped = useMemo(() => groupByCategory(lines), [lines]);
  const entries = Object.entries(grouped).sort(
    ([, a], [, b]) =>
      b.reduce((sum, line) => sum + Math.abs(line.value), 0) - a.reduce((sum, line) => sum + Math.abs(line.value), 0)
  );
  const sideClass = side === "have" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";

  return (
    <div className="rounded-xl border border-border/70 overflow-hidden bg-card/50">
      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-muted/30 border-b">
        <div className="flex items-center gap-2">
          {side === "have" ? (
            <ArrowUpRight className="h-4 w-4 text-emerald-600" />
          ) : (
            <ArrowDownRight className="h-4 w-4 text-rose-600" />
          )}
          <span className="font-semibold text-sm">{title}</span>
        </div>
        <span className={`font-mono font-bold tabular-nums ${sideClass}`}>{formatAmount(total)}</span>
      </div>
      <div className="p-3 space-y-3">
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No balances on this side.</p>
        ) : (
          entries.map(([category, categoryLines]) => (
            <div key={category} className="rounded-lg border border-border/60 overflow-hidden">
              <div className="flex items-center justify-between gap-3 bg-muted/20 px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{category}</span>
                <span className="text-xs font-mono tabular-nums text-muted-foreground">
                  {formatAmount(categoryLines.reduce((sum, line) => sum + line.value, 0))}
                </span>
              </div>
              <div className="divide-y divide-border/50">
                {categoryLines.map((line, index) => (
                  <div
                    key={`${line.label}-${index}`}
                    className="flex items-start justify-between gap-4 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 wrap-break-word">{line.label}</span>
                    <span
                      className={`shrink-0 font-mono tabular-nums ${line.value < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}
                    >
                      {formatAmount(line.value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function CompanyCard({
  company,
  formatAmount,
}: {
  company: GroupCompanyPosition;
  formatAmount: (amount: number) => string;
}) {
  const [open, setOpen] = useState(true);
  const positive = company.netPosition >= 0;

  return (
    <Card className="overflow-hidden" data-testid={`group-net-company-${company.companyId}`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full text-left px-4 sm:px-5 py-4 hover:bg-muted/20 transition-colors"
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Building2 className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold truncate">{company.companyName}</h3>
                <Badge variant="outline" className="text-[11px]">
                  {company.companyCode}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{company.companyType.replace(/_/g, " ")}</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 sm:gap-6 text-right lg:min-w-[500px]">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">What We Have</div>
              <div className="font-mono tabular-nums text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                {formatAmount(company.forUsTotal)}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">What We Owe</div>
              <div className="font-mono tabular-nums text-sm font-semibold text-rose-600 dark:text-rose-400">
                {formatAmount(company.onUsTotal)}
              </div>
            </div>
            <div className="flex items-start justify-end gap-2">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Net Position</div>
                <div
                  className={`font-mono tabular-nums text-sm font-bold ${positive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                >
                  {formatAmount(company.netPosition)}
                </div>
              </div>
              {open ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground mt-3" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground mt-3" />
              )}
            </div>
          </div>
        </div>
      </button>

      {open && (
        <CardContent className="pt-0 pb-5 px-4 sm:px-5">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <CompanySide
              title="What We Have"
              lines={company.forUsLines}
              total={company.forUsTotal}
              side="have"
              formatAmount={formatAmount}
            />
            <CompanySide
              title="What We Owe"
              lines={company.onUsLines}
              total={company.onUsTotal}
              side="owe"
              formatAmount={formatAmount}
            />
          </div>
        </CardContent>
      )}
    </Card>
  );
}
