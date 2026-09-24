import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, FileX, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt, gitContainersUrl, parseNum, COMPANY_COLORS } from "./helpers";
import type { GitContainersResponse, EnrichedContainerApi, CompanyViewMode } from "./types";

function _StatCard({
  label,
  value,
  sub,
  icon,
  accent,
  alert,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ReactNode;
  accent?: string;
  alert?: boolean;
}) {
  return (
    <Card className={cn("min-w-0", alert && "border-red-300 dark:border-red-800")}>
      <CardContent className="p-3 flex items-start gap-2.5">
        <div className={cn("p-1.5 rounded-md shrink-0", accent ?? "bg-muted")}>{icon}</div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground leading-tight truncate">{label}</p>
          <p className={cn("text-lg font-bold leading-tight", alert && "text-red-600")}>{value}</p>
          {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryGroupTable({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; count: number; cost: number; fee: number; duty: number }[];
}) {
  const total = {
    count: rows.reduce((s, r) => s + r.count, 0),
    cost: rows.reduce((s, r) => s + r.cost, 0),
    fee: rows.reduce((s, r) => s + r.fee, 0),
    duty: rows.reduce((s, r) => s + r.duty, 0),
  };
  return (
    <Card>
      <CardHeader className="pb-2 pt-3 px-3">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0 pb-1">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>{title.split(" by ")[1] ?? "Group"}</TableHead>
              <TableHead className="text-right">CTR</TableHead>
              <TableHead className="text-right">CTR Cost</TableHead>
              <TableHead className="text-right">Transport</TableHead>
              <TableHead className="text-right">Duty</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.label}>
                <TableCell className="font-medium">{r.label || "—"}</TableCell>
                <TableCell className="text-right">{r.count}</TableCell>
                <TableCell className="text-right">${fmt(r.cost, 0)}</TableCell>
                <TableCell className="text-right">{r.fee > 0 ? `$${fmt(r.fee, 0)}` : "—"}</TableCell>
                <TableCell className="text-right">{r.duty > 0 ? `$${fmt(r.duty, 0)}` : "—"}</TableCell>
              </TableRow>
            ))}
            <TableRow className="border-t-2 font-semibold bg-muted/30">
              <TableCell>Total</TableCell>
              <TableCell className="text-right">{total.count}</TableCell>
              <TableCell className="text-right">${fmt(total.cost, 0)}</TableCell>
              <TableCell className="text-right">{total.fee > 0 ? `$${fmt(total.fee, 0)}` : "—"}</TableCell>
              <TableCell className="text-right">{total.duty > 0 ? `$${fmt(total.duty, 0)}` : "—"}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function TabSummary() {
  const [companyMode, setCompanyMode] = useState<CompanyViewMode>("session");

  const queryUrl = gitContainersUrl({ allCompanies: companyMode === "all" });

  const { data, isLoading, isError, error } = useQuery<GitContainersResponse>({
    queryKey: [queryUrl],
    staleTime: 60_000,
    retry: 1,
  });

  const allContainers: EnrichedContainerApi[] = useMemo(() => data?.containers ?? [], [data?.containers]);

  const stats = useMemo(() => {
    const byStatus: Record<string, number> = {};
    for (const r of allContainers) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    return {
      total: allContainers.length,
      atSea: (byStatus["OTW"] ?? 0) + (byStatus["Sea"] ?? 0),
      atPort: byStatus["At Port"] ?? 0,
      leftDar: byStatus["Left Dar"] ?? 0,
      inTransit: (byStatus["At Border"] ?? 0) + (byStatus["In Transit"] ?? 0),
      arrived: byStatus["Arrived"] ?? 0,
      delayed: allContainers.filter((r) => r.daysDelayed !== null && r.daysDelayed > 0).length,
      overdue: allContainers.filter((r) => r.isOverdue).length,
      totalCost: allContainers.reduce((s, r) => s + parseNum(r.grandTotal), 0),
      totalFee: allContainers.reduce((s, r) => s + parseNum(r.transportFee), 0),
      totalDuty: allContainers.reduce((s, r) => s + parseNum(r.dutyFee), 0),
    };
  }, [allContainers]);

  const makeBreakdown = useCallback(
    (keyFn: (r: EnrichedContainerApi) => string) => {
      const map = new Map<string, { label: string; count: number; cost: number; fee: number; duty: number }>();
      for (const r of allContainers) {
        const k = keyFn(r);
        if (!map.has(k)) map.set(k, { label: k, count: 0, cost: 0, fee: 0, duty: 0 });
        const e = map.get(k)!;
        e.count++;
        e.cost += parseNum(r.grandTotal);
        e.fee += parseNum(r.transportFee);
        e.duty += parseNum(r.dutyFee);
      }
      return [...map.values()];
    },
    [allContainers]
  );

  const byCompany = useMemo(() => makeBreakdown((r) => r.companyName), [makeBreakdown]);
  const byTransport = useMemo(() => makeBreakdown((r) => r.transporter ?? "—"), [makeBreakdown]);
  const byAgent = useMemo(() => makeBreakdown((r) => r.agent ?? "—"), [makeBreakdown]);

  const modeSelector = (
    <div
      className="max-sm:grid max-sm:grid-cols-2 max-sm:[&>button]:h-auto max-sm:[&>button]:min-w-0 max-sm:[&>button]:whitespace-normal max-sm:[&>button]:py-1.5 flex items-center gap-2 flex-wrap"
      data-testid="summary-mode-selector"
    >
      <Building2 className="max-sm:hidden h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="max-sm:hidden text-xs text-muted-foreground">View:</span>
      <Button
        size="sm"
        variant={companyMode === "session" ? "default" : "outline"}
        className="text-xs gap-1.5"
        onClick={() => setCompanyMode("session")}
        data-testid="button-summary-my-company"
      >
        My Company
      </Button>
      <Button
        size="sm"
        variant={companyMode === "all" ? "default" : "outline"}
        className="text-xs gap-1.5"
        onClick={() => setCompanyMode("all")}
        data-testid="button-summary-all-companies"
      >
        All Accessible Companies
      </Button>
    </div>
  );

  if (isLoading)
    return (
      <div className="space-y-4">
        {modeSelector}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-11 gap-2">
          {Array.from({ length: 11 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-md" />
          ))}
        </div>
        <Skeleton className="h-40 w-full rounded-md" />
      </div>
    );

  if (isError)
    return (
      <div className="space-y-4">
        {modeSelector}
        <div className="rounded-md border border-red-200 bg-red-50 dark:bg-red-950/20 px-4 py-3 flex gap-3 items-start text-sm text-red-800 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Failed to load container data</div>
            <div className="text-xs mt-0.5">{(error as Error)?.message ?? "Network or server error."}</div>
          </div>
        </div>
      </div>
    );

  if (stats.total === 0)
    return (
      <div className="space-y-4">
        {modeSelector}
        <div className="rounded-md border border-dashed px-6 py-10 text-center text-muted-foreground text-sm">
          <FileX className="h-8 w-8 mx-auto mb-2 opacity-40" />
          <div className="font-medium">No active containers found</div>
        </div>
      </div>
    );

  return (
    <div className="space-y-4">
      {modeSelector}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border bg-muted/30 px-4 py-2.5 text-sm">
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">Active</span>
          <span className="font-bold">{stats.total}</span>
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">At Sea</span>
          <span className="font-semibold">{stats.atSea}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">At Port</span>
          <span className="font-semibold">{stats.atPort}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">Left Dar</span>
          <span className="font-semibold">{stats.leftDar}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">In Transit</span>
          <span className="font-semibold">{stats.inTransit}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">Arrived</span>
          <span className="font-semibold">{stats.arrived}</span>
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">Delayed</span>
          <span className={cn("font-bold", stats.delayed > 0 ? "text-red-600" : "")}>{stats.delayed}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">Overdue</span>
          <span className={cn("font-bold", stats.overdue > 0 ? "text-orange-600" : "")}>{stats.overdue}</span>
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">Cost</span>
          <span className="font-bold text-green-700 dark:text-green-400">${fmt(stats.totalCost, 0)}</span>
        </div>
      </div>

      <div className="rounded-md border overflow-hidden">
        <div className="bg-zinc-800 dark:bg-zinc-700 text-white px-3 py-1.5 text-xs font-bold tracking-wide">
          ACTIVE CONTAINER SUMMARY — BY COMPANY
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <tbody>
              {byCompany.map((c, idx) => {
                const color = COMPANY_COLORS[idx % COMPANY_COLORS.length];
                return (
                  <tr key={c.label} className="border-b last:border-b-0 hover:bg-muted/30">
                    <td className={cn("py-1 px-1 font-bold w-2", color.bg, color.text)} />
                    <td className="py-1 px-3 font-semibold">{c.label}</td>
                    <td className="py-1 px-3 text-right font-bold text-base">{c.count}</td>
                    <td className="py-1 px-3 text-right font-semibold">${fmt(c.cost, 2)}</td>
                  </tr>
                );
              })}
              <tr className="border-t-2 bg-muted/40 font-bold">
                <td />
                <td className="py-1 px-3">TOTAL ACTIVE</td>
                <td className="py-1 px-3 text-right text-base">{stats.total}</td>
                <td className="py-1 px-3 text-right">${fmt(stats.totalCost, 2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SummaryGroupTable title="Totals by Company" rows={byCompany} />
        <SummaryGroupTable title="Totals by Transporter" rows={byTransport} />
        <SummaryGroupTable title="Totals by Agent / Declarant" rows={byAgent} />
      </div>
    </div>
  );
}
