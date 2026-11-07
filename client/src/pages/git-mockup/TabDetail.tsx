import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertTriangle,
  FileX,
  Search,
  CheckCircle2,
  XCircle,
  LayoutGrid,
  List,
  Building2,
  Boxes,
  Truck,
  Anchor,
  FileCheck2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt, fmtD, gitContainersUrl, parseNum, COMPANY_COLORS, getRealRowBg } from "./helpers";
import { WorkbookLegend, RealWorkbookBlock } from "./WorkbookBlock";
import type { GitContainersResponse, EnrichedContainerApi, CompanyViewMode } from "./types";
import { isExistingRecordReadOnlyRole } from "@shared/createOnlyRolePolicy";

export function TabDetail() {
  const { data: viewer } = useQuery(authenticatedUserQueryOptions());
  const role = viewer?.currentRole ?? viewer?.role;
  const isTester = role === "ERP Tester";
  const isViewer = isExistingRecordReadOnlyRole(role);
  const restrictedViewer = isTester || isViewer;
  const [companyMode, setCompanyMode] = useState<CompanyViewMode>("session");
  const [view, setView] = useState<"workbook" | "flat">("workbook");
  const [search, setSearch] = useState("");

  const queryUrl = gitContainersUrl({ allCompanies: companyMode === "all" });

  const { data, isLoading, isError, error } = useQuery<GitContainersResponse>({
    queryKey: [queryUrl],
    staleTime: 60_000,
    retry: 1,
  });

  const allContainers: EnrichedContainerApi[] = useMemo(() => data?.containers ?? [], [data?.containers]);

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

  // Derive the overview from the exact same filtered, company-scoped rows as the workbook.
  // Never show illustrative counts from the design mockup in production.
  const statusSummary = useMemo(
    () => ({
      inTransit: filtered.filter((r) => ["OTW", "Sea", "Left Dar", "At Border", "In Transit"].includes(r.status))
        .length,
      portDocsPending: filtered.filter((r) => r.status === "At Port" && !r.docReceived).length,
      docsReceived: filtered.filter((r) => !!r.docReceived).length,
    }),
    [filtered]
  );

  const summaryCards = [
    {
      label: "Total Containers",
      value: filtered.length,
      icon: Boxes,
      style:
        "border-violet-300/50 bg-gradient-to-br from-violet-100 to-violet-50 dark:border-violet-500/40 dark:from-violet-500/25 dark:to-violet-950/20",
      iconStyle: "bg-violet-500/15 text-violet-700 dark:bg-violet-400/20 dark:text-violet-200",
    },
    {
      label: "In Transit",
      value: statusSummary.inTransit,
      icon: Truck,
      style:
        "border-emerald-300/60 bg-gradient-to-br from-emerald-50 to-teal-50 dark:border-emerald-500/35 dark:from-emerald-500/20 dark:to-teal-950/20",
      iconStyle: "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
    },
    {
      label: "At Port / Docs Missing",
      value: statusSummary.portDocsPending,
      icon: Anchor,
      style:
        "border-amber-300/60 bg-gradient-to-br from-amber-50 to-orange-50 dark:border-amber-500/35 dark:from-amber-500/20 dark:to-orange-950/20",
      iconStyle: "bg-amber-500/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
    },
    {
      label: "Docs Received",
      value: statusSummary.docsReceived,
      icon: FileCheck2,
      style:
        "border-sky-300/60 bg-gradient-to-br from-blue-50 to-sky-50 dark:border-blue-500/35 dark:from-blue-500/20 dark:to-sky-950/20",
      iconStyle: "bg-sky-500/15 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
    },
  ];

  const modeSelector = (
    <div
      className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card/80 p-2 shadow-sm max-sm:grid max-sm:grid-cols-2 max-sm:[&>button]:h-auto max-sm:[&>button]:min-w-0 max-sm:[&>button]:whitespace-normal max-sm:[&>button]:py-2"
      data-testid="detail-mode-selector"
    >
      <Building2 className="max-sm:hidden h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="max-sm:hidden text-xs text-muted-foreground">View:</span>
      <Button
        size="sm"
        variant={companyMode === "session" ? "default" : "outline"}
        className={cn(
          "gap-1.5 rounded-lg text-xs font-semibold",
          companyMode === "session" &&
            "bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white hover:from-violet-700 hover:to-fuchsia-700"
        )}
        onClick={() => setCompanyMode("session")}
        data-testid="button-detail-my-company"
      >
        My Company
      </Button>
      {!restrictedViewer && (
        <Button
          size="sm"
          variant={companyMode === "all" ? "default" : "outline"}
          className={cn(
            "gap-1.5 rounded-lg text-xs font-semibold",
            companyMode === "all" &&
              "bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white hover:from-violet-700 hover:to-fuchsia-700"
          )}
          onClick={() => setCompanyMode("all")}
          data-testid="button-detail-all-companies"
        >
          All Accessible Companies
        </Button>
      )}
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
    <div className="space-y-4">
      {modeSelector}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Container tracking summary">
        {summaryCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.label}
              className={cn(
                "flex min-h-24 items-center gap-3 rounded-2xl border p-3 shadow-sm transition-shadow hover:shadow-md sm:p-4",
                card.style
              )}
            >
              <div
                className={cn(
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl sm:h-12 sm:w-12",
                  card.iconStyle
                )}
              >
                <Icon className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground/75">{card.label}</div>
                <div className="mt-0.5 text-2xl font-bold tracking-tight tabular-nums">
                  {card.value.toLocaleString("en-US")}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {allContainers.length === 0 ? (
        <div className="rounded-md border border-dashed px-6 py-10 text-center text-muted-foreground text-sm">
          <FileX className="h-8 w-8 mx-auto mb-2 opacity-40" />
          <div className="font-medium">No active containers found</div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card/80 p-3 shadow-sm">
            <div className="relative flex-1 max-w-sm max-sm:basis-full max-sm:max-w-none">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search container, company, truck, agent…"
                className="h-9 rounded-lg border-border/70 bg-background/80 pl-8 shadow-inner shadow-black/5"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="input-git-detail-search"
              />
            </div>
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold tabular-nums text-muted-foreground">
              {filtered.length} rows
            </span>
            <div className="ml-auto flex items-center gap-1 rounded-xl bg-muted/65 p-1">
              <Button
                size="sm"
                variant={view === "workbook" ? "default" : "outline"}
                className={cn(
                  "gap-1.5 rounded-lg text-xs",
                  view === "workbook" &&
                    "bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white hover:from-violet-700 hover:to-fuchsia-700"
                )}
                onClick={() => setView("workbook")}
                data-testid="button-view-workbook"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                Workbook
              </Button>
              <Button
                size="sm"
                variant={view === "flat" ? "default" : "outline"}
                className={cn(
                  "gap-1.5 rounded-lg text-xs",
                  view === "flat" &&
                    "bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white hover:from-violet-700 hover:to-fuchsia-700"
                )}
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
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-violet-300/40 bg-gradient-to-r from-violet-600 to-indigo-700 px-4 py-3 text-xs font-bold text-white shadow-md shadow-violet-500/10">
                  <span>TOTAL — ALL COMPANIES ({filtered.length} containers)</span>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <span>CTR COST: ${fmt(totals.amount, 2)}</span>
                    <span>TRANSPORT: ${fmt(totals.fee, 0)}</span>
                    <span>DUTY: ${fmt(totals.duty, 0)}</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-border/70 bg-card/85 shadow-sm">
              <Table
                className="text-xs whitespace-nowrap [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide"
                mobileLayout="cards"
              >
                <TableHeader>
                  <TableRow className="bg-muted/70">
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
                    <TableRow
                      key={r.id}
                      className={cn("transition-colors hover:bg-violet-500/10", getRealRowBg(r))}
                      data-testid={`row-git-${r.containerNumber}`}
                    >
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
                          <span className="ml-1 text-red-600 text-[11px]">+{r.daysDelayed}d</span>
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
