import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  Building2,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Download,
  Info,
  RefreshCw,
  Scale,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

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

interface GroupNetPositionData {
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
    mode: "already-excluded";
    additionalElimination: number;
    note: string;
  };
}

function todayStr() {
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
      b.reduce((sum, line) => sum + Math.abs(line.value), 0) -
      a.reduce((sum, line) => sum + Math.abs(line.value), 0)
  );
  const sideClass = side === "have" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";

  return (
    <div className="rounded-xl border border-border/70 overflow-hidden bg-card/50">
      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-muted/30 border-b">
        <div className="flex items-center gap-2">
          {side === "have" ? <ArrowUpRight className="h-4 w-4 text-emerald-600" /> : <ArrowDownRight className="h-4 w-4 text-rose-600" />}
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
                  <div key={`${line.label}-${index}`} className="flex items-start justify-between gap-4 px-3 py-2 text-sm">
                    <span className="min-w-0 break-words">{line.label}</span>
                    <span className={`shrink-0 font-mono tabular-nums ${line.value < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>
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

function CompanyCard({ company, formatAmount }: { company: GroupCompanyPosition; formatAmount: (amount: number) => string }) {
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
                <Badge variant="outline" className="text-[10px]">{company.companyCode}</Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{company.companyType.replace(/_/g, " ")}</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 sm:gap-6 text-right lg:min-w-[500px]">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">What We Have</div>
              <div className="font-mono tabular-nums text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                {formatAmount(company.forUsTotal)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">What We Owe</div>
              <div className="font-mono tabular-nums text-sm font-semibold text-rose-600 dark:text-rose-400">
                {formatAmount(company.onUsTotal)}
              </div>
            </div>
            <div className="flex items-start justify-end gap-2">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Net Position</div>
                <div className={`font-mono tabular-nums text-sm font-bold ${positive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                  {formatAmount(company.netPosition)}
                </div>
              </div>
              {open ? <ChevronDown className="h-4 w-4 text-muted-foreground mt-3" /> : <ChevronRight className="h-4 w-4 text-muted-foreground mt-3" />}
            </div>
          </div>
        </div>
      </button>

      {open && (
        <CardContent className="pt-0 pb-5 px-4 sm:px-5">
          {Math.abs(company.netAdjustment) >= 0.01 && (
            <div className="mb-3 rounded-lg border border-violet-500/20 bg-violet-500/[0.04] px-3 py-2 text-xs flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Net Position adjustment from this company's existing accounting rules</span>
              <span className="font-mono font-semibold tabular-nums">{formatAmount(company.netAdjustment)}</span>
            </div>
          )}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <CompanySide title="What We Have" lines={company.forUsLines} total={company.forUsTotal} side="have" formatAmount={formatAmount} />
            <CompanySide title="What We Owe" lines={company.onUsLines} total={company.onUsTotal} side="owe" formatAmount={formatAmount} />
          </div>
        </CardContent>
      )}
    </Card>
  );
}

export function GroupNetPositionPage({ onBack }: { onBack: () => void }) {
  const { formatHistoricalBaseAmount } = useCurrencyContext();
  const [asOfDate, setAsOfDate] = useState(todayStr());

  const formatAmount = (amount: number) => {
    if (amount < 0) return `-${formatHistoricalBaseAmount(Math.abs(amount))}`;
    return formatHistoricalBaseAmount(amount);
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery<GroupNetPositionData>({
    queryKey: ["/api/stats/group-net-position", asOfDate],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/stats/group-net-position?toDate=${encodeURIComponent(asOfDate)}`);
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
  });

  const exportExcel = () => {
    window.open(`/api/stats/group-net-position-excel?toDate=${encodeURIComponent(asOfDate)}`, "_blank");
  };

  return (
    <div className="space-y-5 max-w-[1500px] mx-auto" data-testid="group-net-position-page">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <Button variant="outline" size="icon" onClick={onBack} aria-label="Back to System Tools">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">Group Net Position</h2>
              <Badge variant="secondary">Properties excluded</Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Combined What We Have, What We Owe, and Net Position across all active non-Properties companies.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <CalendarDays className="h-3.5 w-3.5" /> As of date
            </label>
            <Input
              type="date"
              value={asOfDate}
              max={todayStr()}
              onChange={(event) => setAsOfDate(event.target.value || todayStr())}
              className="w-[170px]"
              data-testid="input-group-net-position-date"
            />
          </div>
          <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button onClick={exportExcel} disabled={!data}>
            <Download className="h-4 w-4 mr-2" /> Export Excel
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[0, 1, 2].map((key) => <Skeleton key={key} className="h-32 rounded-xl" />)}
          </div>
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : error || !data ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-medium">Group Net Position could not be loaded.</p>
            <p className="text-sm text-muted-foreground mt-1">{error instanceof Error ? error.message : "Unknown error"}</p>
            <Button className="mt-4" variant="outline" onClick={() => refetch()}>Try Again</Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="border-emerald-500/20">
              <CardContent className="p-5">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Total What We Have</p>
                    <p className="text-2xl font-bold font-mono tabular-nums text-emerald-600 dark:text-emerald-400 mt-2">
                      {formatAmount(data.totals.forUsTotal)}
                    </p>
                  </div>
                  <div className="h-10 w-10 rounded-xl bg-emerald-500/10 text-emerald-600 flex items-center justify-center">
                    <ArrowUpRight className="h-5 w-5" />
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="border-rose-500/20">
              <CardContent className="p-5">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Total What We Owe</p>
                    <p className="text-2xl font-bold font-mono tabular-nums text-rose-600 dark:text-rose-400 mt-2">
                      {formatAmount(data.totals.onUsTotal)}
                    </p>
                  </div>
                  <div className="h-10 w-10 rounded-xl bg-rose-500/10 text-rose-600 flex items-center justify-center">
                    <ArrowDownRight className="h-5 w-5" />
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className={data.totals.netPosition >= 0 ? "border-emerald-500/20" : "border-rose-500/20"}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Group Net Position</p>
                    <p className={`text-2xl font-bold font-mono tabular-nums mt-2 ${data.totals.netPosition >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                      {formatAmount(data.totals.netPosition)}
                    </p>
                    {Math.abs(data.totals.netAdjustments) >= 0.01 && (
                      <p className="text-[11px] text-muted-foreground mt-1">
                        Includes {formatAmount(data.totals.netAdjustments)} in existing Net Position adjustments.
                      </p>
                    )}
                  </div>
                  <div className="h-10 w-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                    <Scale className="h-5 w-5" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <CardTitle className="text-base">Company Overview</CardTitle>
                  <p className="text-xs text-muted-foreground mt-1">{data.companyCount} companies included · as of {data.asOfDate}</p>
                </div>
                <Badge variant="outline">Group total: {formatAmount(data.totals.netPosition)}</Badge>
              </div>
            </CardHeader>
            <CardContent className="pt-0 overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Company</th>
                    <th className="py-2 px-3 text-right font-medium">What We Have</th>
                    <th className="py-2 px-3 text-right font-medium">What We Owe</th>
                    <th className="py-2 px-3 text-right font-medium">Adjustments</th>
                    <th className="py-2 pl-3 text-right font-medium">Net Position</th>
                  </tr>
                </thead>
                <tbody>
                  {data.companies.map((company) => (
                    <tr key={company.companyId} className="border-b border-border/50 last:border-0">
                      <td className="py-3 pr-4">
                        <div className="font-medium">{company.companyName}</div>
                        <div className="text-xs text-muted-foreground">{company.companyCode}</div>
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400">{formatAmount(company.forUsTotal)}</td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-rose-600 dark:text-rose-400">{formatAmount(company.onUsTotal)}</td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums">{formatAmount(company.netAdjustment)}</td>
                      <td className={`py-3 pl-3 text-right font-mono tabular-nums font-semibold ${company.netPosition >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                        {formatAmount(company.netPosition)}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-muted/30 font-semibold">
                    <td className="py-3 pr-4">GROUP TOTAL</td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums">{formatAmount(data.totals.forUsTotal)}</td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums">{formatAmount(data.totals.onUsTotal)}</td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums">{formatAmount(data.totals.netAdjustments)}</td>
                    <td className="py-3 pl-3 text-right font-mono tabular-nums">{formatAmount(data.totals.netPosition)}</td>
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>

          <div className="rounded-xl border border-blue-500/20 bg-blue-500/[0.04] px-4 py-3 flex items-start gap-3 text-sm">
            <Info className="h-4 w-4 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Intercompany treatment</p>
              <p className="text-muted-foreground text-xs mt-0.5">{data.intercompany.note}</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold">Company Breakdown</h3>
              <p className="text-sm text-muted-foreground">Every company's What We Have and What We Owe is shown directly from its existing Net Position calculation.</p>
            </div>
            {data.companies.map((company) => (
              <CompanyCard key={company.companyId} company={company} formatAmount={formatAmount} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
