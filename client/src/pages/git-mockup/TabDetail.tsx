import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, FileX, Search, CheckCircle2, XCircle, LayoutGrid, List, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt, fmtD, gitContainersUrl, parseNum, COMPANY_COLORS, getRealRowBg } from "./helpers";
import { WorkbookLegend, RealWorkbookBlock } from "./WorkbookBlock";
import type { GitContainersResponse, EnrichedContainerApi, CompanyViewMode } from "./types";

export function TabDetail() {
  const [companyMode, setCompanyMode] = useState<CompanyViewMode>("session");
  const [view, setView] = useState<"workbook" | "flat">("workbook");
  const [search, setSearch] = useState("");

  const queryUrl = gitContainersUrl({ allCompanies: companyMode === "all" });

  const { data, isLoading, isError, error } = useQuery<GitContainersResponse>({
    queryKey: [queryUrl],
    staleTime: 60_000,
    retry: 1,
  });

  const allContainers: EnrichedContainerApi[] = useMemo(() => (data?.containers ?? []), [data?.containers]);

  const filtered = useMemo(() => {
    if (!search) return allContainers;
    return allContainers.filter((r) =>
      searchAny(search, r.containerNumber, r.companyName, r.transporter, r.agent, r.numberPlate, r.trackingLocation)
    );
  }, [allContainers, search]);

  const totals = useMemo(
    () => ({
      amount: filtered.reduce((s, r) => s + parseNum(r.grandTotal), 0),
      fee: filtered.reduce((s, r) => s + parseNum(r.transportFee), 0),
      duty: filtered.reduce((s, r) => s + parseNum(r.dutyFee), 0),
    }),
    [filtered]
  );

  const companies = useMemo(() => {
    const seen = new Map<number, { id: number; name: string; rows: EnrichedContainerApi[] }>();
    for (const r of filtered) {
      if (!seen.has(r.companyId)) seen.set(r.companyId, { id: r.companyId, name: r.companyName, rows: [] });
      seen.get(r.companyId)!.rows.push(r);
    }
    return [...seen.values()];
  }, [filtered]);

  const modeSelector = (
    <div className="flex items-center gap-2 flex-wrap" data-testid="detail-mode-selector">
      <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-xs text-muted-foreground">View:</span>
      <Button
        size="sm"
        variant={companyMode === "session" ? "default" : "outline"}
        className="text-xs gap-1.5"
        onClick={() => setCompanyMode("session")}
        data-testid="button-detail-my-company"
      >
        My Company
      </Button>
      <Button
        size="sm"
        variant={companyMode === "all" ? "default" : "outline"}
        className="text-xs gap-1.5"
        onClick={() => setCompanyMode("all")}
        data-testid="button-detail-all-companies"
      >
        All Accessible Companies
      </Button>
    </div>
  );

  if (isLoading)
    return (
      <div className="space-y-3">
        {modeSelector}
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-32 w-full rounded-md" />
        ))}
      </div>
    );

  if (isError)
    return (
      <div className="space-y-3">
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

  return (
    <div className="space-y-3">
      {modeSelector}

      {allContainers.length === 0 ? (
        <div className="rounded-md border border-dashed px-6 py-10 text-center text-muted-foreground text-sm">
          <FileX className="h-8 w-8 mx-auto mb-2 opacity-40" />
          <div className="font-medium">No active containers found</div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search container, company, truck, agent…"
                className="pl-8"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="input-git-detail-search"
              />
            </div>
            <span className="text-xs text-muted-foreground">{filtered.length} rows</span>
            <div className="flex items-center gap-1 ml-auto">
              <Button
                size="sm"
                variant={view === "workbook" ? "default" : "outline"}
                className="gap-1.5"
                onClick={() => setView("workbook")}
                data-testid="button-view-workbook"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                Workbook
              </Button>
              <Button
                size="sm"
                variant={view === "flat" ? "default" : "outline"}
                className="gap-1.5"
                onClick={() => setView("flat")}
                data-testid="button-view-flat"
              >
                <List className="h-3.5 w-3.5" />
                Flat Table
              </Button>
            </div>
          </div>

          {view === "workbook" ? (
            <div className="space-y-4">
              <WorkbookLegend />
              {companies.map((company, idx) => {
                const color = COMPANY_COLORS[idx % COMPANY_COLORS.length];
                return (
                  <RealWorkbookBlock
                    key={company.id}
                    companyName={company.name}
                    rows={company.rows}
                    headerBg={color.bg}
                    headerText={color.text}
                  />
                );
              })}
              {filtered.length > 0 && (
                <div className="flex items-center justify-between px-3 py-1.5 rounded-md bg-zinc-800 dark:bg-zinc-700 text-white text-xs font-bold">
                  <span>TOTAL — ALL COMPANIES ({filtered.length} containers)</span>
                  <div className="flex gap-4">
                    <span>CTR COST: ${fmt(totals.amount, 2)}</span>
                    <span>TRANSPORT: ${fmt(totals.fee, 0)}</span>
                    <span>DUTY: ${fmt(totals.duty, 0)}</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <Table className="text-xs whitespace-nowrap">
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead>Container #</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>ETA</TableHead>
                    <TableHead>Truck #</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Border Date</TableHead>
                    <TableHead>Max Offload</TableHead>
                    <TableHead className="text-center">Docs Rcvd</TableHead>
                    <TableHead>Transporter</TableHead>
                    <TableHead className="text-right">Fee</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead className="text-right">Duty</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => (
                    <TableRow key={r.id} className={getRealRowBg(r)} data-testid={`row-git-${r.containerNumber}`}>
                      <TableCell className="font-mono font-semibold">{r.containerNumber}</TableCell>
                      <TableCell className="text-right font-medium">${fmt(parseNum(r.grandTotal), 2)}</TableCell>
                      <TableCell>{r.companyName}</TableCell>
                      <TableCell>{fmtD(r.eta)}</TableCell>
                      <TableCell className="font-mono">{r.numberPlate ?? "—"}</TableCell>
                      <TableCell>{r.trackingLocation ?? "—"}</TableCell>
                      <TableCell>{fmtD(r.borderDate)}</TableCell>
                      <TableCell className={cn(r.isOverdue ? "text-red-600 font-bold" : "")}>
                        {fmtD(r.maxOffloadDate)}
                        {r.daysDelayed ? (
                          <span className="ml-1 text-red-600 text-[10px]">+{r.daysDelayed}d</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-center">
                        {r.docReceived ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-600 mx-auto" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5 text-red-500 mx-auto" />
                        )}
                      </TableCell>
                      <TableCell>{r.transporter ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {parseNum(r.transportFee) > 0 ? `$${fmt(parseNum(r.transportFee), 0)}` : "—"}
                      </TableCell>
                      <TableCell>{r.agent ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {parseNum(r.dutyFee) > 0 ? `$${fmt(parseNum(r.dutyFee), 0)}` : "—"}
                      </TableCell>
                      <TableCell className="max-w-32 truncate text-muted-foreground">
                        {r.trackingDescription ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="border-t-2 font-semibold bg-muted/40">
                    <TableCell className="text-center">Totals ({filtered.length})</TableCell>
                    <TableCell className="text-right">${fmt(totals.amount, 2)}</TableCell>
                    <TableCell colSpan={8} />
                    <TableCell className="text-right">${fmt(totals.fee, 0)}</TableCell>
                    <TableCell />
                    <TableCell className="text-right">${fmt(totals.duty, 0)}</TableCell>
                    <TableCell colSpan={1} />
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
